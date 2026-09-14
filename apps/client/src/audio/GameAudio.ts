import type { HitZone } from "@twobullets/shared";
import {
  AUDIBLE_RANGE,
  CULL_GAIN,
  airAbsorptionCutoff,
  arrivalDelay,
  clamp,
  distance,
  distanceGain,
  gunshotLayers,
  isSupersonic,
  type Vec3Like,
} from "./acoustics";
import { AudioEngine, Priority, setPannerPosition, type Voice, type VoiceOptions } from "./AudioEngine";
import type { SoundId } from "./audioManifest";
import type { AudioSettings } from "./AudioSettings";
import type { AudioWorldProbe } from "./AudioWorldProbe";
import { FOOTSTEP_SOUND, FOOTSTEP_TRIM, IMPACT_SOUND, LOCAL_MIX, STANCE, WEAPON_SOUNDS, firstPersonShot, type WeaponSound } from "./soundDesign";
import type { SoundBank } from "./SoundBank";
import type {
  ExplosionAudioEvent,
  FootstepAudioEvent,
  GunshotAudioEvent,
  HitConfirmAudioEvent,
  ImpactAudioEvent,
  JumpAudioEvent,
  LandingAudioEvent,
  MechanicalAudioEvent,
  NearMissAudioEvent,
} from "./types";

/** Occluded sources lose this much level and most of their highs. */
const OCCLUSION_GAIN = 0.45;
const OCCLUSION_CUTOFF = 900;
const FEET_LIFT = 0.6;
/**
 * Remote gunshots use the same per-weapon `level` as first person, lifted so the rifle sits where the spatial mix was
 * tuned (distance attenuation already keeps them well under the local player's own shots).
 */
const REMOTE_MAKEUP = 1.6;

interface Placement {
  readonly distance: number;
  readonly delay: number;
  readonly gain: number;
  readonly lowpass: number;
  readonly occluded: boolean;
}

/**
 * The game's audio vocabulary: one method per gameplay sound, taking plain event data so local simulation and network
 * events (netcode.md §10) drive it the same way. Handles distance, speed of sound, air absorption, occlusion,
 * environment sends and ducking; the engine handles voices and buses.
 */
export class GameAudio {
  private readonly listener = { x: 0, y: 0, z: 0 };
  private readonly forward = { x: 0, y: 0, z: 1 };

  constructor(
    readonly engine: AudioEngine,
    readonly bank: SoundBank,
    readonly probe: AudioWorldProbe,
    readonly settings: AudioSettings,
  ) {}

  get listenerPosition(): Vec3Like {
    return this.listener;
  }

  get listenerForward(): Vec3Like {
    return this.forward;
  }

  /** Once per frame after the camera moved. */
  setListener(position: Vec3Like, forward: Vec3Like, up: Vec3Like): void {
    this.listener.x = position.x;
    this.listener.y = position.y;
    this.listener.z = position.z;
    this.forward.x = forward.x;
    this.forward.y = forward.y;
    this.forward.z = forward.z;
    this.engine.setListener(position, forward, up);
  }

  // --- Weapons -------------------------------------------------------------------------------------------------------

