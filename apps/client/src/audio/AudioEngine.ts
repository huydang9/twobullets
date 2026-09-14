/** Overall loudness of all game sound effects. The single place to turn everything up or down. */
export const MASTER_VOLUME = 0.55;

export type VoiceGroup = "shot" | "mechanical" | "feedback" | "impact";

/** Simultaneous voices per group; the oldest voice is faded out when a new one would exceed the limit. */
const POLYPHONY: Readonly<Record<VoiceGroup, number>> = {
  shot: 6,
  mechanical: 8,
  feedback: 4,
  impact: 6,
};

const NOISE_SECONDS = 2;
const REVERB_SECONDS = 1.6;
const STEAL_FADE = 0.02;

export interface Voice {
  readonly group: VoiceGroup;
  /** Tag for cancelling a family of scheduled sounds (e.g. a reload). */
  readonly tag: string | null;
  readonly output: GainNode;
  readonly sources: AudioScheduledSourceNode[];
  readonly start: number;
  end: number;
}

export interface VoiceOptions {
  readonly gain?: number;
  /** Send level into the shared reverb. */
  readonly reverb?: number;
  /** Send level into the slap-back echo. */
  readonly echo?: number;
  readonly tag?: string;
}

export interface NoiseOptions {
  readonly gain: number;
  readonly attack?: number;
  /** Exponential decay time constant, s. */
  readonly decay: number;
  readonly filter: BiquadFilterType;
  readonly frequency: number;
  readonly frequencyEnd?: number;
  /** Time over which the filter sweeps to frequencyEnd, s. */
  readonly sweep?: number;
  readonly q?: number;
  readonly rate?: number;
}

export interface ToneOptions {
  readonly gain: number;
  readonly type?: OscillatorType;
  readonly frequency: number;
  readonly frequencyEnd?: number;
  readonly sweep?: number;
  readonly attack?: number;
  readonly decay: number;
}

/**
 * Lazily-created WebAudio graph: voices → sfx bus (+ reverb / echo sends) → compressor → master → speakers.
 * The context is created and resumed on the first user gesture; while it isn't running, sounds are skipped
 * rather than queued (a suspended context would otherwise play the backlog all at once on resume).
 */
export class AudioEngine {
  private context: AudioContext | null = null;
  private bus: GainNode | null = null;
  private reverb: GainNode | null = null;
  private echo: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly voices: Voice[] = [];
  private readonly events = new AbortController();

  constructor() {
    const unlock = () => this.unlock();
    const options = { capture: true, signal: this.events.signal };
    window.addEventListener("pointerdown", unlock, options);
    window.addEventListener("keydown", unlock, options);
  }

