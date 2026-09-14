import type { HitZone, WeaponId } from "@twobullets/shared";
import type { ClipPlan } from "../viewmodel/clipPlans";
import type { MechanicalCueKind } from "../viewmodel/timelines";
import type { AudioEngine, Voice } from "./AudioEngine";

const RELOAD_TAG = "reload";
const CYCLE_TAG = "cycle";

/** Layers of a synthesized gunshot. Gains are relative; decays are exponential time constants (s). */
interface ShotRecipe {
  /** Supersonic crack / mechanical snap: short band-passed noise. */
  readonly crack: { readonly gain: number; readonly frequency: number; readonly q: number; readonly decay: number };
  /** Low-end punch: sine with a fast downward pitch sweep. */
  readonly thump: { readonly gain: number; readonly from: number; readonly to: number; readonly decay: number };
  /** Blast body: low-passed noise whose cutoff falls as it decays. */
  readonly body: { readonly gain: number; readonly from: number; readonly to: number; readonly decay: number };
  /** Long, dark tail. */
  readonly tail: { readonly gain: number; readonly frequency: number; readonly decay: number };
  readonly reverb: number;
  readonly echo: number;
  readonly volume: number;
}

const SHOTS: Readonly<Record<WeaponId, ShotRecipe>> = {
  rifle: {
    crack: { gain: 0.9, frequency: 2600, q: 0.9, decay: 0.018 },
    thump: { gain: 0.9, from: 160, to: 52, decay: 0.035 },
    body: { gain: 0.7, from: 3200, to: 420, decay: 0.06 },
    tail: { gain: 0.22, frequency: 900, decay: 0.16 },
    reverb: 0.28,
    echo: 0,
    volume: 0.8,
  },
  shotgun: {
    crack: { gain: 0.8, frequency: 1500, q: 0.7, decay: 0.03 },
    thump: { gain: 1.2, from: 120, to: 36, decay: 0.07 },
    body: { gain: 1.0, from: 2400, to: 240, decay: 0.12 },
    tail: { gain: 0.35, frequency: 650, decay: 0.28 },
    reverb: 0.4,
    echo: 0.12,
    volume: 0.9,
  },
  pistol: {
    crack: { gain: 1.0, frequency: 3400, q: 1.2, decay: 0.014 },
    thump: { gain: 0.55, from: 240, to: 90, decay: 0.022 },
    body: { gain: 0.45, from: 4200, to: 800, decay: 0.04 },
    tail: { gain: 0.14, frequency: 1200, decay: 0.1 },
    reverb: 0.22,
    echo: 0,
    volume: 0.7,
  },
  sniper: {
    crack: { gain: 1.1, frequency: 2100, q: 0.8, decay: 0.026 },
    thump: { gain: 1.3, from: 100, to: 30, decay: 0.1 },
    body: { gain: 1.0, from: 2800, to: 180, decay: 0.16 },
    tail: { gain: 0.45, frequency: 520, decay: 0.5 },
    reverb: 0.5,
    echo: 0.4,
    volume: 1,
  },
};

/** Synthesizes every weapon and hit-feedback sound from noise and oscillators; no audio files. */
export class WeaponAudio {
  constructor(private readonly engine: AudioEngine) {}

