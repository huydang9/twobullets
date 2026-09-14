import { clamp, dbToGain, type Vec3Like } from "./acoustics";
import type { AudioSettings, AudioVolumeKey } from "./AudioSettings";
import type { AudioBusId } from "./types";

/**
 * WebAudio graph (raw WebAudio rather than Babylon's AudioEngineV2: we need per-voice filters for air absorption and
 * occlusion, per-voice reverb/echo sends and sample-accurate delayed starts, none of which the V2 sound API exposes).
 *
 *   voice: sources → layer gains → low-pass → gain → [HRTF panner] → bus ─→ [glue] → duck → fader ─→ master → limiter
 *                                                                    └→ direct → gentle comp ─┘ (skips glue and duck)
 *                                                  └→ room send ─→ bus room tap ─→ convolver ─→ indoor return ─┘
 *                                                  └→ echo send ─→ bus echo tap ─→ slapback ──→ outdoor return ┘
 *
 * The context is created and resumed on the first user gesture. While it isn't running, voices are refused rather
 * than queued (a suspended context would otherwise play the backlog all at once).
 */

export const BUSES: readonly AudioBusId[] = ["weapons", "impacts", "footsteps", "foley", "ambience", "ui"];

const MAX_VOICES = 64;
const BUS_CAP: Readonly<Record<AudioBusId, number>> = { weapons: 20, impacts: 12, footsteps: 14, foley: 12, ambience: 8, ui: 4 };
const STEAL_FADE = 0.025;
const NOISE_SECONDS = 2;
const ROOM_SECONDS = 0.9;

/** Voice priorities: higher survives stealing. */
export const Priority = {
  ambient: 0,
  detail: 1,
  normal: 2,
  important: 3,
  local: 4,
} as const;

export interface VoiceOptions {
  readonly bus: AudioBusId;
  readonly priority: number;
  /** Debug label (usually the sound id). */
  readonly label: string;
  /** World position; omitted = non-spatial (first person, UI, ambience beds). */
  readonly position?: Vec3Like;
  readonly panning?: PanningModelType;
  readonly gain?: number;
  /** Low-pass cutoff, Hz (air absorption, occlusion). */
  readonly lowpass?: number;
  /** Send levels into the indoor room reverb and the outdoor echo. */
  readonly room?: number;
  readonly echo?: number;
  /** Listener distance, for stealing and the debug overlay. */
  readonly distance?: number;
  readonly occluded?: boolean;
  readonly tag?: string;
  /**
   * "direct" skips the bus glue compressor and ducking (the local player's own gunfire, which does the ducking, and
   * the biggest remote guns whose transient must survive).
   */
  readonly route?: "bus" | "direct";
}

export interface LayerOptions {
  /** Context time. */
  readonly when: number;
  readonly rate?: number;
  readonly gain?: number;
  readonly offset?: number;
  /** Extra per-layer low-pass, Hz. */
  readonly lowpass?: number;
  readonly loop?: boolean;
}

export interface NoiseOptions {
  readonly when: number;
  readonly gain: number;
  readonly attack?: number;
  /** Exponential decay time constant, s. */
  readonly decay: number;
  readonly filter: BiquadFilterType;
  readonly frequency: number;
  readonly frequencyEnd?: number;
  readonly sweep?: number;
  readonly q?: number;
  readonly rate?: number;
}

export interface ToneOptions {
  readonly when: number;
  readonly gain: number;
  readonly type?: OscillatorType;
  readonly frequency: number;
  readonly frequencyEnd?: number;
  readonly sweep?: number;
  readonly attack?: number;
  readonly decay: number;
}

interface Bus {
  readonly input: GainNode;
  readonly direct: GainNode;
  readonly duck: GainNode;
  readonly fader: GainNode;
  readonly roomTap: GainNode;
  readonly echoTap: GainNode;
  duckUntil: number;
  duckDepth: number;
}

/** One sound instance: any number of layered sources sharing a filter, gain, position and sends. */
export class Voice {
  readonly sources: AudioScheduledSourceNode[] = [];
  readonly createdAt: number;
  end: number;
  private readonly nodes: AudioNode[] = [];

