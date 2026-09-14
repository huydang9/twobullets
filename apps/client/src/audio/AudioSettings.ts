import type { AudioBusId } from "./types";

export type AudioVolumeKey = "master" | AudioBusId;
export type AudioVolumes = Record<AudioVolumeKey, number>;

const STORAGE_KEY = "twobullets.audio.volumes";

/**
 * Ambience (wind, birdsong, bird calls) is switched off for now. It wins over any saved ambience volume, and while
 * off, no ambience file is fetched and nothing ducks the ambience bus. DEV: `__audio.ambience(true)`.
 */
export const AMBIENCE_ENABLED = false;

export const DEFAULT_VOLUMES: Readonly<AudioVolumes> = {
  master: 0.8,
  weapons: 1,
  impacts: 1,
  footsteps: 1,
  foley: 1,
  ambience: 0.8,
  ui: 0.8,
};

/** User volume settings (0..1 per bus plus master), persisted in localStorage. */
export class AudioSettings {
  /** Session-only gate (not persisted); see AMBIENCE_ENABLED. */
  ambienceEnabled = AMBIENCE_ENABLED;
  private readonly values: AudioVolumes = { ...DEFAULT_VOLUMES };
  private readonly listeners = new Set<(key: AudioVolumeKey, value: number) => void>();

  constructor() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<AudioVolumes>;
      for (const key of Object.keys(this.values) as AudioVolumeKey[]) {
        const value = stored[key];
        if (typeof value === "number" && Number.isFinite(value)) this.values[key] = clampVolume(value);
      }
    } catch {
      // Storage unavailable or corrupt: keep defaults.
    }
  }

  get(key: AudioVolumeKey): number {
    return this.values[key];
  }

  get all(): Readonly<AudioVolumes> {
    return this.values;
  }

  set(key: AudioVolumeKey, value: number): void {
    this.values[key] = clampVolume(value);
    for (const listener of this.listeners) listener(key, this.values[key]);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch {
      // Not persisted; the value still applies this session.
    }
  }

  onChange(listener: (key: AudioVolumeKey, value: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function clampVolume(value: number): number {
  return Math.min(1, Math.max(0, value));
}
