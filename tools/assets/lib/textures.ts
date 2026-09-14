import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { Document, Texture } from "@gltf-transform/core";
import { EXTTextureWebP, KHRTextureBasisu } from "@gltf-transform/extensions";
import { hashBytes } from "./cache.ts";

export type TextureSlot = "baseColor" | "normal" | "orm";
export type TextureCodec = "etc1s" | "uastc";
export type TextureFormat = "ktx2" | "webp";

/** First matching rule wins. `codec` only applies to KTX2 output. */
export interface TextureRule {
  readonly material?: RegExp;
  readonly slot: TextureSlot;
  readonly maxSize: number;
  readonly codec: TextureCodec;
}

export interface EncodeJob {
  readonly image: Uint8Array;
  readonly format: TextureFormat;
  readonly codec: TextureCodec;
  readonly maxSize: number;
  readonly kind: "color" | "normal" | "linear";
}

const ENCODER_VERSION = "ktx2-encoder@0.6/sharp@0.35/v2";

export class TextureEncoderPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: { job: EncodeJob; resolve: (out: Uint8Array) => void; reject: (err: Error) => void }[] = [];
  private readonly pending = new Map<number, { resolve: (out: Uint8Array) => void; reject: (err: Error) => void }>();
  private nextId = 0;
  private readonly cacheDir: string;

  /** Default one worker: each basis encoder holds a large wasm heap. Raise with `--workers` on roomy machines. */
  constructor(cacheDir: string, size = 1) {
    this.cacheDir = cacheDir;
    for (let i = 0; i < size; i++) {
      // The basis encoder logs every mip slice to stdout; discard it.
      const worker = new Worker(new URL("./texture-worker.ts", import.meta.url), { stdout: true });
      worker.stdout.resume();
      worker.on("message", (msg: { id: number; output?: Uint8Array; error?: string }) => {
        const task = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.output) task?.resolve(msg.output);
        else task?.reject(new Error(msg.error));
        this.release(worker);
      });
      worker.on("error", (error) => {
        for (const task of this.pending.values()) task.reject(error);
        this.pending.clear();
      });
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  /** Encodes with an on-disk cache keyed by source bytes + settings. */
  async encode(job: EncodeJob): Promise<{ data: Uint8Array; cached: boolean }> {
    const { image, ...settings } = job;
    const file = join(this.cacheDir, "textures", `${hashBytes(image, JSON.stringify(settings), ENCODER_VERSION)}.${job.format}`);
    try {
      return { data: new Uint8Array(await readFile(file)), cached: true };
    } catch {
      const data = await new Promise<Uint8Array>((resolve, reject) => {
        this.queue.push({ job, resolve, reject });
        this.pump();
      });
      await mkdir(join(this.cacheDir, "textures"), { recursive: true });
      await writeFile(file, data);
      return { data, cached: false };
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }

  private release(worker: Worker): void {
    this.idle.push(worker);
    this.pump();
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const { job, resolve, reject } = this.queue.shift()!;
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, job });
    }
  }
}

function slotsOf(doc: Document, texture: Texture): { material: string; slot: TextureSlot }[] {
  const uses: { material: string; slot: TextureSlot }[] = [];
  for (const material of doc.getRoot().listMaterials()) {
    const name = material.getName();
    if (material.getBaseColorTexture() === texture || material.getEmissiveTexture() === texture) {
      uses.push({ material: name, slot: "baseColor" });
    }
    if (material.getNormalTexture() === texture) uses.push({ material: name, slot: "normal" });
    if (material.getMetallicRoughnessTexture() === texture || material.getOcclusionTexture() === texture) {
      uses.push({ material: name, slot: "orm" });
    }
  }
  return uses;
}

/** Resizes and re-encodes every texture in the document, then names them `<material>_<slot>`. */
export async function compressTextures(
  doc: Document,
  rules: readonly TextureRule[],
  format: TextureFormat,
  pool: TextureEncoderPool,
): Promise<{ encoded: number; cached: number }> {
  let encoded = 0;
  let cached = 0;
  await Promise.all(
    doc
      .getRoot()
      .listTextures()
      .map(async (texture) => {
        const image = texture.getImage();
        const uses = slotsOf(doc, texture);
        const use = uses[0];
        if (!image || !use) return;
        const rule = rules.find((r) => uses.some((u) => u.slot === r.slot && (!r.material || r.material.test(u.material))));
        if (!rule) throw new Error(`No texture rule for ${use.material}/${use.slot}`);
        const kind = rule.slot === "baseColor" ? "color" : rule.slot === "normal" ? "normal" : "linear";
        const result = await pool.encode({ image, format, codec: rule.codec, maxSize: rule.maxSize, kind });
        if (result.cached) cached++;
        else encoded++;
        texture
          .setImage(result.data)
          .setMimeType(format === "ktx2" ? "image/ktx2" : "image/webp")
          .setURI("")
          .setName(`${use.material}_${use.slot}`);
      }),
  );
  if (format === "ktx2") doc.createExtension(KHRTextureBasisu).setRequired(true);
  else doc.createExtension(EXTTextureWebP).setRequired(true);
  return { encoded, cached };
}