  constructor(
    private readonly ctx: AudioContext,
    readonly options: VoiceOptions,
    private readonly filter: BiquadFilterNode,
    readonly output: GainNode,
    readonly panner: PannerNode | null,
    private readonly noise: AudioBuffer,
  ) {
    this.createdAt = ctx.currentTime;
    this.end = ctx.currentTime;
    this.nodes.push(filter, output);
    if (panner) this.nodes.push(panner);
  }

  /** Stealing score: priority first, then how loud the voice is. */
  get score(): number {
    return this.options.priority * 4 + clamp(this.options.gain ?? 1, 0, 1);
  }

  addBuffer(buffer: AudioBuffer, layer: LayerOptions): AudioBufferSourceNode {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const rate = layer.rate ?? 1;
    source.playbackRate.value = rate;
    source.loop = layer.loop ?? false;
    let tail: AudioNode = source;
    if (layer.lowpass !== undefined) tail = this.chain(tail, this.lowpass(layer.lowpass));
    if (layer.gain !== undefined && layer.gain !== 1) {
      const gain = this.ctx.createGain();
      gain.gain.value = layer.gain;
      tail = this.chain(tail, gain);
    }
    tail.connect(this.filter);
    const offset = layer.offset ?? 0;
    source.start(layer.when, offset);
    this.track(source, source.loop ? Infinity : layer.when + (buffer.duration - offset) / rate);
    return source;
  }

