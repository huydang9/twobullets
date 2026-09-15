import { getBuildingPrefab, isBuildingPrefabId } from "../buildings/prefabs";
import { rectCorners } from "../layout/geometry";
import { getMapProp } from "../layout/props";
import { mapPaths } from "../layout/roads";
import type { ScatterRule } from "../layout/scatter";
import type { MapData, Vec2Tuple } from "../types";
import { prefabRectOf } from "./previewGeometry";

export interface MapPreviewOptions {
  /** Water outlines to fill (real maps). */
  readonly water?: readonly (readonly Vec2Tuple[])[];
  /** Output side, px (the SVG scales; this sets width/height attributes). */
  readonly size?: number;
}

const COLORS = {
  ground: "#8d9a66",
  field: "#a7ab74",
  wood: "#4f6a3c",
  water: "#5d87a6",
  asphalt: "#5b5b58",
  dirt: "#b49a6c",
  building: "#d9d2c3",
  buildingEdge: "#6f675b",
  poi: "#f4efe3",
  poiEdge: "#1d2a44",
} as const;

const TREE_PROPS = new Set(["tree_fir_a", "tree_fir_b", "tree_broadleaf_a", "tree_broadleaf_b", "tree_fir_young", "tree_oak_fungi"]);

/**
 * Small top-down SVG of a map for menus (map picker cards): woods, water, roads, building roofs and POI dots, north up,
 * covering the playable square. No terrain needed, so it renders from MapData alone. One unit is one meter.
 */
export function renderMapPreviewSvg(map: MapData, options: MapPreviewOptions = {}): string {
  const half = map.terrain.playableHalfExtent;
  const size = options.size ?? 512;
  const n = (v: number) => (Math.round(v * 10) / 10).toString();
  const path = (points: readonly Vec2Tuple[], close: boolean) => `M${points.map(([x, z]) => `${n(x)} ${n(-z)}`).join("L")}${close ? "Z" : ""}`;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-half} ${-half} ${half * 2} ${half * 2}" width="${size}" height="${size}">`,
    `<rect x="${-half}" y="${-half}" width="${half * 2}" height="${half * 2}" fill="${COLORS.ground}"/>`,
  ];

  // Dense, mostly unmasked tree rules draw as woods (their outlines); groves and roadside lines are skipped.
  const woods = (map.scatters as readonly ScatterRule[]).filter(
    (rule) => !rule.detail && !rule.spots && !rule.id.includes("trees") && rule.density >= 0.9 && (rule.mask?.threshold ?? 0) <= 0.42 && rule.props.some((p) => TREE_PROPS.has(p.prop) && getMapProp(p.prop).category === "tree") && rule.area.length > 4,
  );
  const fields = (map.scatters as readonly ScatterRule[]).filter((rule) => rule.id.startsWith("hay_"));
  if (fields.length > 0) out.push(`<path fill="${COLORS.field}" d="${fields.map((r) => path(r.area, true)).join("")}"/>`);
  if (woods.length > 0) out.push(`<path fill="${COLORS.wood}" fill-rule="nonzero" opacity="0.9" d="${woods.map((r) => path(r.area, true)).join("")}"/>`);
  if (options.water && options.water.length > 0) out.push(`<path fill="${COLORS.water}" d="${options.water.map((w) => path(w, true)).join("")}"/>`);

  for (const road of mapPaths(map)) {
    out.push(`<path fill="none" stroke="${road.kind === "asphalt" ? COLORS.asphalt : COLORS.dirt}" stroke-width="${n(Math.max(4, road.halfWidth * 2))}" stroke-linecap="round" stroke-linejoin="round" d="${path(road.points, false)}"/>`);
  }

  const roofs: string[] = [];
  for (const b of map.buildings) {
    if (!isBuildingPrefabId(b.prefab)) continue;
    const rect = prefabRectOf(getBuildingPrefab(b.prefab).bounds, [b.position[0], b.position[2]], b.yaw);
    roofs.push(path(rectCorners(rect), true));
  }
  if (roofs.length > 0) out.push(`<path fill="${COLORS.building}" stroke="${COLORS.buildingEdge}" stroke-width="1.5" d="${roofs.join("")}"/>`);

  for (const poi of map.pois) {
    if (poi.kind === "training") continue;
    out.push(`<circle cx="${n(poi.center[0])}" cy="${n(-poi.center[1])}" r="${poi.lootTier === 2 ? 11 : 8}" fill="${COLORS.poi}" stroke="${COLORS.poiEdge}" stroke-width="4"/>`);
  }
  out.push("</svg>");
  return `${out.join("\n")}\n`;
}
