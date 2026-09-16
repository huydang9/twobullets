import type { Terrain } from "../terrain/terrain";
import type { MapData } from "../types";
import { rectCorners } from "./geometry";
import type { MapLayout } from "./mapLayout";
import { getMapProp } from "./props";
import { mapPaths } from "./roads";
import { INSTANCE_STRIDE } from "./scatter";

export interface OverviewOptions {
  /** Contour interval, m. */
  readonly contourStep?: number;
  /** Terrain sampling step for contours, m. */
  readonly contourGrid?: number;
}

const COLORS = {
  background: "#dfe6cf",
  contour: "#9aa585",
  contourMajor: "#7c8768",
  asphalt: "#4a4a4a",
  dirt: "#b99b6b",
  pad: "#cdbb94",
  building: "#8c3b2e",
  tree: "#3f6b3a",
  bush: "#7c9c5a",
  rock: "#8b8b86",
  prop: "#5b4a36",
  poi: "#1d2a44",
  spawn: "#d0342c",
  boundary: "#b3261e",
} as const;

/**
 * Top-down SVG of a map: contours, pads, roads, forests and other scatter, buildings, fences, POI labels and spawns.
 * One SVG unit is one meter; north is up.
 */
export function renderMapOverviewSvg(map: MapData, terrain: Terrain, layout: MapLayout, options: OverviewOptions = {}): string {
  const half = map.terrain.playableHalfExtent;
  const margin = 30;
  const extent = half + margin;
  // SVG y grows downward: world z maps to -z.
  const X = (x: number) => fmt(x);
  const Y = (z: number) => fmt(-z);
  const out: string[] = [];
  const size = extent * 2;
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-extent} ${-extent} ${size} ${size}" width="${size}" height="${size}" font-family="system-ui, sans-serif">`,
    `<title>${escape(map.name)} overview</title>`,
    `<rect x="${-extent}" y="${-extent}" width="${size}" height="${size}" fill="${COLORS.background}"/>`,
  );

  // Contours.
  const step = options.contourStep ?? 5;
  const grid = options.contourGrid ?? 8;
  const levels = new Map<number, string[]>();
  for (const [level, segment] of contourSegments(terrain, -half, half, grid, step)) {
    let list = levels.get(level);
    if (!list) levels.set(level, (list = []));
    list.push(segment);
  }
  for (const [level, segments] of [...levels].sort((a, b) => a[0] - b[0])) {
    const major = level % (step * 4) === 0;
    out.push(`<path d="${segments.join("")}" fill="none" stroke="${major ? COLORS.contourMajor : COLORS.contour}" stroke-width="${major ? 0.9 : 0.5}"/>`);
  }

  // Pads.
  for (const region of map.flatten) {
    if (region.shape === "circle") out.push(`<circle cx="${X(region.center[0])}" cy="${Y(region.center[1])}" r="${fmt(region.radius)}" fill="${COLORS.pad}" fill-opacity="0.45"/>`);
    if (region.shape === "rect") {
      const corners = rectCorners({ center: region.center, halfExtents: region.halfExtents, yaw: region.yaw ?? 0 });
      out.push(`<polygon points="${corners.map(([x, z]) => `${X(x)},${Y(z)}`).join(" ")}" fill="${COLORS.pad}" fill-opacity="${region.surface ? 0.75 : 0.45}"/>`);
    }
  }

  // Roads.
  for (const path of mapPaths(map)) {
    const d = path.points.map(([x, z], i) => `${i === 0 ? "M" : "L"}${X(x)} ${Y(z)}`).join("");
    out.push(`<path d="${d}" fill="none" stroke="${path.kind === "asphalt" ? COLORS.asphalt : COLORS.dirt}" stroke-width="${fmt(path.halfWidth * 2)}" stroke-linejoin="round" stroke-linecap="round"/>`);
  }

  // Scatter and props: trees as canopy discs, fences and walls as strokes, everything else as dots.
  const byCategory: Record<string, string[]> = { tree: [], bush: [], rock: [], prop: [], line: [] };
  for (const set of layout.props) {
    const def = getMapProp(set.prop);
    if (def.category === "grass") continue;
    for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
      const x = set.data[i]!;
      const z = set.data[i + 2]!;
      const yaw = set.data[i + 3]!;
      const scale = set.data[i + 4]!;
      if (def.collision.kind === "box" && def.collision.size[0] >= 3 * def.collision.size[2]) {
        const hx = (def.collision.size[0] / 2) * scale;
        const dx = Math.cos(yaw) * hx;
        const dz = -Math.sin(yaw) * hx;
        byCategory.line!.push(`M${X(x - dx)} ${Y(z - dz)}L${X(x + dx)} ${Y(z + dz)}`);
      } else {
        const r = def.category === "tree" ? def.footprint * scale * 1.2 : Math.max(0.6, def.footprint * scale);
        byCategory[def.category]!.push(`<circle cx="${X(x)}" cy="${Y(z)}" r="${fmt(r)}"/>`);
      }
    }
  }
  out.push(`<g fill="${COLORS.bush}" fill-opacity="0.8">${byCategory.bush!.join("")}</g>`);
  out.push(`<g fill="${COLORS.tree}" fill-opacity="0.85">${byCategory.tree!.join("")}</g>`);
  out.push(`<g fill="${COLORS.rock}">${byCategory.rock!.join("")}</g>`);
  out.push(`<g fill="${COLORS.prop}">${byCategory.prop!.join("")}</g>`);
  out.push(`<path d="${byCategory.line!.join("")}" stroke="${COLORS.prop}" stroke-width="0.8" fill="none"/>`);

  // Buildings.
  for (const b of layout.buildings) {
    const corners = rectCorners(b.bounds);
    out.push(`<polygon points="${corners.map(([x, z]) => `${X(x)},${Y(z)}`).join(" ")}" fill="${COLORS.building}" stroke="#3b1a14" stroke-width="0.5"/>`);
  }

  // Playable boundary, grid labels.
  out.push(`<rect x="${-half}" y="${-half}" width="${half * 2}" height="${half * 2}" fill="none" stroke="${COLORS.boundary}" stroke-width="2" stroke-dasharray="12 6"/>`);
  const label = Math.floor((half - 50) / 100) * 100;
  for (let v = -label; v <= label; v += 100) {
    out.push(`<text x="${v}" y="${-half - 8}" font-size="10" text-anchor="middle" fill="#555">${v}</text>`);
    out.push(`<text x="${-half - 6}" y="${-v + 3}" font-size="10" text-anchor="end" fill="#555">${v}</text>`);
  }

  // Spawns.
  for (const spawn of map.spawns) {
    const [x, z] = spawn.position;
    out.push(`<circle cx="${X(x)}" cy="${Y(z)}" r="4" fill="none" stroke="${COLORS.spawn}" stroke-width="1.5"/>`);
  }

  // POI labels.
  for (const poi of map.pois) {
    const [x, z] = poi.center;
    out.push(`<circle cx="${X(x)}" cy="${Y(z)}" r="${poi.radius}" fill="none" stroke="${COLORS.poi}" stroke-width="1.2" stroke-dasharray="4 4"/>`);
    out.push(
      `<text x="${X(x)}" y="${fmt(-z - poi.radius - 6)}" font-size="15" font-weight="600" text-anchor="middle" fill="${COLORS.poi}" stroke="${COLORS.background}" stroke-width="3" paint-order="stroke">${escape(poi.name)} · tier ${poi.lootTier}</text>`,
    );
  }

  // Legend.
  const legend: [string, string][] = [
    [COLORS.asphalt, "asphalt road"],
    [COLORS.dirt, "dirt road / ramp"],
    [COLORS.building, "building"],
    [COLORS.tree, "tree"],
    [COLORS.rock, "rock"],
    [COLORS.spawn, "spawn"],
    [COLORS.boundary, "playable edge"],
  ];
  out.push(`<g transform="translate(${half - 140} ${half - 12 - legend.length * 16})"><rect x="-8" y="-14" width="148" height="${legend.length * 16 + 10}" fill="#fff" fill-opacity="0.8"/>`);
  legend.forEach(([color, label], i) => out.push(`<rect x="0" y="${i * 16 - 9}" width="12" height="10" fill="${color}"/><text x="18" y="${i * 16}" font-size="11">${label}</text>`));
  out.push(`</g><text x="${-half}" y="${half + 20}" font-size="11" fill="#555">1 unit = 1 m, north up, contours every ${step} m · generated from MapData (${escape(map.id)}), layout ${layout.checksum}</text>`, `</svg>`);
  return out.join("\n");
}

