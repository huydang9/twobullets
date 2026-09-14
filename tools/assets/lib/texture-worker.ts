import { parentPort } from "node:worker_threads";
import { encodeToKTX2 } from "ktx2-encoder";
import sharp from "sharp";
import type { EncodeJob } from "./textures.ts";

async function encode(job: EncodeJob): Promise<Uint8Array> {
  let image = sharp(job.image);
  const { width = 0, height = 0 } = await image.metadata();
  const scale = Math.min(1, job.maxSize / Math.max(width, height));
  if (scale < 1) {
    image = image.resize(Math.round(width * scale), Math.round(height * scale), { kernel: "lanczos3" });
  }

  if (job.format === "webp") {
    const quality = job.kind === "normal" ? 92 : 86;
    return new Uint8Array(await image.webp({ quality, effort: 5, smartSubsample: true }).toBuffer());
  }

  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw = { data: new Uint8Array(data), width: info.width, height: info.height };
  const color = job.kind === "color";
  return encodeToKTX2(raw.data, {
    imageDecoder: async () => raw,
    generateMipmap: true,
    isPerceptual: color,
    isSetKTX2SRGBTransferFunc: color,
    isNormalMap: job.kind === "normal",
    ...(job.codec === "uastc"
      ? { isUASTC: true, uastcLDRQualityLevel: 2, needSupercompression: true, enableRDO: true, rdoQualityLevel: 3 }
      : { isUASTC: false, qualityLevel: 230, compressionLevel: 2 }),
  });
}

parentPort?.on("message", async ({ id, job }: { id: number; job: EncodeJob }) => {
  try {
    const output = await encode(job);
    parentPort?.postMessage({ id, output }, [output.buffer as ArrayBuffer]);
  } catch (error) {
    parentPort?.postMessage({ id, error: error instanceof Error ? error.stack : String(error) });
  }
});
