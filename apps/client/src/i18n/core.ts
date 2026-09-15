import { en } from "./en";
import { interpolate, selectPlural, type MessageParams } from "./format";
import { DEFAULT_LANGUAGE, LANGUAGE_PARAM, LANGUAGE_STORAGE_KEY, resolveLanguage, type Language } from "./language";
import { vi, type MessageKey, type Messages } from "./vi";

const CATALOGS: Readonly<Record<Language, Messages>> = { vi, en };

type Listener = (language: Language) => void;

let current: Language | null = null;
const listeners = new Set<Listener>();

/** The active language; resolved on first use from `?lang=`, then `localStorage["tb.lang"]`, then vi. */
export function getLanguage(): Language {
  if (current === null) {
    current = typeof window === "undefined" ? DEFAULT_LANGUAGE : resolveLanguage(window.location.search, readStored());
    applyDocumentLanguage(current);
  }
  return current;
}

/**
 * Switches the UI language at once: stores the choice, keeps a `?lang=` in the URL in step (it would win on reload),
 * then notifies listeners so mounted UI rewrites its text.
 */
export function setLanguage(language: Language): void {
  if (language === getLanguage()) return;
  current = language;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Storage blocked (private mode): the choice lasts for this page only.
    }
    const url = new URL(window.location.href);
    if (url.searchParams.has(LANGUAGE_PARAM)) {
      url.searchParams.set(LANGUAGE_PARAM, language);
      window.history.replaceState(window.history.state, "", url);
    }
  }
  applyDocumentLanguage(language);
  for (const listener of listeners) listener(language);
}

/** Called after every language switch; returns the unsubscribe function. */
export function onLanguageChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Translated text for `key`. `{name}` placeholders take `params`; plural messages pick their form from `params.count`.
 * Without params the catalog string itself is returned, so calling this every frame for a fixed label doesn't allocate.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const language = getLanguage();
  const message = CATALOGS[language][key] ?? vi[key];
  if (typeof message === "string") return interpolate(message, params);
  const count = Number(params?.count ?? 0);
  return interpolate(selectPlural(message, count, language), params);
}

/** Test hook: forget the resolved language so the next `getLanguage()` resolves again. */
export function resetLanguageForTests(language: Language | null = null): void {
  current = language;
}

function readStored(): string | null {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function applyDocumentLanguage(language: Language): void {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}