/** Marching squares over the heightfield: [level, "M..L.."] line segments. */
function* contourSegments(terrain: Terrain, from: number, to: number, grid: number, step: number): Generator<[number, string]> {
  const n = Math.floor((to - from) / grid);
  const heights = new Float32Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) heights[j * (n + 1) + i] = terrain.sampleHeight(from + i * grid, from + j * grid);
  const at = (i: number, j: number) => heights[j * (n + 1) + i]!;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const corners = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)] as const;
      const low = Math.min(...corners);
      const high = Math.max(...corners);
      for (let level = Math.ceil(low / step) * step; level < high; level += step) {
        const points: [number, number][] = [];
        const edges = [[0, 1], [1, 2], [3, 2], [0, 3]] as const;
        const positions = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]] as const;
        for (const [a, b] of edges) {
          const ha = corners[a];
          const hb = corners[b];
          if (ha < level === hb < level) continue;
          const t = (level - ha) / (hb - ha);
          const x = from + (positions[a][0] + (positions[b][0] - positions[a][0]) * t) * grid;
          const z = from + (positions[a][1] + (positions[b][1] - positions[a][1]) * t) * grid;
          points.push([x, z]);
        }
        for (let k = 0; k + 1 < points.length; k += 2) yield [level, `M${fmt(points[k]![0])} ${fmt(-points[k]![1])}L${fmt(points[k + 1]![0])} ${fmt(-points[k + 1]![1])}`];
      }
    }
  }
}

function fmt(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
