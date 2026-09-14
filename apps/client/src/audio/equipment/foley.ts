import type { LayerOptions, Voice } from "../AudioEngine";
import type { SoundId } from "../audioManifest";
import type { UseCue } from "../equipmentMix";
import type { SoundBank } from "../SoundBank";

// Equipment foley layered onto a voice: item-use cues and the sounds no CC0 recording covers (gas hiss, fire pops,
// zippers, gulps), synthesized from the engine's noise and tone layers.

const HISS_SECONDS = 3;

function layer(voice: Voice, bank: SoundBank, id: SoundId, options: LayerOptions): void {
  const buffer = bank.pick(id);
  if (buffer) voice.addBuffer(buffer, options);
}

/** One item-use cue (equipmentMix.USE_CUES) at context time `when`. */
export function addUseCue(voice: Voice, bank: SoundBank, cue: UseCue, when: number): void {
  const jitter = () => 0.93 + Math.random() * 0.14;
  switch (cue) {
    case "paper":
      layer(voice, bank, "use.paper", { when, rate: jitter(), gain: 0.8 });
      break;
    case "tape":
      layer(voice, bank, "use.tape", { when, rate: 0.9 * jitter(), gain: 0.55, lowpass: 7000 });
      break;
    case "cloth":
      layer(voice, bank, "foley.cloth", { when, rate: jitter(), gain: 0.6 });
      break;
    case "zip":
      addZip(voice, when, 0.4, 0.8);
      break;
    case "rattle":
      for (let i = 0; i < 4; i++) layer(voice, bank, "use.rattle", { when: when + i * (0.05 + Math.random() * 0.03), rate: 1.1 * jitter(), gain: 0.6 });
      break;
    case "capClick":
      layer(voice, bank, "mech.latch", { when, rate: 1.7 * jitter(), gain: 0.45 });
      break;
    case "canOpen":
      layer(voice, bank, "mech.latch", { when, rate: 1.9, gain: 0.5 });
      layer(voice, bank, "smoke.burst", { when: when + 0.02, rate: 1.4, gain: 0.35, lowpass: 7000 });
      break;
    case "gulp":
      voice.addTone({ when, gain: 0.18, frequency: 210, frequencyEnd: 95, sweep: 0.07, decay: 0.04 });
      voice.addNoise({ when: when + 0.01, gain: 0.12, filter: "bandpass", q: 2.5, frequency: 450, decay: 0.05 });
      break;
    case "slosh":
      layer(voice, bank, "use.slosh", { when, rate: 0.75 * jitter(), gain: 0.45, lowpass: 2500 });
      break;
    case "spray":
      voice.addNoise({ when, gain: 0.12, attack: 0.03, filter: "highpass", frequency: 4000, decay: 0.12 });
      break;
  }
}

/** Zipper: a train of tiny ticks that speeds up through the pull. */
export function addZip(voice: Voice, when: number, seconds: number, gain: number): void {
  const teeth = 16;
  for (let i = 0; i < teeth; i++) {
    const t = when + seconds * (i / teeth) ** 0.8;
    voice.addNoise({ when: t, gain: gain * (0.12 + Math.random() * 0.06), filter: "bandpass", q: 2, frequency: 2600 + Math.random() * 900, decay: 0.006 });
  }
}

/** A random pop of burning fuel within the next `window` seconds. */
export function addCrackle(voice: Voice, now: number, window: number): void {
  const when = now + Math.random() * window;
  voice.addNoise({ when, gain: 0.25 + Math.random() * 0.35, filter: "bandpass", q: 1.5, frequency: 1800 + Math.random() * 3000, decay: 0.004 + Math.random() * 0.01 });
}

/** Procedural gas hiss for smoke canisters: band-limited noise with a slow periodic sputter, seamless when looped. */
export function createHissBuffer(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * HISS_SECONDS);
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  let low = 0;
  let band = 0;
  for (let i = 0; i < length; i++) {
    const phase = (i / length) * Math.PI * 2;
    // Whole cycles over the buffer, so the sputter wraps without a seam.
    const sputter = 0.8 + 0.12 * Math.sin(phase * 5) + 0.08 * Math.sin(phase * 13 + 1.3);
    const white = Math.random() * 2 - 1;
    low += 0.06 * (white - low);
    band += 0.5 * (white - low - band);
    data[i] = band * sputter * 0.9;
  }
  return buffer;
}