  shot(id: WeaponId): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const r = SHOTS[id];
    const pitch = 1 + (Math.random() - 0.5) * 0.1;
    const now = ctx.currentTime;
    const voice = this.engine.voice("shot", now, r.tail.decay * 7, { gain: r.volume, reverb: r.reverb, echo: r.echo });
    if (!voice) return;
    const e = this.engine;
    const { crack, thump, body, tail } = r;
    e.noiseBurst(voice, now, {
      gain: crack.gain,
      filter: "bandpass",
      frequency: crack.frequency * pitch,
      q: crack.q,
      decay: crack.decay,
      rate: pitch,
    });
    e.tone(voice, now, {
      gain: thump.gain,
      frequency: thump.from * pitch,
      frequencyEnd: thump.to,
      sweep: thump.decay * 2,
      decay: thump.decay,
      attack: 0.001,
    });
    e.noiseBurst(voice, now, {
      gain: body.gain,
      filter: "lowpass",
      frequency: body.from * pitch,
      frequencyEnd: body.to,
      sweep: body.decay * 3,
      decay: body.decay,
      q: 0.5,
      rate: pitch * 0.8,
    });
    e.noiseBurst(voice, now + 0.01, {
      gain: tail.gain,
      filter: "lowpass",
      frequency: tail.frequency,
      decay: tail.decay,
      attack: 0.02,
      rate: 0.6,
    });
  }

  dryFire(): void {
    this.mechanical((voice, t) => {
      this.click(voice, t, 3200, 0.35);
      this.click(voice, t + 0.012, 1400, 0.2);
    });
  }

  equip(): void {
    this.mechanical((voice, t) => {
      // Cloth swish then a few rattles and a latch.
      this.scrape(voice, t, 0.18, 900, 2200, 0.12, 0.05);
      for (let i = 0; i < 3; i++) {
        this.click(voice, t + 0.05 + i * 0.045 + Math.random() * 0.02, 1100 + Math.random() * 1600, 0.16);
      }
      this.click(voice, t + 0.22, 2400, 0.3);
      this.click(voice, t + 0.228, 900, 0.22);
    });
  }

  /** Schedules the mechanical sounds of a reload plan, timed to its clips. */
  reloadStarted(plan: ClipPlan): void {
    this.schedule(plan, RELOAD_TAG);
  }

  reloadCancelled(): void {
    this.engine.stopTag(RELOAD_TAG);
  }

  /** Schedules the bolt or pump sounds that follow a shot; a new shot cuts off the previous cycle. */
  actionCycle(plan: ClipPlan): void {
    this.schedule(plan, CYCLE_TAG);
  }

  /** One confirm per frame: headshot ding beats a body tick; a kill adds its own chime. */
  hit(zone: HitZone, killed: boolean): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const now = ctx.currentTime;
    const voice = this.engine.voice("feedback", now, killed ? 0.6 : 0.4);
    if (!voice) return;
    const e = this.engine;
    if (zone === "head") {
      e.tone(voice, now, { gain: 0.32, frequency: 1760, decay: 0.12 });
      e.tone(voice, now, { gain: 0.18, frequency: 2640, decay: 0.09 });
      e.tone(voice, now, { gain: 0.08, frequency: 3960, decay: 0.05 });
    } else {
      e.tone(voice, now, { gain: 0.3, type: "triangle", frequency: 1500, frequencyEnd: 1100, sweep: 0.04, decay: 0.018 });
      e.noiseBurst(voice, now, { gain: 0.12, filter: "highpass", frequency: 4000, decay: 0.006 });
    }
    if (killed) {
      const t = now + 0.06;
      e.tone(voice, t, { gain: 0.24, type: "triangle", frequency: 880, decay: 0.07 });
      e.tone(voice, t + 0.07, { gain: 0.26, type: "triangle", frequency: 1320, decay: 0.12 });
      e.tone(voice, t, { gain: 0.35, frequency: 140, frequencyEnd: 55, sweep: 0.12, decay: 0.06 });
    }
  }

  /** Bullet hitting level geometry, attenuated by distance from the listener. */
  impact(distance: number, target: boolean): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const level = 1 / (1 + distance / 6);
    if (level < 0.06) return;
    const now = ctx.currentTime + Math.min(0.15, distance / 343);
    const voice = this.engine.voice("impact", now, 0.3, { gain: level, reverb: 0.15 });
    if (!voice) return;
    const e = this.engine;
    if (target) {
      e.noiseBurst(voice, now, { gain: 0.35, filter: "bandpass", frequency: 700, q: 1.2, decay: 0.03 });
      e.tone(voice, now, { gain: 0.25, frequency: 220, frequencyEnd: 90, sweep: 0.05, decay: 0.03 });
      return;
    }
    const frequency = 1200 + Math.random() * 1400;
    e.noiseBurst(voice, now, { gain: 0.35, filter: "bandpass", frequency, q: 1.5, decay: 0.02 });
    if (Math.random() < 0.18) {
      // Occasional ricochet whine.
      const from = 2600 + Math.random() * 1200;
      e.tone(voice, now + 0.01, {
        gain: 0.07,
        type: "triangle",
        frequency: from,
        frequencyEnd: from * 0.55,
        sweep: 0.22,
        attack: 0.01,
        decay: 0.07,
      });
    }
  }

  casingTink(distance: number): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const level = 0.5 / (1 + distance);
    const now = ctx.currentTime;
    const voice = this.engine.voice("impact", now, 0.15, { gain: level });
    if (!voice) return;
    const f = 4200 + Math.random() * 2400;
    this.engine.tone(voice, now, { gain: 0.14, frequency: f, decay: 0.03 });
    this.engine.tone(voice, now + 0.05, { gain: 0.06, frequency: f * 1.07, decay: 0.02 });
  }

  private schedule(plan: ClipPlan, tag: string): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    this.engine.stopTag(tag);
    const start = ctx.currentTime;
    for (const cue of plan.cues) this.cue(cue.kind, start + cue.at, tag, cue.span);
  }

  /** `span` is the duration of multi-part motions (pump, bolt) in seconds. */
  private cue(kind: MechanicalCueKind, t: number, tag: string, span: number): void {
    const voice = this.engine.voice("mechanical", t, span + 0.3, { tag, reverb: 0.08 });
    if (!voice) return;
    switch (kind) {
      case "magOut":
        this.click(voice, t, 1800, 0.3);
        this.scrape(voice, t + 0.01, 0.16, 1800, 700, 0.1, 0.04);
        this.click(voice, t + 0.09, 650, 0.18);
        break;
      case "magIn":
        this.scrape(voice, t - 0.05, 0.12, 900, 1600, 0.05, 0.02);
        this.click(voice, t, 900, 0.45);
        this.click(voice, t + 0.035, 2600, 0.38);
        break;
      case "shellInsert":
        this.click(voice, t, 1300, 0.3);
        this.click(voice, t + 0.03, 600, 0.22);
        break;
      case "pump":
        // "Chk" back (the clip snaps the pump back in two frames), "chk" forward home at the end of the span.
        this.scrape(voice, t, 0.2, 1400, 800, span * 0.12, 0.03);
        this.click(voice, t + span * 0.12, 1100, 0.45);
        this.scrape(voice, t + span * 0.6, 0.2, 900, 1500, span * 0.35, 0.025);
        this.click(voice, t + span, 1700, 0.5);
        this.click(voice, t + span + 0.005, 500, 0.3);
        break;
      case "boltOpen":
        this.click(voice, t, 2200, 0.3);
        this.scrape(voice, t + span * 0.43, 0.18, 1600, 900, span * 0.5, 0.04);
        this.click(voice, t + span, 1500, 0.32);
        break;
      case "boltClose":
        this.scrape(voice, t, 0.18, 900, 1700, span * 0.45, 0.035);
        this.click(voice, t + span * 0.5, 950, 0.45);
        this.click(voice, t + span * 0.5 + 0.005, 2500, 0.4);
        this.click(voice, t + span * 0.9, 1900, 0.25);
        break;
      case "slide":
        this.scrape(voice, t - 0.04, 0.14, 2000, 1100, 0.04, 0.015);
        this.click(voice, t, 2100, 0.45);
        this.click(voice, t + 0.004, 800, 0.3);
        break;
      case "charge":
        this.scrape(voice, t - 0.08, 0.15, 1500, 900, 0.07, 0.025);
        this.click(voice, t - 0.02, 1300, 0.25);
        this.click(voice, t + 0.03, 2300, 0.42);
        break;
    }
  }

  private mechanical(build: (voice: Voice, t: number) => void): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const t = ctx.currentTime;
    const voice = this.engine.voice("mechanical", t, 0.4, { reverb: 0.06 });
    if (voice) build(voice, t);
  }

  /** Metal sliding on metal: band-passed noise sweeping from `from` to `to` Hz over `sweep` seconds. */
  private scrape(voice: Voice, t: number, gain: number, from: number, to: number, sweep: number, decay: number): void {
    this.engine.noiseBurst(voice, t, { gain, filter: "bandpass", frequency: from, frequencyEnd: to, sweep, q: 0.9, attack: 0.01, decay });
  }

  /** Metallic click: a resonant noise tick plus a tiny pitched ping. */
  private click(voice: Voice, t: number, frequency: number, gain: number): void {
    this.engine.noiseBurst(voice, t, { gain, filter: "bandpass", frequency, q: 6, decay: 0.008 });
    this.engine.tone(voice, t, { gain: gain * 0.25, type: "square", frequency: frequency * 0.5, decay: 0.006 });
  }
}
