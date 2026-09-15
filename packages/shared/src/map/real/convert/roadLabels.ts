import { distance, polylineLength } from "../../layout/geometry";
import type { RoadLabel, Vec2Tuple } from "../../types";
import { clipPolylineToSquare, simplifyPolyline } from "./geometry";
import { isPoliticalName, normalizeName } from "./names";
import { ROAD_CLIP, roadClassOf } from "./roads";
import type { LineFeature } from "./types";

/** Label rank by OSM highway class; other named road classes rank 3. */
const RANKS: Readonly<Record<string, 0 | 1 | 2>> = { trunk: 0, primary: 0, secondary: 1, tertiary: 2 };
/** Shortest merged length inside the map that earns a label, by rank, m: big roads always, others when long. */
export const ROAD_LABEL_MIN_LENGTH = [100, 100, 200, 300] as const;
/** Label lines are simplified to this, m (they only place text). */
const SIMPLIFY = 2;
/** Alleys ("Hẻm 181/7 …", "Ngõ 12") and anything carrying a house number never label the map. */
const ALLEY = /^(?:hem|ngo|ngach|kiet) /;
const HOUSE_NUMBER = /\d+[a-z]?\s*\/\s*\d+/i;

export interface RoadLabelReport {
  /** Labeled road names, in label priority order. */
  readonly labeled: readonly string[];
  /** Roads long or big enough for a label that got none because their name is political. */
  readonly political: readonly string[];
}

/**
 * Road names for the map screen: named OSM highways (the classes kept as roads, links and tunnels skipped), same-name
 * ways joined into chains, clipped to the road edge and simplified. A name qualifies by its best class and total length
 * (`ROAD_LABEL_MIN_LENGTH`). Political names (`isPoliticalName`) and alleys get no label. Labels only: no road geometry
 * changes.
 */
export function convertRoadLabels(lines: readonly LineFeature[], urban = false): { labels: RoadLabel[]; report: RoadLabelReport } {
  interface Group {
    /** Display spellings with their length, so the most used one wins ("Bạch đằng" vs "Bạch Đằng"). */
    readonly spellings: Map<string, number>;
    rank: 0 | 1 | 2 | 3;
    readonly pieces: Vec2Tuple[][];
  }
  const groups = new Map<string, Group>();
  for (const line of lines) {
    const name = line.tags.name?.replace(/\s+/g, " ").trim();
    const highway = line.tags.highway;
    if (!name || !highway || highway.endsWith("_link") || !roadClassOf(line.tags, urban)) continue;
    const key = normalizeName(name);
    if (!key || ALLEY.test(key) || HOUSE_NUMBER.test(name)) continue;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { spellings: new Map(), rank: 3, pieces: [] }));
    group.spellings.set(name, (group.spellings.get(name) ?? 0) + polylineLength(line.points));
    group.rank = Math.min(group.rank, RANKS[highway] ?? 3) as 0 | 1 | 2 | 3;
    group.pieces.push([...line.points]);
  }

  const labels: RoadLabel[] = [];
  const political: { name: string; rank: number; length: number }[] = [];
  for (const group of groups.values()) {
    const name = [...group.spellings].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    const chains: Vec2Tuple[][] = [];
    for (const chain of joinChains(group.pieces)) {
      for (const clipped of clipPolylineToSquare(chain, ROAD_CLIP)) {
        const points = simplifyPolyline(dedupe(clipped), SIMPLIFY).map((p): Vec2Tuple => [round1(p[0]), round1(p[1])]);
        if (points.length >= 2 && polylineLength(points) >= 5) chains.push(points);
      }
    }
    const length = Math.round(chains.reduce((sum, chain) => sum + polylineLength(chain), 0));
    if (length < ROAD_LABEL_MIN_LENGTH[group.rank]) continue;
    if (isPoliticalName(name)) political.push({ name, rank: group.rank, length });
    else labels.push({ name, rank: group.rank, length, lines: chains });
  }
  const order = (a: { name: string; rank: number; length: number }, b: { name: string; rank: number; length: number }) => a.rank - b.rank || b.length - a.length || (a.name < b.name ? -1 : 1);
  labels.sort(order);
  political.sort(order);
  return { labels, report: { labeled: labels.map((l) => l.name), political: political.map((p) => p.name) } };
}

/** Joins pieces that meet end to end (within 0.5 m), in input order. */
export function joinChains(pieces: readonly (readonly Vec2Tuple[])[]): Vec2Tuple[][] {
  const near = (a: Vec2Tuple, b: Vec2Tuple) => distance(a[0], a[1], b[0], b[1]) <= 0.5;
  const used = new Uint8Array(pieces.length);
  const chains: Vec2Tuple[][] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let points = [...pieces[i]!];
    for (let grew = true; grew; ) {
      grew = false;
      for (let j = 0; j < pieces.length; j++) {
        if (used[j]) continue;
        const other = pieces[j]!;
        const head = points[0]!;
        const tail = points[points.length - 1]!;
        const oHead = other[0]!;
        const oTail = other[other.length - 1]!;
        if (near(tail, oHead)) points = [...points, ...other.slice(1)];
        else if (near(tail, oTail)) points = [...points, ...[...other].reverse().slice(1)];
        else if (near(head, oTail)) points = [...other.slice(0, -1), ...points];
        else if (near(head, oHead)) points = [...[...other].reverse().slice(0, -1), ...points];
        else continue;
        used[j] = 1;
        grew = true;
      }
    }
    chains.push(points);
  }
  return chains;
}

function dedupe(points: readonly Vec2Tuple[]): Vec2Tuple[] {
  const out: Vec2Tuple[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || distance(last[0], last[1], p[0], p[1]) > 0.05) out.push(p);
  }
  return out;
}

function round1(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}
