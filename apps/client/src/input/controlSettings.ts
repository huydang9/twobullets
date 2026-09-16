// How a held action behaves: "hold" (today's: active only while the button is down) or "toggle" (press once to turn it
// on, press again to turn it off). Saved on this browser and read live, so a change in the pause menu applies at once.

export type HoldToggleMode = "hold" | "toggle";
/** Actions that can be held or toggled. Aim is the one players ask for; crouch and sprint follow the same rule. */
export type ToggleAction = "aim" | "crouch" | "sprint";

export const TOGGLE_ACTIONS: readonly ToggleAction[] = ["aim", "crouch", "sprint"];
export const HOLD_TOGGLE_MODES: readonly HoldToggleMode[] = ["hold", "toggle"];

export type ControlSettings = Readonly<Record<ToggleAction, HoldToggleMode>>;

/** Unchanged behaviour: everything is hold. */
export const DEFAULT_CONTROL_SETTINGS: ControlSettings = { aim: "hold", crouch: "hold", sprint: "hold" };

const STORAGE_KEY = "twobullets.controls.v1";

/** Saved settings, falling back to the defaults field by field (a corrupt entry or an unknown mode is ignored). */
export function parseControlSettings(raw: string | null): ControlSettings {
  let saved: Partial<Record<ToggleAction, unknown>> = {};
  try {
    saved = raw ? (JSON.parse(raw) as typeof saved) : {};
  } catch {
    saved = {};
  }
  if (typeof saved !== "object" || saved === null) saved = {};
  const mode = (action: ToggleAction): HoldToggleMode => HOLD_TOGGLE_MODES.find((m) => m === saved[action]) ?? DEFAULT_CONTROL_SETTINGS[action];
  return { aim: mode("aim"), crouch: mode("crouch"), sprint: mode("sprint") };
}

let current: ControlSettings | null = null;
const listeners = new Set<(settings: ControlSettings) => void>();

/** The live settings; read every frame by `HoldToggles`, so this stays a plain object lookup. */
export function getControlSettings(): ControlSettings {
  if (current === null) {
    let raw: string | null = null;
    try {
      raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      // Storage blocked (private mode): defaults for this page.
    }
    current = parseControlSettings(raw);
  }
  return current;
}

/** Applies and saves a change, then tells listeners (the settings panel and the pause menu redraw). */
export function setControlSettings(patch: Partial<ControlSettings>): ControlSettings {
  const next: ControlSettings = { ...getControlSettings(), ...patch };
  current = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the choice still applies for this session.
  }
  for (const listener of listeners) listener(next);
  return next;
}

export function onControlSettingsChange(listener: (settings: ControlSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests: drop the cached settings so the next read goes back to storage. */
export function resetControlSettings(): void {
  current = null;
}

// DEV console handle for browser checks without leaving a match: __twobulletsControls.set({ aim: "toggle" }).
if (import.meta.env?.DEV && typeof window !== "undefined") {
  Object.assign(window, { __twobulletsControls: { get: getControlSettings, set: setControlSettings } });
}
