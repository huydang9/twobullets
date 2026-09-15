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
  // <custom-places>
  // </custom-places>
];

export function findPlace(id: string): PlaceConfig | undefined {
  return PLACES.find((place) => place.id === id);
}