  playGunshot(event: GunshotAudioEvent): void {
    const design = WEAPON_SOUNDS[event.weaponId];
    const ctx = this.engine.live;
    if (!ctx) return;
    const now = ctx.currentTime;
    const indoor = this.probe.enclosure;

    if (event.shooterIsLocal) {
      this.playFirstPersonShot(design, event.suppressed === true, indoor, now);
      return;
    }

    const range = event.suppressed ? AUDIBLE_RANGE.suppressedShot : design.range;
    const place = this.place(event.position, design.reference, range, design.rolloff, event.age);
    if (!place) return;
    const layers = gunshotLayers(place.distance);
    const voice = this.engine.voice({
      bus: "weapons",
      priority: Priority.important,
      label: design.far,
      position: event.position,
      gain: Math.min(1, place.gain * design.level * REMOTE_MAKEUP) * (event.suppressed ? 0.35 : 1),
      lowpass: event.suppressed ? Math.min(place.lowpass, 2500) : place.lowpass,
      room: 0.3 * indoor,
      echo: event.suppressed ? 0.05 : layers.echo * design.echo * (place.occluded ? 1.3 : 1),
      distance: place.distance,
      occluded: place.occluded,
      route: design.bypassGlue ? "direct" : "bus",
    });
    if (!voice) return;
    const when = now + place.delay;
    const rate = 1 + (Math.random() - 0.5) * 0.05;
    if (layers.near > 0.02) this.layer(voice, design.near, { when, rate, gain: layers.near });
    if (event.suppressed || layers.far <= 0.02) return;
    this.layer(voice, design.far, { when, rate: rate * layers.farRate, gain: layers.far * design.farBoost });
    if (design.farSub > 0 && layers.far > 0.3) {
      // Distant heavy report: the boom that rolls in under the down-range take.
      voice.addTone({ when: when + 0.01, gain: design.farSub * layers.far, frequency: 64 * layers.farRate, frequencyEnd: 36, sweep: 0.35, attack: 0.012, decay: 0.2 });
    }
  }

  /** Stereo, non-spatial layers from the weaponMix recipe, with slight per-shot pitch and level variation. */
  private playFirstPersonShot(design: WeaponSound, suppressed: boolean, indoor: number, now: number): void {
    const voice = this.engine.voice({
      bus: "weapons",
      priority: Priority.local,
      label: design.near,
      room: 0.35 * indoor,
      echo: (suppressed ? 0.1 : design.fp.echo) * (1 - indoor),
      route: "direct",
    });
    if (!voice) return;
    const rate = 1 + (Math.random() - 0.5) * 0.06;
    // Downward-only level variation (−0.6…0 dB) keeps the loudest shot under the limiter.
    const variation = (0.93 + Math.random() * 0.07) * (suppressed ? 0.3 : 1);
    for (const layer of firstPersonShot(design)) {
      const when = now + layer.delay;
      if (layer.kind === "sub") {
        voice.addTone({ when, gain: layer.gain * variation, frequency: layer.from * rate, frequencyEnd: layer.to, sweep: layer.sweep, attack: 0.002, decay: layer.decay });
        continue;
      }
      // Suppressed: keep only the (muffled) report and the mechanism.
      if (suppressed && layer.sound !== design.near && layer.sound !== "mech.dryFire") continue;
      const lowpass = suppressed && layer.sound === design.near ? 3000 : (layer.lowpass ?? undefined);
      const layerRate = layer.sound === "mech.dryFire" ? layer.rate + Math.random() * 0.1 : layer.rate * rate;
      this.layer(voice, layer.sound, { when, rate: layerRate, gain: layer.gain * variation, offset: layer.offset, lowpass });
    }
    const scale = suppressed ? 0.4 : 1;
    const { ambience, weapons, footsteps } = design.duck;
    this.duckAmbience(ambience.db * scale, ambience.hold, ambience.release);
    this.engine.duck("weapons", weapons.db * scale, weapons.hold, weapons.release);
    this.engine.duck("footsteps", footsteps.db * scale, footsteps.hold, footsteps.release);
  }

