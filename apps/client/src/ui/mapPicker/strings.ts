// Map picker text in one place for translation (the i18n pass moves these into the message catalog). Place names come
// from the map data and keep their diacritics; everything a player reads besides them is here.

export const MAP_PICKER_STRINGS = {
  title: "Choose a map",
  subtitle: "Real places from OpenStreetMap, rebuilt with the game's buildings",
  confirm: "PLAY ON THIS MAP",
  selected: "Selected",
  recommended: "Recommended",
  previewAlt: (name: string): string => `Map of ${name}`,
  fictionalName: "Map v1",
  fictionalPlace: "Fictional valley",
  /** Country names by ISO code; unknown codes fall back to the map's English country name. */
  countries: { cz: "Czechia", vn: "Vietnam", jp: "Japan" } as Readonly<Record<string, string>>,
  stats: {
    pois: (n: number): string => `${n} ${n === 1 ? "place" : "places"}`,
    buildings: (n: number): string => `${n} ${n === 1 ? "building" : "buildings"}`,
    roads: (km: number): string => `${km.toFixed(1)} km of road`,
    relief: (m: number): string => `${Math.round(m)} m of relief`,
    flat: "flat",
  },
  snapshot: (date: string): string => `Map data from ${date}`,
  /** Attribution lines; the licenses require them wherever the map is shown. */
  credits: {
    osm: "© OpenStreetMap contributors (ODbL)",
    "terrain-tiles": "Elevation: AWS Terrain Tiles (USGS SRTM/GMTED)",
    "eu-dem": "Copernicus EU-DEM (European Union)",
  },
  creditsLink: "https://www.openstreetmap.org/copyright",
} as const;

export type MapPickerStrings = typeof MAP_PICKER_STRINGS;
