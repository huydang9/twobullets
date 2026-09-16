import { t, type MessageKey } from "../../i18n";

// Map picker text, built from the i18n catalogs (`mapPicker.*` keys) when a picker is created. Place names come from
// the map data and keep their diacritics. Attribution lines stay as the licenses word them (docs/i18n.md: credit lines
// are not translated).

export interface MapPickerStrings {
  readonly title: string;
  readonly subtitle: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly selected: string;
  readonly recommended: string;
  readonly comingSoon: string;
  readonly previewAlt: (name: string) => string;
  readonly fictionalName: string;
  readonly fictionalPlace: string;
  /** Country names by ISO code; unknown codes fall back to the map's English country name. */
  readonly countries: Readonly<Record<string, string>>;
  readonly stats: {
    readonly pois: (n: number) => string;
    readonly buildings: (n: number) => string;
    readonly roads: (km: number) => string;
    readonly relief: (m: number) => string;
    readonly flat: string;
  };
  readonly snapshot: (date: string) => string;
  /** Attribution lines; the licenses require them wherever the map is shown. */
  readonly credits: Readonly<Record<"osm" | "terrain-tiles" | "eu-dem", string>>;
  readonly creditsLink: string;
}

export const MAP_CREDITS: MapPickerStrings["credits"] = {
  osm: "© OpenStreetMap contributors (ODbL)",
  "terrain-tiles": "Elevation: AWS Terrain Tiles (USGS SRTM/GMTED)",
  "eu-dem": "Copernicus EU-DEM (European Union)",
};

const COUNTRY_CODES = ["vn"] as const;

/** Strings in the current language. */
export function mapPickerStrings(): MapPickerStrings {
  const countries: Record<string, string> = {};
  for (const code of COUNTRY_CODES) countries[code] = t(`mapPicker.country.${code}` satisfies MessageKey);
  return {
    title: t("mapPicker.title"),
    subtitle: t("mapPicker.subtitle"),
    confirm: t("mapPicker.confirm"),
    cancel: t("mapPicker.cancel"),
    selected: t("mapPicker.selected"),
    recommended: t("mapPicker.recommended"),
    comingSoon: t("map.comingSoon"),
    previewAlt: (name) => t("mapPicker.previewAlt", { name }),
    fictionalName: t("mapPicker.fictionalName"),
    fictionalPlace: t("mapPicker.fictionalPlace"),
    countries,
    stats: {
      pois: (count) => t("mapPicker.pois", { count }),
      buildings: (count) => t("mapPicker.buildings", { count }),
      roads: (km) => t("mapPicker.roads", { km: km.toFixed(1) }),
      relief: (m) => t("mapPicker.relief", { m: Math.round(m) }),
      flat: t("mapPicker.flat"),
    },
    snapshot: (date) => t("mapPicker.snapshot", { date }),
    credits: MAP_CREDITS,
    creditsLink: "https://www.openstreetmap.org/copyright",
  };
}
