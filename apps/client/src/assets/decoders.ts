import { KhronosTextureContainer2, MeshoptCompression } from "@babylonjs/core";
import type { DecoderUrls } from "./manifest";

/**
 * Points Babylon's meshopt and KTX2 decoders at the copies served from `public/assets/decoders`
 * instead of cdn.babylonjs.com. Must run before the first GLB is parsed.
 */
export function configureDecoders(decoders: DecoderUrls, baseUrl: URL): void {
  // Decoders run inside workers created from blob URLs, so every URL must be absolute.
  const absolute = (path: string) => new URL(path, baseUrl).href;
  MeshoptCompression.Configuration = { decoder: { url: absolute(decoders.meshopt) } };
  const ktx2 = decoders.ktx2;
  KhronosTextureContainer2.URLConfig = {
    jsDecoderModule: absolute(ktx2.jsDecoderModule),
    jsMSCTranscoder: absolute(ktx2.jsMSCTranscoder),
    wasmMSCTranscoder: absolute(ktx2.wasmMSCTranscoder),
    wasmUASTCToASTC: absolute(ktx2.wasmUASTCToASTC),
    wasmUASTCToBC7: absolute(ktx2.wasmUASTCToBC7),
    wasmUASTCToRGBA_UNORM: absolute(ktx2.wasmUASTCToRGBA_UNORM),
    wasmUASTCToRGBA_SRGB: absolute(ktx2.wasmUASTCToRGBA_SRGB),
    wasmUASTCToR8_UNORM: absolute(ktx2.wasmUASTCToR8_UNORM),
    wasmUASTCToRG8_UNORM: absolute(ktx2.wasmUASTCToRG8_UNORM),
    wasmZSTDDecoder: absolute(ktx2.wasmZSTDDecoder),
  };
}
