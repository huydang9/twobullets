import type { MapData, MapLayout, Terrain, ZoneCircle } from "@twobullets/shared";

/** The pure map data the map image is rendered from (MapRuntime has all three). */
export interface MapWorldData {
  readonly map: MapData;
  readonly terrain: Terrain;
  readonly layout: MapLayout;
}

export type MapMarkerState = "alive" | "downed" | "dead";

/** The viewer's marker, filled in place. Heading in degrees: 0 = north (+Z), 90 = east (+X). */
export interface MapViewer {
  x: number;
  z: number;
  headingDegrees: number;
  /** Position within the team, 1-based (marker colour); 0 when there is no team. */
  number: number;
}

/** One teammate marker, filled in place. */
export interface MapTeammate {
  x: number;
  z: number;
  headingDegrees: number;
  /** Position within the team, 1-based: marker colour and label. */
  number: number;
  state: MapMarkerState;
}

/** Zone overlay and timer strip, filled in place. */
export interface MapZoneInfo {
  /** Circle at this tick (blue outside it), or null before the first announcement. */
  current: ZoneCircle | null;
  /** Announced next safe circle (white outline), or null. */
  next: ZoneCircle | null;
  /** Timer strip label ("" hides the strip). */
  label: string;
  /** Countdown shown next to the label, s, or -1. */
  seconds: number;
  /** Shrink progress 0..1, or -1 when not shrinking. */
  progress: number;
}

/**
 * What the map shows. Called at the overlay rate (≈15 Hz) while the map or minimap is visible; implementations write
 * into the objects they are given and must not allocate.
 */
export interface MapViewSource {
  readViewer(out: MapViewer): void;
  /** Writes teammates into `out[0..count)` (entries exist up to `out.length`) and returns the count. */
  readTeammates?(out: readonly MapTeammate[]): number;
  /** Fills the zone info; leave `current` null when there is no zone. */
  readZone?(out: MapZoneInfo): void;
}

/** Pointer lock hooks the map needs (InputManager satisfies it). */
export interface MapInput {
  readonly isLocked: boolean;
  requestLock(): void;
  onLockChange(listener: (locked: boolean) => void): void;
}
