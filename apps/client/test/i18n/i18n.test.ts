import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getLanguage, onLanguageChange, resetLanguageForTests, setLanguage, t } from "../../src/i18n/core";
import { en } from "../../src/i18n/en";
import { interpolate, selectPlural, templateParts, type Message } from "../../src/i18n/format";
import { DEFAULT_LANGUAGE, resolveLanguage } from "../../src/i18n/language";
import { vi } from "../../src/i18n/vi";

const placeholders = (message: Message): string[] => {
  const forms = typeof message === "string" ? [message] : Object.values(message);
  return [...new Set(forms.flatMap((form) => [...(form ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)))].sort();
};

describe("i18n catalogs", () => {
  it("vi and en have exactly the same keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(vi).sort());
  });

  it("every message uses the same placeholders in both languages", () => {
    for (const key of Object.keys(vi) as (keyof typeof vi)[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(vi[key]));
    }
  });

  it("has no empty messages", () => {
    for (const [key, message] of [...Object.entries(vi), ...Object.entries(en)]) {
      const forms = typeof message === "string" ? [message] : Object.values(message);
      for (const form of forms) expect(form?.trim().length ?? 0, key).toBeGreaterThan(0);
    }
  });
});

describe("i18n formatting", () => {
  it("interpolates named params and leaves unknown ones visible", () => {
    expect(interpolate("{killer} đã hạ gục {victim} bằng {weapon}", { killer: "Bot Kilo", victim: "Bạn", weapon: "AR-4" })).toBe("Bot Kilo đã hạ gục Bạn bằng AR-4");
    expect(interpolate("Hạng #{place} / {count}", { place: 3 })).toBe("Hạng #3 / {count}");
    expect(interpolate("no params")).toBe("no params");
  });

  it("picks plural forms by count", () => {
    const kills = { one: "{count} KILL", other: "{count} KILLS" };
    expect(selectPlural(kills, 1, "en")).toBe("{count} KILL");
    expect(selectPlural(kills, 3, "en")).toBe("{count} KILLS");
    expect(selectPlural({ other: "{count} HẠ GỤC" }, 1, "vi")).toBe("{count} HẠ GỤC");
  });

  it("splits templates into text and placeholder parts", () => {
    expect(templateParts("{you} killed {victim}!")).toEqual([{ param: "you" }, { text: " killed " }, { param: "victim" }, { text: "!" }]);
  });
});

describe("i18n language selection", () => {
  afterEach(() => resetLanguageForTests());

  it("defaults to Vietnamese", () => {
    expect(DEFAULT_LANGUAGE).toBe("vi");
    expect(resolveLanguage("", null)).toBe("vi");
    expect(resolveLanguage("?bots=1", "fr")).toBe("vi");
    expect(getLanguage()).toBe("vi");
    expect(t("common.you")).toBe("Bạn");
  });

  it("uses the stored choice, and ?lang= overrides it", () => {
    expect(resolveLanguage("", "en")).toBe("en");
    expect(resolveLanguage("?lang=en", null)).toBe("en");
    expect(resolveLanguage("?bots=1&lang=EN", "vi")).toBe("en");
    expect(resolveLanguage("?lang=vi", "en")).toBe("vi");
    expect(resolveLanguage("?lang=xx", "en")).toBe("en");
  });

  it("switches at once and notifies listeners", () => {
    const seen: string[] = [];
    const off = onLanguageChange((language) => seen.push(language));
    setLanguage("en");
    expect(t("killNotice.kills", { count: 1 })).toBe("1 KILL");
    expect(t("killNotice.kills", { count: 2 })).toBe("2 KILLS");
    setLanguage("vi");
    expect(t("killNotice.kills", { count: 2 })).toBe("2 HẠ GỤC");
    off();
    setLanguage("en");
    expect(seen).toEqual(["en", "vi"]);
  });
});

// ---- No new hard-coded English UI text --------------------------------------------------------------------------------

const UI_ROOT = fileURLToPath(new URL("../../src/ui", import.meta.url));

/** Owned elsewhere or DEV-only (English on purpose). */
const SKIPPED_PATHS = ["mapPicker/", "StatsPanel.ts", "equipment/PreviewEquipment.ts"];

/** Literals that are fine anywhere: brand names and key caps. */
const ALLOWED_LITERALS = new Set(["TWOBULLETS"]);

const TEXT_SINKS = [
  /textContent\s*=\s*(["'`])(.*?)\1/g,
  /\.data\s*=\s*(["'`])(.*?)\1/g,
  /\.title\s*=\s*(["'`])(.*?)\1/g,
  /\bel\(\s*"[^"]*"\s*,\s*[^,()]+,\s*(["'`])(.*?)\1/g,
  /setText\([^,()]+,\s*(["'`])(.*?)\1/g,
  /\.append\((?:[^)]*?,\s*)?(["'`])([^"'`]*)\1\s*[,)]/g,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("ui text goes through the catalogs", () => {
  it("has no English literals written to the DOM in src/ui", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(UI_ROOT)) {
      const rel = relative(UI_ROOT, file).split("\\").join("/");
      if (SKIPPED_PATHS.some((skip) => rel.startsWith(skip) || rel === skip)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          for (const sink of TEXT_SINKS) {
            for (const match of line.matchAll(sink)) {
              const literal = match[2]!;
              if (ALLOWED_LITERALS.has(literal)) continue;
              if (/[A-Za-z]{3,}/.test(literal.replace(/\$\{[^}]*\}/g, ""))) offenders.push(`ui/${rel}:${index + 1} ${literal}`);
            }
          }
        });
    }
    expect(offenders, "use t()/elT() with a key in src/i18n/vi.ts and en.ts").toEqual([]);
  });
});
