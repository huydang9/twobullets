import { ITEMS, type ItemId } from "@twobullets/shared";

/**
 * Flat SVG silhouettes shown until a baked icon lands, or when an item has no model at all. Same aspect as the baked
 * icons (weapons 8:3, everything else square), light grey on transparent.
 */

const FILL = "rgba(226,226,218,0.78)";
const DIM = "rgba(226,226,218,0.4)";

const SHAPES = {
  // Side profile, muzzle to the right.
  weapon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 36"><path fill="${FILL}" d="M6 13h40l4-3h28v3h14v4H78v3H56l-4 3h-8l-3 9h-8l2-9H20l-6 8H6l4-8H6z"/></svg>`,
  ammo: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><g fill="${FILL}"><path d="M11 18c0-6 3-10 4-10s4 4 4 10v22h-8z"/><path d="M22 16c0-6 3-10 4-10s4 4 4 10v24h-8z"/><path d="M33 18c0-6 3-10 4-10s4 4 4 10v22h-8z"/></g></svg>`,
  throwable: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><g fill="${FILL}"><ellipse cx="24" cy="29" rx="11" ry="13"/><rect x="19" y="10" width="10" height="7" rx="1"/><path d="M29 12h6l3 10h-3l-3-7h-3z"/></g></svg>`,
  heal: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="7" y="12" width="34" height="26" rx="3" fill="${DIM}"/><path fill="${FILL}" d="M21 17h6v6h6v6h-6v6h-6v-6h-6v-6h6z"/></svg>`,
  boost: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><g fill="${FILL}"><rect x="15" y="10" width="18" height="30" rx="4"/></g><rect x="15" y="20" width="18" height="10" fill="${DIM}"/></svg>`,
  helmet: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="${FILL}" d="M8 32c0-12 7-20 16-20s16 8 16 20v3H8z"/><rect x="6" y="34" width="36" height="4" rx="2" fill="${DIM}"/></svg>`,
  vest: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="${FILL}" d="M16 7h5l3 5 3-5h5l4 9 3 3v22H9V19l3-3z"/><rect x="14" y="26" width="8" height="7" fill="${DIM}"/><rect x="26" y="26" width="8" height="7" fill="${DIM}"/></svg>`,
  backpack: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="${FILL}" d="M18 6h12v5h3c4 0 6 3 6 7v22c0 2-1 3-3 3H12c-2 0-3-1-3-3V18c0-4 2-7 6-7h3z"/><rect x="15" y="27" width="18" height="10" rx="2" fill="${DIM}"/></svg>`,
} as const;

const cache = new Map<ItemId, string>();

/** A data URL silhouette for `itemId` by category. */
export function fallbackIconUrl(itemId: ItemId): string {
  let url = cache.get(itemId);
  if (url) return url;
  url = `data:image/svg+xml,${encodeURIComponent(SHAPES[ITEMS[itemId].category])}`;
  cache.set(itemId, url);
  return url;
}