  /** Bullet passing the listener: supersonic crack or subsonic whiz, moving along the trajectory. */
  playNearMiss(event: NearMissAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const d = distance(event.position, this.listener);
    if (d > 4) return;
    const { x: vx, y: vy, z: vz } = event.velocity;
    const speed = Math.hypot(vx, vy, vz);
    const closeness = clamp(1 - d / 4, 0, 1);
    const now = ctx.currentTime;
    const voice = this.engine.voice({
      bus: "weapons",
      priority: Priority.important,
      label: isSupersonic(speed) ? "nearMiss.crack" : "nearMiss.whiz",
      position: event.position,
      gain: 0.35 + 0.65 * closeness,
      distance: d,
    });
    if (!voice) return;
    if (isSupersonic(speed)) {
      // Sonic boom: a sharp N-wave snap plus a short zip, then a bit of room/ground slap.
      voice.addNoise({ when: now, gain: 1.1, filter: "highpass", frequency: 2200, decay: 0.004 });
      voice.addNoise({ when: now, gain: 0.7, filter: "bandpass", frequency: 3200, q: 0.8, decay: 0.012 });
      voice.addTone({ when: now, gain: 0.5, type: "triangle", frequency: 1400, frequencyEnd: 500, sweep: 0.02, decay: 0.008 });
      voice.addNoise({ when: now + 0.018, gain: 0.25, filter: "lowpass", frequency: 1800, decay: 0.05 });
      this.duckAmbience(6, 0.1, 0.6);
    } else {
      // Whiz: band-passed noise sweeping down (Doppler) while the source moves past the head.
      const sweep = 0.28;
      voice.addNoise({ when: now, gain: 0.8, attack: sweep * 0.45, filter: "bandpass", q: 3, frequency: 2600, frequencyEnd: 700, sweep, decay: 0.05 });
      if (voice.panner && speed > 0) {
        // Sweep the source ±4 m along the trajectory: perceptually a fly-by, even though the bullet is far faster.
        const k = 4 / speed;
        const p = event.position;
        setPannerPosition(voice.panner, { x: p.x - vx * k, y: p.y - vy * k, z: p.z - vz * k }, now);
        rampPanner(voice.panner, { x: p.x + vx * k, y: p.y + vy * k, z: p.z + vz * k }, now + sweep);
      }
    }
  }

  /** Weapon handling: first person when `position` is null, otherwise spatial (remote reloads, 12 m). */
  playMechanical(event: MechanicalAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const when = ctx.currentTime + (event.delay ?? 0);
    const span = event.span ?? 0.1;
    let options: VoiceOptions;
    if (event.position) {
      const place = this.place(event.position, 1.5, AUDIBLE_RANGE.reload, 1, 0);
      if (!place) return;
      options = { bus: "foley", priority: Priority.normal, label: `mech.${event.kind}`, position: event.position, gain: place.gain, lowpass: place.lowpass, distance: place.distance, tag: event.tag };
    } else {
      options = { bus: "foley", priority: Priority.local, label: `mech.${event.kind}`, gain: LOCAL_MIX.mechanical, room: 0.15 * this.probe.enclosure, tag: event.tag };
    }
    const voice = this.engine.voice(options);
    if (!voice) return;
    const id = event.weaponId;
    const jitter = () => 0.97 + Math.random() * 0.06;
    switch (event.kind) {
      case "magOut":
        this.layer(voice, id === "pistol" ? "mech.pistol.magOut" : "mech.rifle.magOut", { when, rate: (id === "sniper" ? 0.9 : 1) * jitter() });
        break;
      case "magIn":
        this.layer(voice, id === "pistol" ? "mech.pistol.magIn" : "mech.rifle.magIn", { when: when - 0.03, rate: (id === "sniper" ? 0.9 : 1) * jitter() });
        break;
      case "shellInsert":
        this.layer(voice, "mech.shotgun.shell", { when: when - 0.05, rate: jitter() });
        break;
      case "pump":
        // The rack recording's main transient lands ~90 ms in; line it up with the pump snapping back.
        this.layer(voice, "mech.shotgun.pump", { when: Math.max(ctx.currentTime, when - 0.03), rate: jitter() });
        break;
      case "boltOpen":
        this.layer(voice, "mech.bolt.open", { when, rate: jitter() });
        this.layer(voice, "mech.bolt.open", { when: when + span * 0.8, rate: 0.9 * jitter(), gain: 0.6 });
        break;
      case "boltClose":
        this.layer(voice, "mech.bolt.close", { when, rate: jitter(), gain: 0.7 });
        this.layer(voice, "mech.bolt.close", { when: when + span * 0.5, rate: 1.05 * jitter() });
        break;
      case "slide":
        this.layer(voice, id === "pistol" ? "mech.pistol.slide" : "mech.charge", { when: when - 0.04, rate: jitter() });
        break;
      case "charge":
        this.layer(voice, "mech.charge", { when: when - 0.07, rate: 1.1 * jitter(), gain: 0.7 });
        this.layer(voice, "mech.charge", { when, rate: jitter() });
        break;
      case "dryFire":
        this.layer(voice, "mech.dryFire", { when, rate: jitter() });
        break;
      case "equip":
        this.layer(voice, "foley.cloth", { when, rate: jitter(), gain: 0.8 });
        this.layer(voice, "mech.latch", { when: when + 0.2, rate: jitter(), gain: 0.8 });
        break;
    }
  }

