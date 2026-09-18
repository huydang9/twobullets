import type { ZoneCircle } from "../../match/types";
import type { BotWorldView, NavBuildingPlacement } from "../types";
import { NavFlag } from "../types";
import { vec3, type BotRandom, type MutVec3 } from "../brain/util";

// Building search (tuning round 2): loot is found by walking into buildings and looking around, never by reading all
// ground loot. The bot picks the nearest unsearched building (public map knowledge from `nav.grid.placements`), walks
// to it, then visits a few sampled indoor points on each floor while the 2 Hz loot scan (line of sight) spots items.

const MAX_POINTS = 4;
/** Ground floor and one upper floor (roofs and third floors cost stair trips for little loot). */
const FLOOR_OFFSETS = [0, 3.2] as const;
/** Sampled points per floor: ground, upper. */
const POINTS_PER_FLOOR = [3, 1] as const;
/** Give up on one search point after this long, s. */
const POINT_SECONDS = 12;
/** A building counts as searched after this long inside it, s. */
const BUILDING_SECONDS = 25;
/** Searched buildings are skipped for this long, s. */
const REVISIT_SECONDS = 300;
/** Buildings outside the zone circle cost this much extra distance, m. */
const OUTSIDE_ZONE_PENALTY = 400;
const LATE_ZONE_RADIUS = 300;
const MAX_DISTANCE = 300;
/** An unarmed bot walks as far as it takes. */
export const SEARCH_MAX_DISTANCE_UNARMED = 1000;
const MIN_POINT_SPACING = 3;

export class BuildingSearch {
  /** Current walk target. Valid while `active`. */
  readonly point: MutVec3 = vec3();
  active = false;
  buildingIndex = -1;
  /** "approach" (walking to the building) or "room" (visiting indoor points). */
  stage: "approach" | "room" = "approach";

  private buildings: readonly NavBuildingPlacement[] | null = null;
  private maxDistance = MAX_DISTANCE;
  /** The zone is pushing the bot: only buildings inside the circle count. */
  private strictZone = false;
  private visitedUntil = new Int32Array(0);
  private readonly points = new Float32Array(MAX_POINTS * 3);
  private pointCount = 0;
  private pointIndex = 0;
  private pointTick = 0;
  private enteredTick = -1;
  private readonly ring = new Float32Array(3 * 8);
  private readonly scratch: MutVec3 = vec3();
  private readonly near: MutVec3 = vec3();
  private readonly probe: MutVec3 = vec3();

  reset(): void {
    this.active = false;
    this.buildingIndex = -1;
    this.visitedUntil.fill(0);
  }

  /** Buildings known on this nav grid (0 for navs without building layers). */
  count(view: BotWorldView): number {
    this.bind(view);
    return this.buildings ? this.buildings.length : 0;
  }

  /** Whether an unsearched building is in reach; picks it when nothing is active. */
  available(view: BotWorldView, zone: ZoneCircle | null, maxDistance = MAX_DISTANCE, zonePressure = false): boolean {
    this.bind(view);
    this.maxDistance = maxDistance;
    this.strictZone = zonePressure;
    if (this.active && !(zone && (zonePressure || zone.r < LATE_ZONE_RADIUS) && this.outside(this.buildings![this.buildingIndex]!, zone))) return true;
    return this.choose(view, zone);
  }

