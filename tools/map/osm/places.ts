/**
 * Real-world map presets: a 1×1 km square around each center. `generate.ts --lat --lon --name` appends custom places
 * between the markers below.
 *
 * Data: © OpenStreetMap contributors (ODbL 1.0) via Overpass; elevation: AWS Terrain Tiles (terrarium). See
 * docs/map/real-world.md.
 */
import type { PlaceConfig } from "../../../packages/shared/src/map/real/convert/types.ts";

export const PLACES: readonly PlaceConfig[] = [
  {
    // Recommended default: a UNESCO farm village in South Bohemia, gentle 57 m relief, barns and houses round a green.
    id: "cz-holasovice",
    name: "Holašovice",
    country: "Czechia",
    countryCode: "cz",
    lat: 48.9697,
    lon: 14.2736,
    elevation: { mode: "real", scale: 1, maxRelief: 55 },
    climate: "temperate",
    directionWords: ["sever", "jih", "východ", "západ"],
    genericNames: ["Osada", "Statek", "Les"],
  },
  {
    // Hội An outskirts: coconut-palm hamlets between river channels. The DEM there is mostly canopy noise, so flat.
    id: "vn-camthanh",
    name: "Hội An – Cẩm Thanh",
    country: "Vietnam",
    countryCode: "vn",
    lat: 15.872,
    lon: 108.37,
    elevation: { mode: "flat", scale: 1, maxRelief: 4 },
    climate: "tropical",
    localName: "Cẩm Thanh",
    directionWords: ["Bắc", "Nam", "Đông", "Tây"],
    genericNames: ["Xóm", "Nông trại", "Rừng"],
  },
  {
    // Ogimachi, the gasshō-zukuri village in a steep valley: 206 m of relief scaled to about 0.3×.
    id: "jp-shirakawago",
    name: "Shirakawa-gō",
    country: "Japan",
    countryCode: "jp",
    lat: 36.257,
    lon: 136.906,
    elevation: { mode: "real", scale: 0.3, maxRelief: 60 },
    climate: "temperate",
    directionWords: ["北", "南", "東", "西"],
    genericNames: ["集落", "農家", "森"],
  },
  {
    // Ngã Tư Hàng Xanh, Bình Thạnh (Saigon): the roundabout where three main roads meet.
    // Center is the OSM junction node 2899907852. Dense city blocks, thinned to the cap; flat river lowland.
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
    buildingCap: 190,
    urban: { openCenter: 40 },
  },
  {
    // Phú Nhuận (Saigon), Phường Đức Nhuận: the one-way primary road inside the ward, toward the Phú Nhuận intersection.
    // Center checked with Overpass is_in against the ward boundary. The id keeps the street name the map was first
    // generated under: saved preferences, lobby settings and the terrain seed (seedFromId) all use it. Player-visible
    // names must stay neutral (convert/names.ts), so the display name is the district.
    id: "vn-phandangluu",
    name: "Phú Nhuận",
    country: "Vietnam",
    countryCode: "vn",
    lat: 10.80134,
    lon: 106.68246,
    elevation: { mode: "flat", scale: 1, maxRelief: 4 },
    climate: "tropical",
    localName: "Phú Nhuận",
    directionWords: ["Bắc", "Nam", "Đông", "Tây"],
    genericNames: ["Khu phố", "Bãi đất trống", "Công viên"],
    buildingCap: 190,
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