  playCasing(position: Vec3Like, rate: number, lowpass: number): void {
    const place = this.place(position, 1, 15, 1, 0);
    const ctx = this.engine.live;
    if (!place || !ctx) return;
    const voice = this.engine.voice({
      bus: "foley",
      priority: Priority.detail,
      label: "foley.casing",
      position,
      panning: "equalpower",
      gain: LOCAL_MIX.casing * place.gain,
      lowpass: Math.min(lowpass, place.lowpass),
      distance: place.distance,
    });
    if (voice) this.layer(voice, "foley.casing", { when: ctx.currentTime, rate: rate * (0.92 + Math.random() * 0.16) });
  }

  // --- Movement ------------------------------------------------------------------------------------------------------

  playFootstep(event: FootstepAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const stance = STANCE[event.stance];
    const surface = event.surface ?? this.probe.surfaceBelow(event.position);
    const level = stance.gain * FOOTSTEP_TRIM[surface];
    const rate = stance.rate * (0.94 + Math.random() * 0.12);
    const id = FOOTSTEP_SOUND[surface];
    if (event.isLocal) {
      const voice = this.engine.voice({ bus: "footsteps", priority: Priority.local, label: id, gain: level * LOCAL_MIX.footstep, room: 0.2 * this.probe.enclosure });
      if (voice) this.layer(voice, id, { when: ctx.currentTime, rate });
      return;
    }
    const place = this.place(event.position, 2, stance.range, 1.1, 0, FEET_LIFT);
    if (!place) return;
    const voice = this.engine.voice({
      bus: "footsteps",
      priority: Priority.important,
      label: id,
      position: event.position,
      gain: level * place.gain,
      lowpass: place.lowpass,
      room: 0.2 * this.probe.enclosure,
      distance: place.distance,
      occluded: place.occluded,
    });
    if (voice) this.layer(voice, id, { when: ctx.currentTime + place.delay, rate });
  }

  playLanding(event: LandingAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const impact = clamp((event.fallSpeed - 2) / 12, 0.15, 1);
    const surface = event.surface ?? this.probe.surfaceBelow(event.position);
    const voice = event.isLocal
      ? this.engine.voice({ bus: "footsteps", priority: Priority.local, label: "foley.land", gain: LOCAL_MIX.landing * impact })
      : this.spatialVoice("footsteps", "foley.land", event.position, 2, AUDIBLE_RANGE.landing, impact);
    if (!voice) return;
    const now = ctx.currentTime + (event.isLocal ? 0 : arrivalDelay(distance(event.position, this.listener)));
    this.layer(voice, "foley.land", { when: now, rate: 0.9 + Math.random() * 0.1 });
    this.layer(voice, FOOTSTEP_SOUND[surface], { when: now, rate: 0.92, gain: 0.8 * FOOTSTEP_TRIM[surface] });
    this.layer(voice, FOOTSTEP_SOUND[surface], { when: now + 0.07, rate: 1.02, gain: 0.5 * FOOTSTEP_TRIM[surface] });
  }