  /** Filtered noise burst with an attack/exponential-decay envelope (cracks, rumbles, whizzes). */
  addNoise(options: NoiseOptions): BiquadFilterNode {
    const source = this.ctx.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = options.rate ?? 1;
    const filter = this.ctx.createBiquadFilter();
    filter.type = options.filter;
    filter.Q.value = options.q ?? 0.7;
    filter.frequency.setValueAtTime(options.frequency, options.when);
    if (options.frequencyEnd !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, options.frequencyEnd), options.when + (options.sweep ?? options.decay * 3));
    }
    const envelope = this.ctx.createGain();
    const end = applyEnvelope(envelope.gain, options.when, options.gain, options.attack ?? 0.001, options.decay);
    this.chain(this.chain(source, filter), envelope).connect(this.filter);
    source.start(options.when, Math.random() * (NOISE_SECONDS - 0.6));
    source.stop(end);
    this.track(source, end);
    return filter;
  }

  addTone(options: ToneOptions): void {
    const osc = this.ctx.createOscillator();
    osc.type = options.type ?? "sine";
    osc.frequency.setValueAtTime(options.frequency, options.when);
    if (options.frequencyEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, options.frequencyEnd), options.when + (options.sweep ?? options.decay * 2));
    }
    const envelope = this.ctx.createGain();
    const end = applyEnvelope(envelope.gain, options.when, options.gain, options.attack ?? 0.002, options.decay);
    this.chain(osc, envelope).connect(this.filter);
    osc.start(options.when);
    osc.stop(end);
    this.track(osc, end);
  }

  /** Post-fader send from this voice into an effect input. */
  send(to: AudioNode, level: number): void {
    const send = this.ctx.createGain();
    send.gain.value = level;
    this.chain(this.output, send).connect(to);
  }

  setGain(gain: number, smoothing = 0.05): void {
    this.output.gain.setTargetAtTime(gain, this.ctx.currentTime, smoothing);
  }

  setLowpass(frequency: number, smoothing = 0.05): void {
    this.filter.frequency.setTargetAtTime(frequency, this.ctx.currentTime, smoothing);
  }

  /** Fades out and stops every source. */
  stop(fade = STEAL_FADE): void {
    const now = this.ctx.currentTime;
    const gain = this.output.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + fade);
    for (const source of this.sources) {
      try {
        source.stop(now + fade + 0.005);
      } catch {
        // Already stopped.
      }
    }
    this.end = Math.min(this.end, now + fade + 0.01);
  }

  disconnect(): void {
    for (const node of this.nodes) node.disconnect();
    for (const source of this.sources) source.disconnect();
  }

  private lowpass(frequency: number): BiquadFilterNode {
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = frequency;
    filter.Q.value = 0.5;
    return filter;
  }

  private chain(from: AudioNode, to: AudioNode): AudioNode {
    from.connect(to);
    this.nodes.push(to);
    return to;
  }

  private track(source: AudioScheduledSourceNode, end: number): void {
    this.sources.push(source);
    this.end = Math.max(this.end, end);
  }
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private roomReturn: GainNode | null = null;
  private echoReturn: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly buses = new Map<AudioBusId, Bus>();
  private readonly voices: Voice[] = [];
  private readonly events = new AbortController();
  private readonly unsubscribe: () => void;
  private indoor = 0;
  /** Voices refused or stolen since start (debug). */
  culled = 0;
  stolen = 0;

  constructor(private readonly settings: AudioSettings) {
    const unlock = () => this.unlock();
    const options = { capture: true, signal: this.events.signal };
    window.addEventListener("pointerdown", unlock, options);
    window.addEventListener("keydown", unlock, options);
    this.unsubscribe = settings.onChange((key, value) => this.applyVolume(key, value));
  }

  /** The running context, or null if audio isn't available yet. */
  get live(): AudioContext | null {
    return this.context?.state === "running" ? this.context : null;
  }

  get now(): number {
    return this.context?.currentTime ?? 0;
  }

  get activeVoices(): readonly Voice[] {
    return this.voices;
  }

  unlock(): void {
    if (!this.context) {
      const Context = window.AudioContext as typeof AudioContext | undefined;
      if (!Context) return;
      this.context = new Context({ latencyHint: "interactive" });
      this.buildGraph(this.context);
    }
    if (this.context.state === "suspended") void this.context.resume().catch(() => undefined);
  }

  /**
   * Starts a voice. Returns null when audio isn't running or the pool is full of more important voices.
   * Callers add layers with voice.addBuffer / addNoise / addTone.
   */
  voice(options: VoiceOptions): Voice | null {
    const ctx = this.live;
    const bus = this.buses.get(options.bus);
    if (!ctx || !bus || !this.noise) return null;
    if (!this.makeRoom(ctx.currentTime, options)) {
      this.culled++;
      return null;
    }

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.5;
    filter.frequency.value = options.lowpass ?? 22_000;
    const output = ctx.createGain();
    output.gain.value = options.gain ?? 1;
    filter.connect(output);

    let panner: PannerNode | null = null;
    if (options.position) {
      panner = ctx.createPanner();
      panner.panningModel = options.panning ?? "HRTF";
      // Distance attenuation is computed by the caller (acoustics.ts), so the panner only positions.
      panner.distanceModel = "inverse";
      panner.rolloffFactor = 0;
      setPannerPosition(panner, options.position, ctx.currentTime);
      output.connect(panner).connect(options.route === "direct" ? bus.direct : bus.input);
    } else {
      output.connect(options.route === "direct" ? bus.direct : bus.input);
    }
    const voice = new Voice(ctx, options, filter, output, panner, this.noise);
    if (options.room) voice.send(bus.roomTap, options.room);
    if (options.echo) voice.send(bus.echoTap, options.echo);
    this.voices.push(voice);
    return voice;
  }

  /** Stops every voice carrying `tag` (e.g. the rest of a cancelled reload). */
  stopTag(tag: string): void {
    for (const voice of this.voices) if (voice.options.tag === tag) voice.stop();
  }

  /** Listener pose in Babylon (left-handed) world space. */
  setListener(position: Vec3Like, forward: Vec3Like, up: Vec3Like): void {
    const ctx = this.live;
    if (!ctx) return;
    const l = ctx.listener;
    // WebAudio is right-handed: mirror Z for the listener and every source (setPannerPosition).
    if (l.positionX) {
      l.positionX.value = position.x;
      l.positionY.value = position.y;
      l.positionZ.value = -position.z;
      l.forwardX.value = forward.x;
      l.forwardY.value = forward.y;
      l.forwardZ.value = -forward.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = -up.z;
    } else {
      // Firefox: AudioListener has no AudioParams.
      l.setPosition(position.x, position.y, -position.z);
      l.setOrientation(forward.x, forward.y, -forward.z, up.x, up.y, -up.z);
    }
  }

  /** 0 = open air (outdoor slapback echo), 1 = enclosed (short room reverb). */
  setEnvironment(indoor: number): void {
    const value = clamp(indoor, 0, 1);
    // Called every frame: skip automation events for changes nobody can hear.
    if (Math.abs(value - this.indoor) < 0.01) return;
    this.indoor = value;
    this.applyEnvironment();
  }

  get environment(): number {
    return this.indoor;
  }

  /** Briefly lowers a bus (e.g. ambience under your own gunfire). Overlapping ducks keep the deepest. */
  duck(busId: AudioBusId, depthDb: number, hold: number, release: number): void {
    const ctx = this.live;
    const bus = this.buses.get(busId);
    if (!ctx || !bus) return;
    const now = ctx.currentTime;
    const target = dbToGain(-Math.abs(depthDb));
    if (now < bus.duckUntil && target > bus.duckDepth) {
      bus.duckUntil = Math.max(bus.duckUntil, now + hold);
    } else {
      bus.duckDepth = target;
      bus.duckUntil = now + hold;
    }
    const gain = bus.duck.gain;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(bus.duckDepth, now, 0.012);
    gain.setTargetAtTime(1, bus.duckUntil, release / 3);
  }

  /** Per-frame housekeeping: frees finished voices. */
  update(): void {
    const ctx = this.context;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const voice = this.voices[i] as Voice;
      if (voice.end + 0.05 < now) {
        voice.disconnect();
        this.voices.splice(i, 1);
      }
    }
  }

  dispose(): void {
    this.events.abort();
    this.unsubscribe();
    for (const voice of this.voices) voice.disconnect();
    this.voices.length = 0;
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  /** Enforces the global and per-bus polyphony caps. False = the new voice loses. */
  private makeRoom(now: number, options: VoiceOptions): boolean {
    let inBus = 0;
    let active = 0;
    for (const voice of this.voices) {
      if (voice.end < now) continue;
      active++;
      if (voice.options.bus === options.bus) inBus++;
    }
    const newScore = options.priority * 4 + clamp(options.gain ?? 1, 0, 1);
    const busFull = inBus >= BUS_CAP[options.bus];
    if (!busFull && active < MAX_VOICES) return true;

    let victim: Voice | null = null;
    for (const voice of this.voices) {
      if (voice.end < now || (busFull && voice.options.bus !== options.bus)) continue;
      if (!victim || voice.score < victim.score || (voice.score === victim.score && voice.createdAt < victim.createdAt)) victim = voice;
    }
    if (!victim || victim.score > newScore) return false;
    victim.stop();
    this.stolen++;
    return true;
  }

  private buildGraph(ctx: AudioContext): void {
    // Safety limiter only: mix levels (weaponMix.ts) keep the loudest shot about 1 dB under it at full volume.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    limiter.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.settings.get("master");
    this.master.connect(limiter);

    this.noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
    const noise = this.noise.getChannelData(0);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;

    const roomIn = this.buildRoom(ctx);
    const echoIn = this.buildEcho(ctx);

    for (const id of BUSES) {
      const input = ctx.createGain();
      const duck = ctx.createGain();
      const fader = ctx.createGain();
      const volume = this.settings.get(id);
      fader.gain.value = volume;
      if (id === "weapons") {
        // Glue: stacked remote gunfire compresses together before the master limiter.
        const glue = ctx.createDynamicsCompressor();
        glue.threshold.value = -14;
        glue.knee.value = 6;
        glue.ratio.value = 3;
        glue.attack.value = 0.003;
        glue.release.value = 0.15;
        input.connect(glue).connect(duck);
      } else {
        input.connect(duck);
      }
      duck.connect(fader).connect(this.master);
      // Direct path: a slow-attack compressor that lets transients through and only tames sustained stacking
      // (long automatic bursts), well above a single shot's tail.
      const direct = ctx.createGain();
      const gentle = ctx.createDynamicsCompressor();
      gentle.threshold.value = -8;
      gentle.knee.value = 6;
      gentle.ratio.value = 2;
      gentle.attack.value = 0.02;
      gentle.release.value = 0.25;
      direct.connect(gentle).connect(fader);
      const roomTap = ctx.createGain();
      roomTap.gain.value = volume;
      roomTap.connect(roomIn);
      const echoTap = ctx.createGain();
      echoTap.gain.value = volume;
      echoTap.connect(echoIn);
      this.buses.set(id, { input, direct, duck, fader, roomTap, echoTap, duckUntil: 0, duckDepth: 1 });
    }
    this.applyEnvironment();
  }

  private applyEnvironment(): void {
    const ctx = this.context;
    if (!ctx || !this.roomReturn || !this.echoReturn) return;
    this.roomReturn.gain.setTargetAtTime(this.indoor, ctx.currentTime, 0.2);
    this.echoReturn.gain.setTargetAtTime(1 - this.indoor * 0.85, ctx.currentTime, 0.2);
  }

  /** Short, bright room: procedural stereo impulse with dense early reflections. */
  private buildRoom(ctx: AudioContext): GainNode {
    const length = Math.floor(ctx.sampleRate * ROOM_SECONDS);
    const ir = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = ir.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const t = i / ctx.sampleRate;
        data[i] = (Math.random() * 2 - 1) * Math.exp(-t / 0.16) * (i < 96 ? i / 96 : 1);
      }
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = ir;
    const input = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 5000;
    this.roomReturn = ctx.createGain();
    this.roomReturn.gain.value = 0;
    input.connect(tone).connect(convolver).connect(this.roomReturn).connect(this.master as GainNode);
    return input;
  }

  /**
   * Open-field reflections: a stereo slapback (a nearby tree line / building face) plus a long, dark valley echo
   * that makes distant gunfire roll.
   */
  private buildEcho(ctx: AudioContext): GainNode {
    const input = ctx.createGain();
    this.echoReturn = ctx.createGain();
    this.echoReturn.gain.value = 1;
    this.echoReturn.connect(this.master as GainNode);
    const merger = ctx.createChannelMerger(2);
    merger.connect(this.echoReturn);

    const tap = (seconds: number, feedback: number, cutoff: number, level: number, channel: number) => {
      const delay = ctx.createDelay(2);
      delay.delayTime.value = seconds;
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = cutoff;
      const loop = ctx.createGain();
      loop.gain.value = feedback;
      const out = ctx.createGain();
      out.gain.value = level;
      input.connect(delay).connect(tone);
      tone.connect(loop).connect(delay);
      tone.connect(out).connect(merger, 0, channel);
    };
    tap(0.19, 0.22, 2800, 0.45, 0);
    tap(0.27, 0.22, 2600, 0.45, 1);
    tap(0.82, 0.38, 900, 0.5, 0);
    tap(1.07, 0.38, 850, 0.5, 1);
    return input;
  }

  private applyVolume(key: AudioVolumeKey, value: number): void {
    const ctx = this.context;
    if (!ctx) return;
    if (key === "master") {
      this.master?.gain.setTargetAtTime(value, ctx.currentTime, 0.03);
      return;
    }
    const bus = this.buses.get(key);
    if (!bus) return;
    for (const node of [bus.fader, bus.roomTap, bus.echoTap]) node.gain.setTargetAtTime(value, ctx.currentTime, 0.03);
  }
}

export function setPannerPosition(panner: PannerNode, p: Vec3Like, when: number): void {
  if (panner.positionX) {
    panner.positionX.setValueAtTime(p.x, when);
    panner.positionY.setValueAtTime(p.y, when);
    panner.positionZ.setValueAtTime(-p.z, when);
  } else {
    panner.setPosition(p.x, p.y, -p.z);
  }
}

/** Linear attack then exponential decay; returns when the sound is effectively silent. */
function applyEnvelope(param: AudioParam, when: number, peak: number, attack: number, decay: number): number {
  param.setValueAtTime(0, when);
  param.linearRampToValueAtTime(peak, when + attack);
  param.setTargetAtTime(0, when + attack, decay);
  return when + attack + decay * 7;
}