  /** The running context, or null if audio isn't available yet. */
  get live(): AudioContext | null {
    return this.context?.state === "running" ? this.context : null;
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
   * Starts a voice (a gain node other nodes connect into) in `group`, enforcing polyphony.
   * `reverb`/`echo` are send levels. Returns null when audio isn't running.
   */
  voice(group: VoiceGroup, start: number, duration: number, options: VoiceOptions = {}): Voice | null {
    const ctx = this.live;
    if (!ctx || !this.bus) return null;
    this.pruneAndSteal(ctx.currentTime, group);

    const output = ctx.createGain();
    output.gain.value = options.gain ?? 1;
    output.connect(this.bus);
    if (options.reverb && this.reverb) connectSend(ctx, output, this.reverb, options.reverb);
    if (options.echo && this.echo) connectSend(ctx, output, this.echo, options.echo);
    const voice: Voice = { group, tag: options.tag ?? null, output, sources: [], start, end: start + duration };
    this.voices.push(voice);
    return voice;
  }

  /** Filtered noise burst with an attack/exponential-decay envelope. */
  noiseBurst(voice: Voice, when: number, options: NoiseOptions): void {
    const ctx = this.live;
    if (!ctx || !this.noiseBuffer) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = options.rate ?? 1;
    const filter = ctx.createBiquadFilter();
    filter.type = options.filter;
    filter.Q.value = options.q ?? 0.7;
    filter.frequency.setValueAtTime(options.frequency, when);
    if (options.frequencyEnd !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, options.frequencyEnd), when + (options.sweep ?? options.decay * 3));
    }
    const envelope = ctx.createGain();
    const end = applyEnvelope(envelope.gain, when, options.gain, options.attack ?? 0.001, options.decay);
    source.connect(filter).connect(envelope).connect(voice.output);
    source.start(when, Math.random() * (NOISE_SECONDS - 0.5));
    source.stop(end);
    voice.sources.push(source);
    voice.end = Math.max(voice.end, end);
  }

  tone(voice: Voice, when: number, options: ToneOptions): void {
    const ctx = this.live;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = options.type ?? "sine";
    osc.frequency.setValueAtTime(options.frequency, when);
    if (options.frequencyEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, options.frequencyEnd), when + (options.sweep ?? options.decay * 2));
    }
    const envelope = ctx.createGain();
    const end = applyEnvelope(envelope.gain, when, options.gain, options.attack ?? 0.002, options.decay);
    osc.connect(envelope).connect(voice.output);
    osc.start(when);
    osc.stop(end);
    voice.sources.push(osc);
    voice.end = Math.max(voice.end, end);
  }

  /** Fades out and stops every voice with `tag` (e.g. the rest of a cancelled reload). */
  stopTag(tag: string): void {
    const ctx = this.context;
    if (!ctx) return;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const voice = this.voices[i] as Voice;
      if (voice.tag !== tag) continue;
      silence(voice, ctx.currentTime);
      this.voices.splice(i, 1);
    }
  }

  dispose(): void {
    this.events.abort();
    this.voices.length = 0;
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private pruneAndSteal(now: number, group: VoiceGroup): void {
    let inGroup = 0;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const voice = this.voices[i] as Voice;
      if (voice.end < now) {
        voice.output.disconnect();
        this.voices.splice(i, 1);
      } else if (voice.group === group) {
        inGroup++;
      }
    }
    while (inGroup >= POLYPHONY[group]) {
      const index = this.voices.findIndex((voice) => voice.group === group);
      const oldest = this.voices[index];
      if (!oldest) break;
      silence(oldest, now);
      this.voices.splice(index, 1);
      inGroup--;
    }
  }

  private buildGraph(ctx: AudioContext): void {
    const master = ctx.createGain();
    master.gain.value = MASTER_VOLUME;
    master.connect(ctx.destination);

    // Gentle bus limiter so stacked gunshots duck instead of clipping.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 8;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.18;
    compressor.connect(master);

    this.bus = ctx.createGain();
    this.bus.connect(compressor);

    this.noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
    const noise = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;

    // Procedural room: decaying stereo noise impulse response.
    const convolver = ctx.createConvolver();
    const irLength = Math.floor(ctx.sampleRate * REVERB_SECONDS);
    const ir = ctx.createBuffer(2, irLength, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = ir.getChannelData(channel);
      for (let i = 0; i < irLength; i++) {
        const t = i / irLength;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.5) * (i < 200 ? i / 200 : 1);
      }
    }
    convolver.buffer = ir;
    const reverbTone = ctx.createBiquadFilter();
    reverbTone.type = "lowpass";
    reverbTone.frequency.value = 3200;
    this.reverb = ctx.createGain();
    this.reverb.connect(reverbTone).connect(convolver).connect(compressor);

    // Distant slap-back echo for heavy weapons.
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.32;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = "lowpass";
    echoTone.frequency.value = 1400;
    this.echo = ctx.createGain();
    this.echo.connect(delay);
    delay.connect(echoTone).connect(feedback).connect(delay);
    echoTone.connect(compressor);
  }
}

function connectSend(ctx: AudioContext, from: AudioNode, to: AudioNode, level: number): void {
  const send = ctx.createGain();
  send.gain.value = level;
  from.connect(send).connect(to);
}

/** Linear attack then exponential decay; returns when the sound is effectively silent. */
function applyEnvelope(param: AudioParam, when: number, peak: number, attack: number, decay: number): number {
  param.setValueAtTime(0, when);
  param.linearRampToValueAtTime(peak, when + attack);
  param.setTargetAtTime(0, when + attack, decay);
  return when + attack + decay * 7;
}

function silence(voice: Voice, now: number): void {
  const gain = voice.output.gain;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(gain.value, now);
  gain.linearRampToValueAtTime(0, now + STEAL_FADE);
  for (const source of voice.sources) {
    try {
      source.stop(now + STEAL_FADE + 0.005);
    } catch {
      // Already stopped.
    }
  }
}