  playJump(event: JumpAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const surface = event.surface ?? this.probe.surfaceBelow(event.position);
    const voice = event.isLocal
      ? this.engine.voice({ bus: "footsteps", priority: Priority.local, label: "foley.jump", gain: LOCAL_MIX.jump })
      : this.spatialVoice("footsteps", "foley.jump", event.position, 2, AUDIBLE_RANGE.footstepRun, 0.6);
    if (!voice) return;
    const now = ctx.currentTime;
    this.layer(voice, FOOTSTEP_SOUND[surface], { when: now, rate: 1.05, gain: FOOTSTEP_TRIM[surface] });
    this.layer(voice, "foley.cloth", { when: now + 0.02, rate: 1.1, gain: 0.7 });
  }

  // --- Impacts and explosions ----------------------------------------------------------------------------------------

  playImpact(event: ImpactAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const surface = event.surface ?? this.probe.surfaceAtImpact(event.position, event.normal);
    const place = this.place(event.position, 3, AUDIBLE_RANGE.impact, 1, event.age);
    if (!place) return;
    const heavy = event.weaponId === "sniper" ? 1.25 : event.weaponId === "shotgun" ? 0.6 : 1;
    const voice = this.engine.voice({
      bus: "impacts",
      priority: Priority.normal,
      label: IMPACT_SOUND[surface],
      position: event.position,
      panning: place.distance < 20 ? "HRTF" : "equalpower",
      gain: place.gain * heavy,
      lowpass: place.lowpass,
      room: 0.25 * this.probe.enclosure,
      echo: 0.08,
      distance: place.distance,
      occluded: place.occluded,
    });
    if (!voice) return;
    const when = ctx.currentTime + place.delay;
    this.layer(voice, IMPACT_SOUND[surface], { when, rate: 0.9 + Math.random() * 0.2 });
    if ((surface === "concrete" || surface === "metal") && Math.random() < 0.15) {
      // Occasional ricochet whine.
      const from = 2600 + Math.random() * 1400;
      voice.addTone({ when: when + 0.01, gain: 0.08, type: "triangle", frequency: from, frequencyEnd: from * 0.55, sweep: 0.25, attack: 0.01, decay: 0.08 });
      voice.addNoise({ when: when + 0.01, gain: 0.12, filter: "bandpass", frequency: from, frequencyEnd: from * 0.5, sweep: 0.25, q: 6, decay: 0.08 });
    }
  }

  /** Placeholder explosion until grenades have recorded assets: pitched-down shotgun reports plus a noise rumble. */
  playExplosion(event: ExplosionAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const power = event.power ?? 1;
    const place = this.place(event.position, 10, AUDIBLE_RANGE.explosion * Math.sqrt(power), 0.8, event.age);
    if (!place) return;
    const voice = this.engine.voice({
      bus: "weapons",
      priority: Priority.important,
      label: "explosion",
      position: event.position,
      gain: Math.min(1.4, place.gain * power),
      lowpass: place.lowpass,
      room: 0.5 * this.probe.enclosure,
      echo: 0.9,
      distance: place.distance,
      occluded: place.occluded,
    });
    if (!voice) return;
    const when = ctx.currentTime + place.delay;
    const close = 1 - clamp(place.distance / 60, 0, 1);
    this.layer(voice, "shot.shotgun.far", { when, rate: 0.42, gain: 1 });
    this.layer(voice, "shot.sniper.far", { when: when + 0.01, rate: 0.55, gain: 0.7 });
    if (close > 0) this.layer(voice, "shot.shotgun.near", { when, rate: 0.5, gain: 0.9 * close });
    voice.addNoise({ when, gain: 1.2, attack: 0.005, filter: "lowpass", frequency: 600, frequencyEnd: 90, sweep: 1.2, decay: 0.45, rate: 0.5 });
    voice.addTone({ when, gain: 0.9 * (0.3 + close), frequency: 70, frequencyEnd: 28, sweep: 0.6, decay: 0.25 });
    const depth = 6 + 10 * clamp(1 - place.distance / 150, 0, 1);
    this.duckAmbience(depth + 4, 0.8, 2);
    this.engine.duck("footsteps", depth, 0.5, 1.5);
    this.engine.duck("impacts", depth * 0.6, 0.3, 1);
  }

