// Credits screen: every attribution the shipped assets carry, from public/assets/manifest.json and the per-folder
// credits.json files (their shapes differ). Lines use the same "Title by Author (License) — URL" form as the play overlay
// and are not translated (docs/i18n.md).

export const CREDIT_FILES: readonly string[] = [
  "assets/manifest.json",
  "assets/equipment/credits.json",
  "assets/environment/credits.json",
  "assets/audio/credits.json",
  "assets/vfx/credits.json",
  "assets/map/credits.json",
];

type Json = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function authorsOf(entry: Json): string {
  if (typeof entry.author === "string") return entry.author;
  if (!Array.isArray(entry.authors)) return "";
  return entry.authors.map((a: unknown) => (typeof a === "string" ? a : text((a as Json | null)?.name))).filter(Boolean).join(", ");
}

/** Lines from one credits file; unknown shapes give no lines. */
export function creditLinesFrom(file: unknown): string[] {
  if (typeof file !== "object" || file === null) return [];
  const root = file as Json;
  const entries = [root.credits, root.sources, root.assets].flatMap((list) => (Array.isArray(list) ? (list as Json[]) : []));
  const lines: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const title = text(entry.title) || text(entry.name);
    if (!title) continue;
    const author = authorsOf(entry);
    const license = text(entry.license);
    const url = text(entry.url);
    lines.push(`${title}${author ? ` by ${author}` : ""}${license ? ` (${license})` : ""}${url ? ` — ${url}` : ""}`);
  }
  return lines;
}

/** Fetches every credits file (missing ones are skipped) and returns unique lines. */
export async function loadCreditLines(base: string = import.meta.env.BASE_URL, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<string[]> {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  const files = await Promise.all(
    CREDIT_FILES.map(async (path) => {
      try {
        const response = await fetchImpl(`${prefix}${path}`);
        return response.ok ? creditLinesFrom(await response.json()) : [];
      } catch {
        return [];
      }
    }),
  );
  return [...new Set(files.flat())];
}
