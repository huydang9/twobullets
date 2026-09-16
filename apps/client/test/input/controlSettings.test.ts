import { afterEach, beforeEach, describe, expect, it, vi as vitest } from "vitest";
import { setLanguage, t, type MessageKey } from "../../src/i18n";
import {
  DEFAULT_CONTROL_SETTINGS,
  getControlSettings,
  HOLD_TOGGLE_MODES,
  parseControlSettings,
  resetControlSettings,
  setControlSettings,
  TOGGLE_ACTIONS,
} from "../../src/input/controlSettings";

// The aim / crouch / sprint hold-vs-toggle preference: defaults, what survives a reload, and what a corrupt entry does.

class FakeStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  vitest.stubGlobal("localStorage", storage);
  resetControlSettings();
});

afterEach(() => {
  resetControlSettings();
  vitest.unstubAllGlobals();
});

describe("control settings", () => {
  it("defaults to today's behaviour: everything is hold", () => {
    expect(DEFAULT_CONTROL_SETTINGS).toEqual({ aim: "hold", crouch: "hold", sprint: "hold" });
    expect(getControlSettings()).toEqual(DEFAULT_CONTROL_SETTINGS);
  });

  it("keeps the choice across a reload", () => {
    setControlSettings({ aim: "toggle" });
    expect(getControlSettings().aim).toBe("toggle");
    // A fresh page reads the same storage.
    resetControlSettings();
    expect(getControlSettings()).toEqual({ aim: "toggle", crouch: "hold", sprint: "hold" });
  });

  it("falls back per field on an invalid, missing or corrupt entry", () => {
    expect(parseControlSettings(null)).toEqual(DEFAULT_CONTROL_SETTINGS);
    expect(parseControlSettings("{not json")).toEqual(DEFAULT_CONTROL_SETTINGS);
    expect(parseControlSettings("[]")).toEqual(DEFAULT_CONTROL_SETTINGS);
    expect(parseControlSettings('"toggle"')).toEqual(DEFAULT_CONTROL_SETTINGS);
    expect(parseControlSettings('{"aim":"ads","crouch":"toggle"}')).toEqual({ aim: "hold", crouch: "toggle", sprint: "hold" });
    expect(parseControlSettings('{"aim":7,"sprint":null}')).toEqual(DEFAULT_CONTROL_SETTINGS);
  });

  it("survives blocked storage (private mode) without throwing", () => {
    vitest.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {},
    });
    resetControlSettings();
    expect(getControlSettings()).toEqual(DEFAULT_CONTROL_SETTINGS);
    expect(setControlSettings({ aim: "toggle" }).aim).toBe("toggle");
  });

  it("every label is translated in Vietnamese and English (no hardcoded strings)", () => {
    const keys: MessageKey[] = ["settings.controls", "settings.controlsHint"];
    for (const action of TOGGLE_ACTIONS) {
      keys.push(`settings.${action}`);
      for (const mode of HOLD_TOGGLE_MODES) keys.push(`settings.${action}.${mode}`);
    }
    for (const language of ["vi", "en"] as const) {
      setLanguage(language);
      for (const key of keys) {
        expect(t(key), `${language} ${key}`).not.toBe("");
        expect(t(key), `${language} ${key}`).not.toContain("{");
      }
    }
    setLanguage("vi");
    expect(t("settings.aim")).toBe("Ngắm bắn");
    expect(t("settings.aim.hold")).toBe("Giữ chuột phải");
    expect(t("settings.aim.toggle")).toBe("Bật/tắt");
  });
});
