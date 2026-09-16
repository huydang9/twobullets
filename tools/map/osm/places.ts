/**
 * Real-world map presets: a 500 × 500 m square around each center. `generate.ts --lat --lon --name` appends custom places
 * between the markers below.
 *
 * Data: © OpenStreetMap contributors (ODbL 1.0) via Overpass; elevation: AWS Terrain Tiles (terrarium). See
 * docs/map/real-world.md.
 */
import type { PlaceConfig } from "../../../packages/shared/src/map/real/convert/types.ts";

export const PLACES: readonly PlaceConfig[] = [
  {
    // Ngã Tư Hàng Xanh, Bình Thạnh (Saigon): the roundabout where three main roads meet.
    // Center is the OSM junction node 2899907852. Dense city blocks, thinned to the cap; flat river lowland.
    // The square is 500 × 500 m centred on the junction (2026-09-16).
    id: "vn-hangxanh",
    name: "Ngã Tư Hàng Xanh",
    country: "Vietnam",
    countryCode: "vn",
    lat: 10.80144,
    lon: 106.71132,
    elevation: { mode: "flat", scale: 1, maxRelief: 4 },
    climate: "tropical",
    localName: "Ngã Tư Hàng Xanh",
    directionWords: ["Bắc", "Nam", "Đông", "Tây"],
    genericNames: ["Khu phố", "Bãi đất trống", "Công viên"],
    buildingCap: 110,
    urban: { openCenter: 40 },
  },
  {
    // Phú Nhuận (Saigon): a 500 × 500 m square north-east of the ward centre (2026-09-16), moved there when the maps
    // shrank so the Aga Building landmark and the Phan Đăng Lưu / Phan Xích Long blocks stay inside the square.
    // The id keeps the street name the map was first generated under: saved preferences, lobby settings and the terrain
    // seed (seedFromId) all use it. Player-visible names must stay neutral (convert/names.ts), so the display name is
    // the district.
    id: "vn-phandangluu",
    name: "Phú Nhuận",
    country: "Vietnam",
    countryCode: "vn",
    lat: 10.80288,
    lon: 106.68456,
    elevation: { mode: "flat", scale: 1, maxRelief: 4 },
    climate: "tropical",
    localName: "Phú Nhuận",
    directionWords: ["Bắc", "Nam", "Đông", "Tây"],
    genericNames: ["Khu phố", "Bãi đất trống", "Công viên"],
    buildingCap: 110,
    urban: { openCenter: 40 },
    // Estimated location (owner request): the footprint facing the side-alley junction across the service way
    // 127299447, which OSM leaves unnamed. Placed on top of the cap as a 4-story row house.
    landmarks: [{ osmId: 1044664010, name: "Aga Building", prefab: "tube_house_4", frontsWay: 127299447 }],
  },
  // <custom-places>
  // </custom-places>
];

export function findPlace(id: string): PlaceConfig | undefined {
  return PLACES.find((place) => place.id === id);
}
