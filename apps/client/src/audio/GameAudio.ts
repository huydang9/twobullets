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
import { AudioEngine, BUSES, Priority, setPannerPosition, type Voice, type VoiceOptions } from "./AudioEngine";
import type { SoundId } from "./audioManifest";
import type { AudioSettings } from "./AudioSettings";
import type { AudioWorldProbe } from "./AudioWorldProbe";
import {
  BLAST_SOUNDS,
  DEBRIS_RANGE,
  LOOP_RANGE,
  LOOP_VOICES,
  USE_CUES,
  blastDuckDb,
  blastEcho,
  blastLayers,
  flashRing,
  type MixLayer,
} from "./equipmentMix";
import { addCrackle, addUseCue, addZip, createHissBuffer } from "./equipment/foley";
import { FOOTSTEP_SOUND, FOOTSTEP_TRIM, IMPACT_SOUND, LOCAL_MIX, STANCE, WEAPON_SOUNDS, firstPersonShot, type WeaponSound } from "./soundDesign";
import type { SoundBank } from "./SoundBank";
import type {
  AreaStartAudioEvent,
  ArmorHitAudioEvent,
  AudioBusId,
  ExplosionAudioEvent,
  FootstepAudioEvent,
  FragCalloutAudioEvent,
  GunshotAudioEvent,
  HitConfirmAudioEvent,
  ImpactAudioEvent,
  ItemUseAudioEvent,
  JumpAudioEvent,
  LandingAudioEvent,
  MechanicalAudioEvent,
  NearMissAudioEvent,
  PickupAudioKind,
  ThrowableBounceAudioEvent,
  ThrowActionAudioEvent,
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
/** Bullet-into-flesh shaping per hit zone (the spatial impact the world hears, not the shooter's hit-confirm tick). */
const FLESH_ZONE: Readonly<Record<HitZone, { gain: number; rate: number; snap: number }>> = {
  head: { gain: 1, rate: 1.2, snap: 0.14 },
  body: { gain: 0.85, rate: 1, snap: 0 },
  limb: { gain: 0.7, rate: 1.08, snap: 0 },
};

/** Pitch of the canister body per throwable (a smoke can is bigger and duller). */
const BOUNCE_RATE: Readonly<Record<ThrowableBounceAudioEvent["kind"], number>> = { frag: 1, smoke: 0.82, flash: 1.12, molotov: 1.3 };
const AREA_UPDATE_SECONDS = 0.1;
/** Frag-out shout: a raised voice, clear to ~15 m, gone by 45 m. */
const FRAG_CALLOUT = { localGain: 0.7, remoteGain: 1, reference: 4, range: 45, rolloff: 1 } as const;
/** Results clip: above every other UI voice so hit confirms and stings never steal it. */
const MATCH_END_MUSIC = { gain: 0.8, fadeOut: 0.4, lateStartMs: 4000, priority: Priority.local + 1 } as const;

interface AreaLoop {
  readonly kind: "smoke" | "fire";
  readonly position: { x: number; y: number; z: number };
  level: number;
  voice: Voice | null;
}

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
  private readonly areas = new Map<number, AreaLoop>();
  private areaTimer = 0;
  private hiss: AudioBuffer | null = null;
  private readonly callouts = new Map<FragCalloutAudioEvent["thrower"], Voice>();
  private music: Voice | null = null;
  private musicRequest = 0;

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
    const flesh = surface === "flesh" ? FLESH_ZONE[event.zone ?? "body"] : null;
    const voice = this.engine.voice({
      bus: "impacts",
      priority: Priority.normal,
      label: IMPACT_SOUND[surface],
      position: event.position,
      panning: place.distance < 20 ? "HRTF" : "equalpower",
      gain: place.gain * heavy * (flesh?.gain ?? 1),
      lowpass: place.lowpass,
      room: 0.25 * this.probe.enclosure,
      echo: 0.08,
      distance: place.distance,
      occluded: place.occluded,
    });
    if (!voice) return;
    const when = ctx.currentTime + place.delay;
    this.layer(voice, IMPACT_SOUND[surface], { when, rate: (flesh?.rate ?? 1) * (0.9 + Math.random() * 0.2) });
    if (flesh && flesh.snap > 0) {
      // Short bright transient on top of the thud: the wetter, harder crack of a head hit.
      voice.addNoise({ when, gain: flesh.snap, filter: "highpass", frequency: 3200, decay: 0.012 });
    }
    if ((surface === "concrete" || surface === "metal") && Math.random() < 0.15) {
      // Occasional ricochet whine.
      const from = 2600 + Math.random() * 1400;
      voice.addTone({ when: when + 0.01, gain: 0.08, type: "triangle", frequency: from, frequencyEnd: from * 0.55, sweep: 0.25, attack: 0.01, decay: 0.08 });
      voice.addNoise({ when: when + 0.01, gain: 0.12, filter: "bandpass", frequency: from, frequencyEnd: from * 0.5, sweep: 0.25, q: 6, decay: 0.08 });
    }
  }

  /**
   * Frag or flashbang detonation: close bang and body crossfading into the down-range take, pressure sub, dirt and
   * debris raining down, echo growing with distance, speed-of-sound delay, and ducking scaled by distance.
   */
  playExplosion(event: ExplosionAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const design = BLAST_SOUNDS[event.kind ?? "frag"];
    const power = event.power ?? 1;
    const place = this.place(event.position, design.reference, design.range * Math.sqrt(power), design.rolloff, event.age);
    if (!place) return;
    const d = place.distance;
    const voice = this.engine.voice({
      bus: "weapons",
      priority: Priority.important,
      label: design.near,
      position: event.position,
      panning: d < 60 ? "HRTF" : "equalpower",
      gain: Math.min(1, place.gain * power),
      lowpass: place.lowpass,
      room: 0.5 * this.probe.enclosure,
      echo: blastEcho(design, d) * (place.occluded ? 1.3 : 1),
      distance: d,
      occluded: place.occluded,
      // Keep the transient of anything close; far blasts glue with the rest of the gunfire.
      route: d < 80 ? "direct" : "bus",
    });
    if (!voice) return;
    const when = ctx.currentTime + place.delay;
    const rate = 1 + (Math.random() - 0.5) * 0.08;
    this.playLayers(voice, blastLayers(design, d), when, rate, 1);
    const close = 1 - clamp(d / 60, 0, 1);
    if (event.kind === "flash") {
      // The flashbang's magnesium crack: a very short, bright snap on top.
      voice.addNoise({ when, gain: 0.35 * close, filter: "highpass", frequency: 3000, decay: 0.012 });
    } else {
      voice.addNoise({ when, gain: 0.25 * (0.3 + close), attack: 0.004, filter: "lowpass", frequency: 500, frequencyEnd: 70, sweep: 1.4, decay: 0.5, rate: 0.5 });
      if (design.debris && d < DEBRIS_RANGE) this.playDebris(event.position, when, 1 - d / DEBRIS_RANGE);
    }

    const depth = blastDuckDb(design, d) * Math.min(1, power);
    if (depth > 0.5) {
      this.duckAmbience(depth + 4, 0.6, 2.4);
      for (const bus of ["footsteps", "impacts", "foley", "weapons"] as const) this.engine.duck(bus, depth * (bus === "weapons" ? 0.5 : 1), 0.4, 1.8);
    }
    // Overpressure up close: the world goes dull for a moment, and a frag within a few metres leaves the ears ringing.
    if (event.kind !== "flash" && d < 14) {
      // The attack lets the blast transient through before the ears shut down.
      this.engine.muffle(700 + 160 * d, 0.08, 0.25, 1.6, place.delay);
      if (d < 5) this.playFlashRing({ strength: 0.35 * (1 - d / 5), seconds: 2.5, delay: place.delay });
    }
  }

  playThrowableBounce(event: ThrowableBounceAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx || event.impactSpeed < 0.4) return;
    const surface = event.surface ?? this.probe.surfaceAtImpact(event.position, event.normal);
    const place = this.place(event.position, 2, AUDIBLE_RANGE.throwableBounce, 1, 0, 0.3);
    if (!place) return;
    const force = clamp(event.impactSpeed / 9, 0.1, 1);
    const voice = this.engine.voice({
      bus: "impacts",
      priority: Priority.normal,
      label: "throw.bounce",
      position: event.position,
      gain: place.gain * (0.35 + 0.65 * force),
      lowpass: place.lowpass,
      room: 0.2 * this.probe.enclosure,
      distance: place.distance,
      occluded: place.occluded,
    });
    if (!voice) return;
    const when = ctx.currentTime + place.delay;
    const jitter = 0.94 + Math.random() * 0.12;
    const soft = surface === "grass" || surface === "dirt";
    const body = BOUNCE_RATE[event.kind] * jitter;
    if (soft) {
      this.layer(voice, "impact.dirt", { when, rate: 0.85 * jitter, gain: 0.7 });
      this.layer(voice, "throw.bounce", { when, rate: body * 0.9, gain: 0.25, lowpass: 1800 });
    } else {
      this.layer(voice, "throw.bounce", { when, rate: body * (surface === "wood" ? 0.85 : surface === "metal" ? 1.12 : 1) });
      this.layer(voice, FOOTSTEP_SOUND[surface], { when, rate: 1.15 * jitter, gain: 0.45 * FOOTSTEP_TRIM[surface] });
    }
  }

  playThrowAction(event: ThrowActionAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const range = event.action === "throw" ? 15 : AUDIBLE_RANGE.pinPull;
    const voice = this.foleyVoice(`throw.${event.action}`, event.position, range, LOCAL_MIX.mechanical);
    if (!voice) return;
    const when = ctx.currentTime;
    const jitter = () => 0.95 + Math.random() * 0.1;
    const molotov = event.kind === "molotov";
    switch (event.action) {
      case "draw":
        this.layer(voice, "foley.cloth", { when, rate: jitter(), gain: 0.7 });
        break;
      case "pinPull":
        if (molotov) {
          // Lighting the rag: a flint strike and the flame catching.
          this.layer(voice, "mech.latch", { when, rate: 1.5 * jitter(), gain: 0.5 });
          voice.addNoise({ when: when + 0.08, gain: 0.25, attack: 0.05, filter: "bandpass", q: 0.8, frequency: 900, frequencyEnd: 2400, sweep: 0.3, decay: 0.25 });
        } else {
          this.layer(voice, "throw.pin", { when, rate: jitter() });
          this.layer(voice, "mech.latch", { when: when + 0.03, rate: 1.3 * jitter(), gain: 0.45 });
        }
        break;
      case "spoon":
        this.layer(voice, "throw.spoon", { when, rate: jitter(), gain: 0.8 });
        break;
      case "throw": {
        const underhand = event.style === "underhand";
        this.layer(voice, "throw.swish", { when, rate: (underhand ? 1.2 : 0.9) * jitter(), gain: underhand ? 0.55 : 1 });
        this.layer(voice, "foley.cloth", { when: when + 0.02, rate: jitter(), gain: 0.5 });
        // The spoon flies off as the grenade leaves the hand (a cooked frag already let it go).
        if (!molotov && event.kind !== "frag") this.layer(voice, "throw.spoon", { when: when + 0.06, rate: 1.1 * jitter(), gain: 0.5 });
        break;
      }
      case "pinReturn":
        this.layer(voice, "mech.latch", { when, rate: 1.2 * jitter(), gain: 0.6 });
        break;
      case "holster":
        this.layer(voice, "foley.cloth", { when, rate: 0.9 * jitter(), gain: 0.6 });
        break;
    }
  }

  /** Smoke canister igniting: a dull pop and the first burst of gas (the hiss loop follows via {@link playSmokeHiss}). */
  playSmokePop(event: AreaStartAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const voice = this.spatialOneShot("impacts", "smoke.burst", event, 4, AUDIBLE_RANGE.smokePop, 0.8, 0.35);
    if (!voice) return;
    const when = voice.createdAt + (voice.options.distance !== undefined ? arrivalDelay(voice.options.distance, event.age) : 0);
    voice.addTone({ when, gain: 0.45, frequency: 150, frequencyEnd: 60, sweep: 0.08, decay: 0.05 });
    voice.addNoise({ when, gain: 0.35, filter: "lowpass", frequency: 1200, decay: 0.04 });
    this.layer(voice, "smoke.burst", { when: when + 0.03, rate: 0.9 + Math.random() * 0.1 });
  }

  /** Molotov bursting: glass shattering and the whoosh of the fuel catching. */
  playMolotovShatter(event: AreaStartAudioEvent): void {
    const voice = this.spatialOneShot("impacts", "molotov.shatter", event, 4, AUDIBLE_RANGE.molotov, 0.7, 0.4);
    if (!voice) return;
    const when = voice.createdAt + (voice.options.distance !== undefined ? arrivalDelay(voice.options.distance, event.age) : 0);
    this.layer(voice, "molotov.shatter", { when, rate: 0.95 + Math.random() * 0.1 });
    this.layer(voice, "throw.swish", { when: when + 0.06, rate: 0.45, gain: 0.9, lowpass: 1500 });
    voice.addNoise({ when: when + 0.05, gain: 0.7, attack: 0.1, filter: "bandpass", q: 0.7, frequency: 250, frequencyEnd: 1400, sweep: 0.35, decay: 0.3 });
    voice.addTone({ when: when + 0.05, gain: 0.25, frequency: 90, frequencyEnd: 45, sweep: 0.3, decay: 0.2 });
  }

  // --- Area loops (smoke hiss, fire crackle) ---------------------------------------------------------------------------

  /** Starts or moves a smoke hiss loop; `level` 0..1 follows the canister (equipmentMix.smokeHissLevel). */
  playSmokeHiss(areaId: number, position: Vec3Like, level = 1): void {
    this.setArea(areaId, "smoke", position, level);
  }

  /** Starts or moves a fire crackle loop; `level` 0..1 follows how much of the patch still burns. */
  playFire(areaId: number, position: Vec3Like, level = 1): void {
    this.setArea(areaId, "fire", position, level);
  }

  stopArea(areaId: number): void {
    const area = this.areas.get(areaId);
    if (!area) return;
    area.voice?.stop(area.kind === "fire" ? 1.2 : 0.8);
    this.areas.delete(areaId);
  }

  /**
   * Per frame: follows the listener (distance, occlusion) at 10 Hz and keeps only the nearest LOOP_VOICES loops of each
   * kind playing, so a street full of fire costs a handful of voices.
   */
  updateAreas(dt: number): void {
    const ctx = this.engine.live;
    this.areaTimer -= dt;
    if (!ctx || this.areas.size === 0 || this.areaTimer > 0) return;
    this.areaTimer = AREA_UPDATE_SECONDS;
    const sorted = [...this.areas.values()].sort((a, b) => distance(a.position, this.listener) - distance(b.position, this.listener));
    const slots = { smoke: LOOP_VOICES.smoke, fire: LOOP_VOICES.fire };
    for (const area of sorted) {
      const place = area.level > 0.01 ? this.place(area.position, 2.5, LOOP_RANGE[area.kind], 1, 0, 0.5) : null;
      if (!place || slots[area.kind] <= 0) {
        area.voice?.stop(0.5);
        area.voice = null;
        continue;
      }
      slots[area.kind]--;
      const gain = place.gain * area.level;
      if (!area.voice || area.voice.end < ctx.currentTime) {
        area.voice = this.startLoop(area, gain, place.lowpass);
        continue;
      }
      area.voice.setGain(gain, 0.15);
      area.voice.setLowpass(place.lowpass, 0.15);
      if (area.voice.panner) setPannerPosition(area.voice.panner, area.position, ctx.currentTime);
      if (area.kind === "fire" && Math.random() < 0.6) addCrackle(area.voice, ctx.currentTime, AREA_UPDATE_SECONDS);
    }
  }

  // --- Flashbang, consumables, armor -----------------------------------------------------------------------------------

  /**
   * Ear ringing after a flashbang (or a very close frag): a high whistle that fades over `seconds`, while every other
   * bus is ducked by the exposure strength and the whole mix is low-passed, recovering as the ringing fades.
   */
  playFlashRing(event: { readonly strength: number; readonly seconds?: number; readonly delay?: number }): void {
    const ctx = this.engine.live;
    if (!ctx || event.strength <= 0) return;
    const ring = flashRing(event.strength);
    const seconds = Math.max(0.5, event.seconds ?? 6 * event.strength);
    const delay = event.delay ?? 0;
    this.engine.stopTag("flashRing");
    const voice = this.engine.voice({ bus: "ui", priority: Priority.local, label: "flash.ring", route: "overlay", tag: "flashRing" });
    if (voice) {
      const when = ctx.currentTime + delay;
      // Two close partials beat slowly, like real tinnitus; the decay constant spreads the fade over `seconds`.
      voice.addTone({ when, gain: ring.tone, frequency: 3650, attack: 0.04, decay: seconds / 5 });
      voice.addTone({ when, gain: ring.tone * 0.55, frequency: 3710, attack: 0.08, decay: seconds / 6 });
      voice.addTone({ when, gain: ring.tone * 0.25, frequency: 7300, attack: 0.02, decay: seconds / 9 });
    }
    const hold = seconds * 0.25;
    const release = seconds * 0.75;
    for (const bus of BUSES) if (bus !== "ui") this.engine.duck(bus, ring.duckDb, delay + hold, release);
    this.engine.muffle(ring.lowpass, 0.02, hold, release, delay);
  }

  /** Healing/boosting foley spread across the use time. Stop it with {@link stopItemUse} when the use is cancelled. */
  playItemUse(event: ItemUseAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    this.engine.stopTag(event.tag);
    const voice = this.foleyVoice(`use.${event.itemId}`, event.position, AUDIBLE_RANGE.heal, LOCAL_MIX.mechanical, event.tag);
    if (!voice) return;
    const elapsed = event.elapsed ?? 0;
    const now = ctx.currentTime;
    for (const [at, cue] of USE_CUES[event.itemId]) {
      const offset = at * event.seconds - elapsed;
      if (offset >= -0.05) addUseCue(voice, this.bank, cue, now + Math.max(0, offset));
    }
  }

  stopItemUse(tag: string): void {
    this.engine.stopTag(tag);
  }

  /** Picking up or equipping: cloth and the item's own material. */
  playPickup(kind: PickupAudioKind | "drop", position: Vec3Like | null = null): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const voice = this.foleyVoice(`pickup.${kind}`, position, 10, LOCAL_MIX.mechanical);
    if (!voice) return;
    const when = ctx.currentTime;
    const jitter = () => 0.94 + Math.random() * 0.12;
    this.layer(voice, "foley.cloth", { when, rate: jitter(), gain: 0.7 });
    switch (kind) {
      case "ammo":
        for (let i = 0; i < 3; i++) this.layer(voice, "foley.casing", { when: when + 0.04 + i * 0.045, rate: 1.5 * jitter(), gain: 0.5 });
        break;
      case "weapon":
        this.layer(voice, "mech.latch", { when: when + 0.14, rate: 0.9 * jitter(), gain: 0.8 });
        break;
      case "armor":
        this.layer(voice, "armor.hit", { when: when + 0.08, rate: 0.8 * jitter(), gain: 0.35, lowpass: 3000 });
        this.layer(voice, "foley.cloth", { when: when + 0.22, rate: 0.85 * jitter(), gain: 0.8 });
        this.layer(voice, "mech.latch", { when: when + 0.34, rate: 1.4 * jitter(), gain: 0.4 });
        break;
      case "backpack":
        addZip(voice, when + 0.05, 0.35, 1);
        break;
      case "consumable":
        this.layer(voice, "use.paper", { when: when + 0.03, rate: jitter(), gain: 0.5 });
        break;
      case "throwable":
        this.layer(voice, "throw.bounce", { when: when + 0.05, rate: 1.3 * jitter(), gain: 0.25, lowpass: 4000 });
        break;
      case "drop":
        this.layer(voice, "foley.land", { when: when + 0.12, rate: 1.1 * jitter(), gain: 0.35 });
        break;
    }
  }

  /** Armor absorbing a hit: a hard plate clank; a breaking piece adds a crack. */
  playArmorHit(event: ArmorHitAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const level = clamp(0.45 + event.absorbed / 30, 0.45, 1);
    const voice = event.position
      ? this.spatialOneShot("impacts", "armor.hit", { position: event.position }, 3, 50, level, 0.2)
      : this.engine.voice({ bus: "impacts", priority: Priority.local, label: "armor.hit", gain: 0.55 * level });
    if (!voice) return;
    const when = voice.createdAt + (event.position && voice.options.distance !== undefined ? arrivalDelay(voice.options.distance) : 0);
    this.layer(voice, "armor.hit", { when, rate: 0.9 + Math.random() * 0.15 });
    if (event.destroyed) {
      this.layer(voice, "armor.break", { when: when + 0.02, rate: 0.95 + Math.random() * 0.1, gain: 0.9 });
      this.layer(voice, "armor.hit", { when: when + 0.05, rate: 0.7, gain: 0.5, lowpass: 2000 });
    }
  }

  /**
   * Owner-supplied frag-out shout at release. Local: first person on the foley bus. Thrower elsewhere: spatial within
   * {@link FRAG_CALLOUT.range}, delayed and occluded like any world voice. A thrower whose shout is still playing (or
   * still travelling) gets no second copy.
   */
  playFragCallout(event: FragCalloutAudioEvent): void {
    const ctx = this.engine.live;
    if (!ctx) return;
    const current = this.callouts.get(event.thrower);
    if (current && current.end > ctx.currentTime) return;
    const buffer = this.bank.pick("voice.fragOut");
    if (!buffer) return;
    const label = "voice.fragOut";
    let voice: Voice | null;
    let when = ctx.currentTime;
    if (!event.position) {
      voice = this.engine.voice({ bus: "foley", priority: Priority.local, label, gain: FRAG_CALLOUT.localGain, room: 0.15 * this.probe.enclosure });
    } else {
      const place = this.place(event.position, FRAG_CALLOUT.reference, FRAG_CALLOUT.range, FRAG_CALLOUT.rolloff, event.age);
      if (!place) return;
      when += place.delay;
      voice = this.engine.voice({
        bus: "foley",
        priority: Priority.important,
        label,
        position: event.position,
        gain: Math.min(1, place.gain * FRAG_CALLOUT.remoteGain),
        lowpass: place.lowpass,
        room: 0.3 * this.probe.enclosure,
        echo: 0.15,
        distance: place.distance,
        occluded: place.occluded,
      });
    }
    if (!voice) return;
    voice.addBuffer(buffer, { when });
    this.callouts.set(event.thrower, voice);
  }

  // --- UI -------------------------------------------------------------------------------------------------------------

  /**
   * Owner-supplied results-screen clip, once per call: non-spatial on the UI bus's "clear" route (UI volume and master
   * volume apply; no muffle, ducking, reverb or echo). Lazy: if it hasn't downloaded yet it starts when it arrives,
   * unless stopped first or more than {@link MATCH_END_MUSIC.lateStartMs} late.
   */
  playMatchEndMusic(): void {
    this.stopMatchEndMusic(0.05);
    const request = ++this.musicRequest;
    const requestedAt = performance.now();
    const start = () => {
      if (request !== this.musicRequest || performance.now() - requestedAt > MATCH_END_MUSIC.lateStartMs) return;
      const ctx = this.engine.live;
      const buffer = this.bank.pick("music.matchEnd");
      if (!ctx || !buffer) return;
      const voice = this.engine.voice({ bus: "ui", priority: MATCH_END_MUSIC.priority, label: "music.matchEnd", gain: MATCH_END_MUSIC.gain, route: "clear" });
      if (!voice) return;
      voice.addBuffer(buffer, { when: ctx.currentTime });
      this.music = voice;
    };
    if (this.bank.has("music.matchEnd")) start();
    else void this.bank.load("music.matchEnd").then(start);
  }

  /** Fades the results-screen clip out (and cancels a start still waiting for the download). */
  stopMatchEndMusic(fade: number = MATCH_END_MUSIC.fadeOut): void {
    this.musicRequest++;
    const voice = this.music;
    this.music = null;
    if (voice && voice.end > this.engine.now) voice.stop(fade);
  }

  get matchEndMusicPlaying(): boolean {
    return this.music !== null && this.music.end > this.engine.now;
  }

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

  /** Mixed layers of a recipe (equipmentMix / weaponMix) on one voice. */
  private playLayers(voice: Voice, layers: readonly MixLayer[], when: number, rate: number, gain: number): void {
    for (const layer of layers) {
      if (layer.kind === "sub") {
        voice.addTone({ when: when + layer.delay, gain: layer.gain * gain, frequency: layer.from * rate, frequencyEnd: layer.to, sweep: layer.sweep, attack: 0.002, decay: layer.decay });
      } else {
        this.layer(voice, layer.sound, { when: when + layer.delay, rate: layer.rate * rate, gain: layer.gain * gain, offset: layer.offset, lowpass: layer.lowpass ?? undefined });
      }
    }
  }

  /** Dirt and fragments pattering down around a blast over the next second and a half. */
  private playDebris(position: Vec3Like, when: number, closeness: number): void {
    const voice = this.engine.voice({ bus: "impacts", priority: Priority.detail, label: "explosion.debris", position, panning: "equalpower", gain: 0.55 * closeness, lowpass: 9000, distance: distance(position, this.listener) });
    if (!voice) return;
    const count = 3 + Math.round(3 * closeness);
    for (let i = 0; i < count; i++) {
      const t = when + 0.35 + Math.random() * 1.3 * (i + 1) / count;
      this.layer(voice, "explosion.debris", { when: t, rate: 0.85 + Math.random() * 0.35, gain: 0.5 + Math.random() * 0.5 });
    }
    this.layer(voice, "impact.dirt", { when: when + 0.25, rate: 0.6, gain: 0.8 });
  }

  /** First-person foley when `position` is null, otherwise a spatial foley voice within `range`. */
  private foleyVoice(label: string, position: Vec3Like | null, range: number, localGain: number, tag?: string): Voice | null {
    if (!position) {
      return this.engine.voice({ bus: "foley", priority: Priority.local, label, gain: localGain, room: 0.15 * this.probe.enclosure, ...(tag ? { tag } : {}) });
    }
    const place = this.place(position, 1.5, range, 1, 0, 0.3);
    if (!place) return null;
    return this.engine.voice({ bus: "foley", priority: Priority.normal, label, position, gain: place.gain, lowpass: place.lowpass, distance: place.distance, occluded: place.occluded, ...(tag ? { tag } : {}) });
  }

  private spatialOneShot(bus: AudioBusId, label: string, event: AreaStartAudioEvent, reference: number, range: number, level: number, echo: number): Voice | null {
    const place = this.place(event.position, reference, range, 0.9, event.age);
    if (!place) return null;
    return this.engine.voice({
      bus,
      priority: Priority.important,
      label,
      position: event.position,
      gain: Math.min(1, place.gain * level),
      lowpass: place.lowpass,
      room: 0.3 * this.probe.enclosure,
      echo,
      distance: place.distance,
      occluded: place.occluded,
    });
  }

  private setArea(areaId: number, kind: AreaLoop["kind"], position: Vec3Like, level: number): void {
    let area = this.areas.get(areaId);
    if (!area) {
      area = { kind, position: { x: 0, y: 0, z: 0 }, level: 0, voice: null };
      this.areas.set(areaId, area);
      // Pick it up on the next frame instead of waiting for the 10 Hz refresh.
      this.areaTimer = 0;
    }
    area.position.x = position.x;
    area.position.y = position.y;
    area.position.z = position.z;
    area.level = clamp(level, 0, 1);
  }

  private startLoop(area: AreaLoop, gain: number, lowpass: number): Voice | null {
    const ctx = this.engine.live;
    if (!ctx) return null;
    const voice = this.engine.voice({ bus: "ambience", priority: Priority.important, label: area.kind === "fire" ? "fire.loop" : "smoke.hiss", position: area.position, gain: 0, lowpass, room: 0.2 * this.probe.enclosure, distance: distance(area.position, this.listener) });
    if (!voice) return null;
    const now = ctx.currentTime;
    if (area.kind === "smoke") {
      this.hiss = this.hiss?.sampleRate === ctx.sampleRate ? this.hiss : createHissBuffer(ctx);
      const hiss = this.hiss;
      voice.addBuffer(hiss, { when: now, loop: true, offset: Math.random() * hiss.duration, rate: 0.95 + Math.random() * 0.1 });
    } else {
      const fire = this.bank.pick("fire.loop");
      if (fire) {
        // Two offset, detuned copies hide the short loop's repetition.
        voice.addBuffer(fire, { when: now, loop: true, offset: Math.random() * fire.duration });
        voice.addBuffer(fire, { when: now, loop: true, offset: Math.random() * fire.duration, rate: 1.13, gain: 0.6, lowpass: 5000 });
      }
    }
    voice.output.gain.setTargetAtTime(gain, now, 0.25);
    return voice;
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
