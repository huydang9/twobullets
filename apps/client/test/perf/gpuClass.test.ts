import { describe, expect, it } from "vitest";
import { classifyGpu } from "../../src/perf/gpuClass";

/** The two renderer strings captured on the owner's ASUS ROG laptop (Intel UHD iGPU + RTX 5050 dGPU). */
const INTEL_UHD = "ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B) Direct3D11 vs_5_0 ps_5_0, D3D11)";
const RTX_5050 = "ANGLE (NVIDIA, NVIDIA GeForce RTX 5050 Laptop GPU (0x00002DD8) Direct3D11 vs_5_0 ps_5_0, D3D11)";

const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("classifyGpu", () => {
  it("reads the Intel UHD iGPU as integrated and names it", () => {
    const info = classifyGpu(INTEL_UHD, WINDOWS_UA);
    expect(info.gpuClass).toBe("integrated");
    expect(info.name).toBe("Intel UHD Graphics");
    expect(info.renderer).toBe(INTEL_UHD);
  });

  it("reads the RTX 5050 as discrete and names it", () => {
    const info = classifyGpu(RTX_5050, WINDOWS_UA);
    expect(info.gpuClass).toBe("discrete");
    expect(info.name).toBe("NVIDIA GeForce RTX 5050 Laptop GPU");
    expect(info.hybridHint).toBe(false);
  });

  it("hints at the hybrid GPU switch only on Windows", () => {
    expect(classifyGpu(INTEL_UHD, WINDOWS_UA).hybridHint).toBe(true);
    expect(classifyGpu(INTEL_UHD, MAC_UA).hybridHint).toBe(false);
  });

  it("detects software rasterizers", () => {
    const swift = classifyGpu("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", WINDOWS_UA);
    expect(swift.gpuClass).toBe("software");
    expect(swift.hybridHint).toBe(true);

    const mesa = classifyGpu("Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)", MAC_UA);
    expect(mesa.gpuClass).toBe("software");
    expect(mesa.hybridHint).toBe(false);

    expect(classifyGpu("Microsoft Basic Render Driver", WINDOWS_UA).gpuClass).toBe("software");
  });

  it("treats Apple Silicon as integrated but never hints at a GPU switch", () => {
    const info = classifyGpu("Apple M2 Pro", MAC_UA);
    expect(info.gpuClass).toBe("integrated");
    expect(info.name).toBe("Apple M2 Pro");
    expect(info.hybridHint).toBe(false);
    // Even with a nonsense Windows UA, Apple Silicon is fast: a warning driven by class alone would be wrong,
    // so Agent C must gate on hybridHint / the watchdog, not on gpuClass.
    expect(classifyGpu("ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)", MAC_UA).gpuClass).toBe("integrated");
  });

  it("separates AMD discrete cards from AMD integrated graphics", () => {
    const rx = classifyGpu("ANGLE (AMD, AMD Radeon(TM) RX 7800 XT (0x0000747E) Direct3D11 vs_5_0 ps_5_0, D3D11)", WINDOWS_UA);
    expect(rx.gpuClass).toBe("discrete");
    expect(rx.name).toBe("AMD Radeon RX 7800 XT");
    expect(rx.hybridHint).toBe(false);

    const apu = classifyGpu("ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)", WINDOWS_UA);
    expect(apu.gpuClass).toBe("integrated");
    expect(apu.name).toBe("AMD Radeon Graphics");
    expect(apu.hybridHint).toBe(true);

    expect(classifyGpu("AMD Radeon RX Vega 64", WINDOWS_UA).gpuClass).toBe("discrete");
    expect(classifyGpu("AMD Radeon Vega 8 Graphics", WINDOWS_UA).gpuClass).toBe("integrated");
  });

  it("classifies Intel Iris Xe as integrated", () => {
    const info = classifyGpu("ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A8) Direct3D11 vs_5_0 ps_5_0, D3D11)", WINDOWS_UA);
    expect(info.gpuClass).toBe("integrated");
    expect(info.name).toBe("Intel Iris Xe Graphics");
    expect(info.hybridHint).toBe(true);
  });

  it("splits Intel Arc: a model number means the discrete card, no model number means the iGPU", () => {
    expect(classifyGpu("ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)", WINDOWS_UA).gpuClass).toBe("discrete");
    expect(classifyGpu("ANGLE (Intel, Intel(R) Arc(TM) B580 Graphics (0x0000E20B) Direct3D11 vs_5_0 ps_5_0, D3D11)", WINDOWS_UA).gpuClass).toBe("discrete");

    const igpu = classifyGpu("ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)", WINDOWS_UA);
    expect(igpu.gpuClass).toBe("integrated");
    expect(igpu.name).toBe("Intel Arc Graphics");
    expect(igpu.hybridHint).toBe(true);
  });

  it("classifies mobile GPUs as integrated", () => {
    expect(classifyGpu("ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)", "Mozilla/5.0 (Linux; Android 14)").gpuClass).toBe("integrated");
    expect(classifyGpu("Mali-G78 MP14", "Mozilla/5.0 (Linux; Android 13)").gpuClass).toBe("integrated");
  });

  it("falls back for empty and unrecognized strings", () => {
    const empty = classifyGpu("", WINDOWS_UA);
    expect(empty.gpuClass).toBe("unknown");
    expect(empty.name).toBe("Unknown GPU");
    expect(empty.hybridHint).toBe(false);

    expect(classifyGpu("   ", WINDOWS_UA).gpuClass).toBe("unknown");

    const junk = classifyGpu("Frobnicator 9000 XT", WINDOWS_UA);
    expect(junk.gpuClass).toBe("unknown");
    expect(junk.name).toBe("Frobnicator 9000 XT");
    expect(junk.hybridHint).toBe(false);
  });
});
