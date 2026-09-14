import { AUDIO_FORMATS, AUDIO_MANIFEST, AUDIO_ROOT, type SoundId } from "./audioManifest";

const DECODE_RATE = 48_000;
const PARALLEL_REQUESTS = 6;

type FormatExt = (typeof AUDIO_FORMATS)[number]["ext"];

/**
 * Fetches and decodes the manifest's sounds. Decoding uses an OfflineAudioContext, so buffers are ready before the
 * user gesture that starts the real AudioContext (AudioBuffers are not tied to a context).
 *
 * Format: Ogg Opus where the browser reports support (Chrome, Firefox, Edge, Safari 18.4+), AAC in M4A otherwise
 * (older Safari). A file that fails to decode is retried in the other format.
 */
export class SoundBank {
  readonly format: FormatExt;
  /** Resolves once every eager sound has loaded (or failed). */
  readonly ready: Promise<void>;
  private readonly buffers = new Map<SoundId, AudioBuffer[]>();
  private readonly pending = new Map<SoundId, Promise<void>>();
  private readonly lastPick = new Map<SoundId, number>();
  private readonly decoder: BaseAudioContext | null;
  private readonly baseUrl: string;
  private bytes = 0;
  private failures = 0;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl + AUDIO_ROOT;
    this.format = pickFormat();
    const Offline = window.OfflineAudioContext as typeof OfflineAudioContext | undefined;
    this.decoder = Offline ? new Offline(1, 1, DECODE_RATE) : null;
    const ids = Object.keys(AUDIO_MANIFEST) as SoundId[];
    const eager = ids.filter((id) => AUDIO_MANIFEST[id].load === "eager");
    // Lazy sounds (ambience) are fetched on first use only, so nothing downloads while ambience is switched off.
    this.ready = this.loadAll(eager);
  }

  get stats(): { readonly sounds: number; readonly megabytes: number; readonly failures: number } {
    return { sounds: this.buffers.size, megabytes: this.bytes / 1e6, failures: this.failures };
  }

  has(id: SoundId): boolean {
    return this.buffers.has(id);
  }

  /** A random variation, never the same one twice in a row. Null while not loaded (starts loading lazy sounds). */
  pick(id: SoundId): AudioBuffer | null {
    const variants = this.buffers.get(id);
    if (!variants) {
      void this.load(id);
      return null;
    }
    if (variants.length === 1) return variants[0] ?? null;
    const last = this.lastPick.get(id) ?? -1;
    let index = Math.floor(Math.random() * (variants.length - 1));
    if (index >= last) index++;
    this.lastPick.set(id, index);
    return variants[index] ?? null;
  }

  load(id: SoundId): Promise<void> {
    const existing = this.pending.get(id);
    if (existing) return existing;
    const promise = Promise.all(AUDIO_MANIFEST[id].variants.map((v) => this.fetchDecode(v.file))).then((decoded) => {
      const buffers = decoded.filter((b): b is AudioBuffer => b !== null);
      if (buffers.length > 0) this.buffers.set(id, buffers);
    });
    this.pending.set(id, promise);
    return promise;
  }

  private async loadAll(ids: readonly SoundId[]): Promise<void> {
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) await this.load(id);
    };
    await Promise.all(Array.from({ length: PARALLEL_REQUESTS }, worker));
  }

  private async fetchDecode(file: string): Promise<AudioBuffer | null> {
    const fallback: FormatExt = this.format === "ogg" ? "m4a" : "ogg";
    for (const ext of [this.format, fallback]) {
      try {
        const response = await fetch(`${this.baseUrl}${file}.${ext}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        this.bytes += data.byteLength;
        if (!this.decoder) throw new Error("WebAudio unavailable");
        return await this.decoder.decodeAudioData(data);
      } catch (error) {
        if (ext === fallback) {
          this.failures++;
          console.warn(`[audio] failed to load ${file}`, error);
        }
      }
    }
    return null;
  }
}

function pickFormat(): FormatExt {
  const probe = document.createElement("audio");
  for (const format of AUDIO_FORMATS) if (probe.canPlayType(format.mime) !== "") return format.ext;
  return "m4a";
}
