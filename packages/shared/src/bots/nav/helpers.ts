import type { NavGrid } from "../types";
import { PASSABLE, asNavGridData, type NavBuildStats } from "./navGrid";

/** Component id with the largest walkable area (the map's main walkable network). */
export function navMainComponent(grid: NavGrid): number {
  return asNavGridData(grid).layout.mainComponent;
}

/**
 * `isValidCenter` for the zone schedule (design §8.2): the terrain cell at (x, z) is walkable and in the main component.
 */
export function isValidZoneCenter(grid: NavGrid): (x: number, z: number) => boolean {
  const data = asNavGridData(grid);
  const main = data.layout.mainComponent;
  return (x, z) => {
    const cell = data.cellAt(x, z);
    return cell >= 0 && (data.terrainFlags[cell]! & PASSABLE) !== 0 && data.terrainComp[cell] === main;
  };
}

/** Build and size report for DEV handles (`navStats()`) and benches. */
export function navStats(grid: NavGrid): { readonly info: NavGrid["info"]; readonly build: NavBuildStats | null; readonly megabytes: number } {
  const data = asNavGridData(grid);
  return { info: data.info, build: data.stats, megabytes: Math.round((data.info.byteLength / (1024 * 1024)) * 100) / 100 };
}