  /** Straight distance to the current building, m (Infinity when none). */
  distance(view: BotWorldView): number {
    if (!this.active || !this.buildings) return Infinity;
    const b = this.buildings[this.buildingIndex]!;
    const dx = (b.minX + b.maxX) * 0.5 - view.self.feet.x;
    const dz = (b.minZ + b.maxZ) * 0.5 - view.self.feet.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /** Marks the current building searched (item found and taken, or the bot must leave). */
  finishBuilding(tick: number, dt: number): void {
    if (this.buildingIndex >= 0) this.visitedUntil[this.buildingIndex] = tick + Math.round(REVISIT_SECONDS / dt);
    this.active = false;
    this.buildingIndex = -1;
  }

  /**
   * Advances the search after the motor ran toward `point`: `arrived` (or `gaveUp`) moves to the next point; entering
   * the building samples indoor points. Returns false when the search ended (building done or unreachable).
   */
  advance(view: BotWorldView, arrived: boolean, gaveUp: boolean, rng: BotRandom, zone: ZoneCircle | null): boolean {
    const tick = view.tick;
    const dt = view.dt;
    if (!this.active && !this.choose(view, zone)) return false;
    const b = this.buildings![this.buildingIndex]!;
    const feet = view.self.feet;
    const inside = feet.x > b.minX - 1 && feet.x < b.maxX + 1 && feet.z > b.minZ - 1 && feet.z < b.maxZ + 1;
    if (this.stage === "approach") {
      if (gaveUp) {
        this.finishBuilding(tick, dt);
        return this.choose(view, zone);
      }
      if (inside || arrived) {
        this.stage = "room";
        this.enteredTick = tick;
        this.samplePoints(view, b, rng);
        this.nextPoint(view);
      }
      return true;
    }
    const timedOut = (tick - this.pointTick) * dt > POINT_SECONDS;
    if (arrived || gaveUp || timedOut) {
      this.pointIndex++;
      this.nextPoint(view);
    }
    if (this.pointIndex >= this.pointCount || (tick - this.enteredTick) * dt > BUILDING_SECONDS) {
      this.finishBuilding(tick, dt);
      return this.choose(view, zone);
    }
    return true;
  }

  private outside(b: NavBuildingPlacement, zone: ZoneCircle): boolean {
    const zx = (b.minX + b.maxX) * 0.5 - zone.cx;
    const zz = (b.minZ + b.maxZ) * 0.5 - zone.cz;
    return Math.sqrt(zx * zx + zz * zz) > zone.r * 0.9;
  }

  private bind(view: BotWorldView): void {
    const placements = view.nav.grid.placements ?? null;
    if (placements === this.buildings) return;
    this.buildings = placements;
    this.visitedUntil = new Int32Array(placements ? placements.length : 0);
    this.active = false;
    this.buildingIndex = -1;
  }

  private choose(view: BotWorldView, zone: ZoneCircle | null): boolean {
    const list = this.buildings;
    this.active = false;
    if (!list || list.length === 0) return false;
    const feet = view.self.feet;
    const tick = view.tick;
    let best = -1;
    let bestCost = this.maxDistance;
    for (let i = 0; i < list.length; i++) {
      if (this.visitedUntil[i]! > tick) continue;
      const b = list[i]!;
      const cx = (b.minX + b.maxX) * 0.5;
      const cz = (b.minZ + b.maxZ) * 0.5;
      const dx = cx - feet.x;
      const dz = cz - feet.z;
      let cost = Math.sqrt(dx * dx + dz * dz);
      if (zone) {
        const outside = this.outside(b, zone);
        // Outside a closing circle a building is off-limits (it would pull the bot back out of the zone); outside the
        // big early circles it only costs extra.
        if (outside && (this.strictZone || zone.r < LATE_ZONE_RADIUS)) continue;
        if (outside) cost += OUTSIDE_ZONE_PENALTY;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    if (best < 0) return false;
    const b = list[best]!;
    this.buildingIndex = best;
    this.active = true;
    this.stage = "approach";
    this.pointCount = 0;
    this.pointIndex = 0;
    this.pointTick = tick;
    this.point.x = (b.minX + b.maxX) * 0.5;
    this.point.y = b.y;
    this.point.z = (b.minZ + b.maxZ) * 0.5;
    return true;
  }

  /** Indoor points on each floor, sampled around the bot once it is at the building. */
  private samplePoints(view: BotWorldView, b: NavBuildingPlacement, rng: BotRandom): void {
    const feet = view.self.feet;
    const halfX = (b.maxX - b.minX) * 0.5;
    const halfZ = (b.maxZ - b.minZ) * 0.5;
    const radius = Math.max(2.5, Math.min(12, Math.sqrt(halfX * halfX + halfZ * halfZ)));
    const cx = (b.minX + b.maxX) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    this.pointCount = 0;
    for (let f = 0; f < FLOOR_OFFSETS.length && this.pointCount < MAX_POINTS; f++) {
      const s = this.scratch;
      s.x = cx;
      s.y = b.y + FLOOR_OFFSETS[f]! + 0.2;
      s.z = cz;
      // Anchor on this floor near the building center (or the bot on the ground floor).
      let anchor = view.nav.nearest(s, 6, this.near);
      if (anchor < 0 && f === 0) anchor = view.nav.nearest(feet, 2, this.near);
      if (anchor < 0) continue;
      const n = view.nav.sampleRing(this.near, 1.5, radius, (rng.next() * 0xffffffff) >>> 0, this.ring, 8);
      let taken = 0;
      for (let i = 0; i < n && taken < POINTS_PER_FLOOR[f]! && this.pointCount < MAX_POINTS; i++) {
        const x = this.ring[i * 3]!;
        const y = this.ring[i * 3 + 1]!;
        const z = this.ring[i * 3 + 2]!;
        if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
        if (!this.spaced(x, y, z, feet)) continue;
        s.x = x;
        s.y = y;
        s.z = z;
        const ref = view.nav.nearest(s, 0.5, this.probe);
        if (ref >= 0 && (view.nav.flagsAt(ref) & NavFlag.indoor) === 0 && f === 0) continue;
        const o = this.pointCount * 3;
        this.points[o] = x;
        this.points[o + 1] = y;
        this.points[o + 2] = z;
        this.pointCount++;
        taken++;
      }
      // Upper floors with no sampled point still get their anchor (stairs lead there).
      if (taken === 0 && f > 0 && this.pointCount < MAX_POINTS && this.near.y > b.y + FLOOR_OFFSETS[f]! - 1.5) {
        const o = this.pointCount * 3;
        this.points[o] = this.near.x;
        this.points[o + 1] = this.near.y;
        this.points[o + 2] = this.near.z;
        this.pointCount++;
      }
    }
    this.pointIndex = 0;
  }

  /** Search points at least 3 m from each other and from where the bot stands (no shuffling in one small room). */
  private spaced(x: number, y: number, z: number, feet: { readonly x: number; readonly y: number; readonly z: number }): boolean {
    if (Math.abs(y - feet.y) < 1.5 && (x - feet.x) * (x - feet.x) + (z - feet.z) * (z - feet.z) < MIN_POINT_SPACING * MIN_POINT_SPACING) return false;
    for (let i = 0; i < this.pointCount; i++) {
      const o = i * 3;
      const dx = this.points[o]! - x;
      const dy = this.points[o + 1]! - y;
      const dz = this.points[o + 2]! - z;
      if (Math.abs(dy) < 1.5 && dx * dx + dz * dz < MIN_POINT_SPACING * MIN_POINT_SPACING) return false;
    }
    return true;
  }

  private nextPoint(view: BotWorldView): void {
    this.pointTick = view.tick;
    if (this.pointIndex >= this.pointCount) return;
    const o = this.pointIndex * 3;
    this.point.x = this.points[o]!;
    this.point.y = this.points[o + 1]!;
    this.point.z = this.points[o + 2]!;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Roam (maze fix): `BuildingSearch` is the only thing that makes an idle bot walk, and it needs buildings. A map made
// of props — the maze is 682 walls and one watchtower — leaves every goal at zero, so `idle` (0.05) wins and the bot
// stands still scanning for the whole match. Roam is the map-agnostic fallback: a seeded walkable destination from
// `sampleRing`, biased away from where this bot has already been and toward the circle it has to end up in. Distances
// come from the nav grid's own extent, so a 144 m maze and a 500 m Map v1 both get sensible legs.
// ---------------------------------------------------------------------------------------------------------------

/** Destinations remembered per bot, so a roam doesn't walk back the way it came. */
const ROAM_MEMORY = 8;
/** Ring candidates per pick. */
const ROAM_CANDIDATES = 12;
/** Fraction of the map span a roam leg covers at most. */
const ROAM_SPAN_FRACTION = 0.3;
const ROAM_MIN_RADIUS = 18;
const ROAM_MAX_RADIUS = 120;
/** Abandon a destination that is still not reached after this long, s. */
const ROAM_SECONDS = 30;
/** Stand and watch after arriving, s (a bot that never stops reads as a conveyor belt). */
const ROAM_PAUSE_SECONDS: readonly [number, number] = [1.5, 4];

export class Roam {
  /** Current destination; valid while `active`. */
  readonly point: MutVec3 = vec3();
  active = false;

  private readonly ring = new Float32Array(ROAM_CANDIDATES * 3);
  /** Recent destinations as xz pairs (ring buffer). */
  private readonly visited = new Float32Array(ROAM_MEMORY * 2);
  private visitedCount = 0;
  private visitedNext = 0;
  private startTick = 0;
  private pauseUntil = 0;

  reset(): void {
    this.active = false;
    this.visitedCount = 0;
    this.visitedNext = 0;
    this.pauseUntil = 0;
  }

  /** True while the bot is standing at a reached destination (look around instead of walking). */
  paused(tick: number): boolean {
    return tick < this.pauseUntil;
  }

  /**
   * Ensures a destination. `zone` (the circle the bot must end up in, or null) pulls picks inside it, more strongly as
   * it shrinks. False when nav offers nothing walkable, in which case the caller falls back to scanning.
   */
  ensure(view: BotWorldView, zone: ZoneCircle | null, rng: BotRandom): boolean {
    const tick = view.tick;
    if (this.active && (tick - this.startTick) * view.dt <= ROAM_SECONDS) return true;
    if (tick < this.pauseUntil) return false;
    return this.choose(view, zone, rng);
  }

  /** After the motor ran toward `point`: arriving starts a short watch pause, giving up picks a new leg next call. */
  advance(view: BotWorldView, arrived: boolean, gaveUp: boolean, rng: BotRandom): void {
    if (!this.active) return;
    if (arrived) {
      this.active = false;
      this.pauseUntil = view.tick + Math.round(rng.span(ROAM_PAUSE_SECONDS) / view.dt);
    } else if (gaveUp) {
      this.active = false;
      this.pauseUntil = 0;
    }
  }

  /** Half the nav grid's playable square, m — the scale every roam distance is derived from. */
  private span(view: BotWorldView): number {
    const info = view.nav.grid.info;
    return Math.min(info.width, info.depth) * info.cellSize;
  }

  private choose(view: BotWorldView, zone: ZoneCircle | null, rng: BotRandom): boolean {
    const self = view.self;
    const feet = self.feet;
    const span = this.span(view);
    let max = span * ROAM_SPAN_FRACTION;
    if (max > ROAM_MAX_RADIUS) max = ROAM_MAX_RADIUS;
    if (max < ROAM_MIN_RADIUS) max = ROAM_MIN_RADIUS;
    const min = max * 0.4;
    // The zone only steers while it is small enough to matter against the map (early circles cover everything).
    const pull = zone ? Math.max(0, Math.min(1, 1 - (zone.r * 2) / span)) : 0;
    let best = -1;
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < 2; attempt++) {
      const lo = attempt === 0 ? min : 3;
      const n = view.nav.sampleRing(feet, lo, max, (rng.next() * 0xffffffff) >>> 0, this.ring, ROAM_CANDIDATES);
      for (let i = 0; i < n; i++) {
        const x = this.ring[i * 3]!;
        const z = this.ring[i * 3 + 2]!;
        const dx = x - feet.x;
        const dz = z - feet.z;
        // Farther is better: a short hop leaves the bot in the same corridor.
        let score = Math.sqrt(dx * dx + dz * dz) / max;
        if (zone) {
          const zx = x - zone.cx;
          const zz = z - zone.cz;
          const d = Math.sqrt(zx * zx + zz * zz);
          if (d > zone.r) score -= 3;
          else score += pull * (1 - d / Math.max(1, zone.r)) * 2;
        }
        for (let v = 0; v < this.visitedCount; v++) {
          const vx = x - this.visited[v * 2]!;
          const vz = z - this.visited[v * 2 + 1]!;
          const d = Math.sqrt(vx * vx + vz * vz);
          if (d < max) score -= 1.5 * (1 - d / max);
        }
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best >= 0) break;
    }
    if (best < 0) {
      this.active = false;
      return false;
    }
    this.point.x = this.ring[best * 3]!;
    this.point.y = this.ring[best * 3 + 1]!;
    this.point.z = this.ring[best * 3 + 2]!;
    this.visited[this.visitedNext * 2] = this.point.x;
    this.visited[this.visitedNext * 2 + 1] = this.point.z;
    this.visitedNext = (this.visitedNext + 1) % ROAM_MEMORY;
    if (this.visitedCount < ROAM_MEMORY) this.visitedCount++;
    this.active = true;
    this.startTick = view.tick;
    return true;
  }
}
