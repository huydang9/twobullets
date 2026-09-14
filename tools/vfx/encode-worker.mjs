// KTX2 encode in a worker thread, so the basis encoder's per-slice logging can be discarded (see build.mjs).
import { parentPort } from "node:worker_threads";
import { encodeToKTX2 } from "ktx2-encoder";

parentPort.on("message", async ({ data, width, height }) => {
  try {
    const output = await encodeToKTX2(data, {
      imageDecoder: async () => ({ data, width, height }),
      generateMipmap: true,
      // Raw display-space bytes: no sRGB transfer, so the GPU samples exactly what is stored.
      isPerceptual: true,
      isSetKTX2SRGBTransferFunc: false,
      isUASTC: true,
      uastcLDRQualityLevel: 2,
      needSupercompression: true,
      enableRDO: true,
      rdoQualityLevel: 1.5,
    });
    parentPort.postMessage({ output }, [output.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.stack : String(error) });
  }
});
