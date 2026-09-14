import { clamp, type Vec3Like } from "./acoustics";
import { Priority, type Voice } from "./AudioEngine";
import type { SoundId } from "./audioManifest";
import type { GameAudio } from "./GameAudio";

// Kept well under footsteps: in a battle royale the bed must never mask enemy movement.
const WIND_GAIN = 0.35;
const BIRDS_GAIN = 0.22;
const BIRD_CALL_GAIN = 0.25;
const FADE_IN = 2.5;

interface Bed {
  readonly id: SoundId;
  voice: Voice | null;
}

/**
 * Outdoor bed: a wind loop that grows with height, a birdsong loop that thins out with height, and random spatial
 * bird calls in the surrounding trees. Everything is damped and dulled indoors (the enclosure probe, or a room volume
 * via `AudioWorldProbe.enclosureProvider`).
 */
export class AmbienceSystem {
  private readonly wind: Bed = { id: "amb.wind", voice: null };
  private readonly birds: Bed = { id: "amb.birds", voice: null };
  private nextCall = 3;

  constructor(private readonly audio: GameAudio) {}

  update(dt: number, listener: Vec3Like): void {
    const engine = this.audio.engine;
    if (!engine.live) return;
    if (!this.audio.settings.ambienceEnabled) {
      this.stop();
      return;
    }
    const indoor = this.audio.probe.enclosure;
    // Ground level in the arena is y = 0; height above ~40 m is fully "exposed".
    const height = clamp(listener.y / 40, 0, 1);
    const windLevel = WIND_GAIN * (0.75 + 0.6 * height) * (1 - 0.65 * indoor);
    const birdLevel = BIRDS_GAIN * (1 - 0.8 * height) * (1 - 0.85 * indoor);

    this.updateBed(this.wind, windLevel, 20_000 - 19_000 * indoor);
    this.updateBed(this.birds, birdLevel, 16_000 - 14_000 * indoor);

    this.nextCall -= dt;
    if (this.nextCall <= 0) {
      this.nextCall = 4 + Math.random() * 9;
      if (indoor < 0.5 && height < 0.8) this.birdCall(listener);
    }
  }

  stop(): void {
    for (const bed of [this.wind, this.birds]) {
      bed.voice?.stop(1);
      bed.voice = null;
    }
  }

  private updateBed(bed: Bed, level: number, lowpass: number): void {
    const engine = this.audio.engine;
    const ctx = engine.live;
    if (!ctx) return;
    if (bed.voice && bed.voice.end < ctx.currentTime) bed.voice = null;
    if (!bed.voice) {
      const buffer = this.audio.bank.pick(bed.id);
      if (!buffer) return;
      const voice = engine.voice({ bus: "ambience", priority: Priority.important, label: bed.id, gain: 0 });
      if (!voice) return;
      // Random start point so the loop seam isn't always at the same moment.
      voice.addBuffer(buffer, { when: ctx.currentTime, loop: true, offset: Math.random() * buffer.duration * 0.9 });
      voice.output.gain.setTargetAtTime(level, ctx.currentTime, FADE_IN / 3);
      bed.voice = voice;
      return;
    }
    bed.voice.setGain(level, 0.5);
    bed.voice.setLowpass(lowpass, 0.3);
  }

  private birdCall(listener: Vec3Like): void {
    const ctx = this.audio.engine.live;
    const buffer = this.audio.bank.pick("amb.birdCall");
    if (!ctx || !buffer) return;
    const angle = Math.random() * Math.PI * 2;
    const range = 25 + Math.random() * 55;
    const position = { x: listener.x + Math.cos(angle) * range, y: Math.max(listener.y, 0) + 4 + Math.random() * 10, z: listener.z + Math.sin(angle) * range };
    const voice = this.audio.engine.voice({
      bus: "ambience",
      priority: Priority.ambient,
      label: "amb.birdCall",
      position,
      panning: "equalpower",
      gain: BIRD_CALL_GAIN * (25 / range),
      lowpass: 18_000 / (1 + range / 60),
      echo: 0.05,
      distance: range,
    });
    voice?.addBuffer(buffer, { when: ctx.currentTime, rate: 0.9 + Math.random() * 0.2 });
  }
}
