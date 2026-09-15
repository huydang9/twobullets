import type { CatalogResponse } from "@twobullets/contracts/rest";
import { getLanguage, t } from "../i18n";
import { mapChoices, MAP_V1_ID, type MapChoice } from "../world/mapRuntime/maps";

// Map facts for menus: the client's pickable maps (cards with previews) joined with server-api's catalog, which says
// which maps a networked match can use today.

let choices: readonly MapChoice[] | null = null;

export function menuMapChoices(): readonly MapChoice[] {
  choices ??= mapChoices();
  return choices;
}

/** Ids a networked match can't use yet: not in the catalog, or listed with `available: false`. */
export function unavailableNetworkMaps(catalog: CatalogResponse | null, all: readonly { readonly id: string }[] = menuMapChoices()): Set<string> {
  const unavailable = new Set<string>();
  for (const { id } of all) {
    const info = catalog?.maps.find((m) => m.id === id);
    if (catalog ? !info?.available : id !== MAP_V1_ID) unavailable.add(id);
  }
  return unavailable;
}

/** Display name of a map id: Map v1 is localized, real maps keep their place name, others come from the catalog. */
export function mapLabel(id: string, catalog: CatalogResponse | null): string {
  if (id === MAP_V1_ID) return t("mapPicker.fictionalName");
  const choice = menuMapChoices().find((c) => c.id === id);
  if (choice) return choice.name;
  const info = catalog?.maps.find((m) => m.id === id);
  return info ? info.name[getLanguage()] : id;
}

export function mapPreviewUrl(id: string): string | null {
  return menuMapChoices().find((c) => c.id === id)?.previewUrl ?? null;
}