  // --- UI -------------------------------------------------------------------------------------------------------------

  /** Shooter-side hit confirmation: a dull body thud, a helmet-like tink for headshots, a low thump on a kill. */
  playHitConfirm(event: HitConfirmAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const now = ctx.currentTime;
    const voice = this.engine.voice({ bus: "ui", priority: Priority.local, label: `ui.hit.${event.zone}${event.killed ? ".kill" : ""}` });
    if (!voice) return;
    const zone: HitZone = event.zone;
    this.layer(voice, "impact.flesh", { when: now, rate: 1.15 + Math.random() * 0.1, gain: 0.45, lowpass: 5000 });
    voice.addNoise({ when: now, gain: 0.08, filter: "highpass", frequency: 5000, decay: 0.005 });
    if (zone === "head") {
      this.layer(voice, "step.metal", { when: now + 0.005, rate: 1.6, gain: 0.35 });
      voice.addTone({ when: now, gain: 0.07, frequency: 2400, decay: 0.06 });
    }
    if (event.killed) {
      const t = now + 0.07;
      voice.addTone({ when: t, gain: 0.3, frequency: 120, frequencyEnd: 50, sweep: 0.15, decay: 0.08 });
      voice.addTone({ when: t, gain: 0.06, type: "triangle", frequency: 660, decay: 0.12 });
      this.layer(voice, "impact.flesh", { when: t, rate: 0.7, gain: 0.35 });
    }
  }

  // --- Helpers ---------------------------------------------------------------------------------------------------------

  /** Distance, arrival delay, attenuation, air absorption and occlusion for a world source; null when inaudible. */
  /** `lift` raises the occlusion target (feet sit on the floor the ray would otherwise graze). */
  private place(position: Vec3Like, reference: number, range: number, rolloff: number, age = 0, lift = 0): Placement | null {
    const d = distance(position, this.listener);
    let gain = distanceGain(d, reference, range, rolloff);
    if (gain < CULL_GAIN) return null;
    let lowpass = airAbsorptionCutoff(d);
    const occluded = this.probe.isOccluded(this.listener, lift === 0 ? position : { x: position.x, y: position.y + lift, z: position.z });
    if (occluded) {
      gain *= OCCLUSION_GAIN;
      lowpass = Math.min(lowpass, OCCLUSION_CUTOFF);
    }
    return { distance: d, delay: arrivalDelay(d, age), gain, lowpass, occluded };
  }

  private duckAmbience(db: number, hold: number, release: number): void {
    if (this.settings.ambienceEnabled) this.engine.duck("ambience", db, hold, release);
  }

  private spatialVoice(bus: "footsteps", label: string, position: Vec3Like, reference: number, range: number, level: number): Voice | null {
    const place = this.place(position, reference, range, 1, 0, FEET_LIFT);
    if (!place) return null;
    return this.engine.voice({ bus, priority: Priority.important, label, position, gain: level * place.gain, lowpass: place.lowpass, distance: place.distance, occluded: place.occluded });
  }

  private layer(voice: Voice, id: SoundId, options: Parameters<Voice["addBuffer"]>[1]): void {
    const buffer = this.bank.pick(id);
    if (buffer) voice.addBuffer(buffer, options);
  }
}

function rampPanner(panner: PannerNode, p: Vec3Like, when: number): void {
  if (!panner.positionX) return;
  panner.positionX.linearRampToValueAtTime(p.x, when);
  panner.positionY.linearRampToValueAtTime(p.y, when);
  panner.positionZ.linearRampToValueAtTime(-p.z, when);
}
