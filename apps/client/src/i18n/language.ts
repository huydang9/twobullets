/** UI languages. Vietnamese is the default; English is selectable. */
export type Language = "vi" | "en";

export const LANGUAGES: readonly Language[] = ["vi", "en"];
export const DEFAULT_LANGUAGE: Language = "vi";
/** localStorage key of the chosen language. */
export const LANGUAGE_STORAGE_KEY = "tb.lang";
/** URL override: `?lang=en`. */
export const LANGUAGE_PARAM = "lang";

export function isLanguage(value: unknown): value is Language {
  return value === "vi" || value === "en";
}

/** `?lang=` wins, then the stored choice, then the default. Pure, so tests don't need a browser. */
export function resolveLanguage(search: string, stored: string | null): Language {
  const param = new URLSearchParams(search).get(LANGUAGE_PARAM)?.toLowerCase();
  if (isLanguage(param)) return param;
  if (isLanguage(stored)) return stored;
  return DEFAULT_LANGUAGE;
}
