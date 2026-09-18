/**
 * Classifies the GPU Chrome actually bound, from the raw WEBGL_debug_renderer_info string
 * (`engine.getGlInfo().renderer`). Pure: no Babylon, no DOM.
 *
 * Why it exists: on a Windows hybrid laptop (Intel iGPU + NVIDIA dGPU) Chrome may bind the integrated GPU when the
 * per-app GPU preference is "Let Windows decide", which cost this project 11-16 FPS on a machine with an RTX 5050.
 *
 * Reading the result: NEVER warn on `gpuClass === "integrated"` alone. Apple Silicon is integrated by architecture and
 * fast, and plenty of thin PCs have no second GPU to switch to. Use `hybridHint` (Windows + integrated/software, i.e.
 * the advice "force the discrete GPU" is actionable) and/or a sustained low frame rate from `PerfWatchdog`.
 */

export type GpuClass = "integrated" | "software" | "discrete" | "unknown";

export interface GpuInfo {
  /** Raw WEBGL_debug_renderer_info string as Babylon reports it (engine.getGlInfo().renderer). */
  readonly renderer: string;
  readonly gpuClass: GpuClass;
  /** Short human name pulled out of the raw string, e.g. "Intel UHD Graphics", "NVIDIA GeForce RTX 5050 Laptop GPU". Falls back to the raw string. */
  readonly name: string;
  /** True when the advice about switching to a discrete GPU is worth showing: Windows AND the class is integrated or software. */
  readonly hybridHint: boolean;
}

const UNKNOWN_NAME = "Unknown GPU";

/** No hardware acceleration at all: the worst case, far below any integrated GPU. */
const SOFTWARE = ["swiftshader", "llvmpipe", "software", "microsoft basic render", "generic renderer"];
/** Backend token ANGLE appends as the last comma-separated field. */
const BACKEND = /^(?:d3d9|d3d11(?:on12)?|opengl(?: es)?|vulkan|metal)$/i;

/** Lowercase and drop the (R)/(TM) marks so "Intel(R) UHD" and "Radeon(TM) RX" match plain tokens. */
const normalize = (renderer: string): string =>
  renderer
    .toLowerCase()
    .replace(/\((?:r|tm|c)\)|[®™©]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Intel Arc is ambiguous: the discrete A/B-series cards and the integrated Xe-derived iGPU share the brand. Rule: an
 * Arc string is discrete only when it carries a model token - the letter A or B followed by 2-3 digits (A310, A770,
 * B580), optionally after "Pro". "Intel(R) Arc(TM) Graphics" has no model number, so it is the iGPU: integrated.
 */
const DISCRETE_ARC = /\barc\b[^a-z0-9]*(?:pro\s*)?[ab]\d{2,3}\b/;
/** Intel families that are always on-die. */
const INTEL_INTEGRATED = /\buhd\b|\bhd graphics\b|\biris\b|\bgma\b|\bxe graphics\b|graphics media accelerator/;

const classOf = (text: string): GpuClass => {
  if (text.length === 0) return "unknown";
  for (const token of SOFTWARE) if (text.includes(token)) return "software";

  if (text.includes("intel")) {
    if (DISCRETE_ARC.test(text)) return "discrete";
    // Every non-Arc Intel GPU is integrated, so any Intel "... Graphics" left here is an iGPU.
    if (INTEL_INTEGRATED.test(text) || text.includes("arc") || text.includes("graphics")) return "integrated";
  }

  if (/\bnvidia\b|\bgeforce\b|\bquadro\b|\brtx\b|\bgtx\b|\btitan\b|\btesla\b/.test(text)) return "discrete";
  // AMD: RX / Pro / FirePro are the add-in cards. "Radeon RX Vega" must be read as discrete before the Vega iGPU rule.
  if (/radeon\s*rx\b|radeon\s*pro\b|\bfirepro\b|\bfirestream\b/.test(text)) return "discrete";
  if (/radeon graphics|radeon vega|\bvega\b.*\bgraphics\b|\bryzen\b.*\bgraphics\b/.test(text)) return "integrated";
  if (DISCRETE_ARC.test(text)) return "discrete";

  // Integrated by architecture but fast - see the module comment: never warn on class alone.
  if (/\bapple\s*m\d\b|\bapple\s*a\d+\b|\bapple gpu\b/.test(text)) return "integrated";
  if (/\badreno\b|\bmali\b|\bpowervr\b|\bvideocore\b|\bimmortalis\b|\bxclipse\b/.test(text)) return "integrated";

  return "unknown";
};

/** Peels the ANGLE wrapper, the vendor id and the shader-model suffix off a renderer string. */
const extractName = (renderer: string): string => {
  const raw = renderer.trim();
  let text = raw;

  const angle = /^angle\s*\((.*)\)\s*$/is.exec(text);
  if (angle) {
    const fields = (angle[1] ?? "").split(",").map((field) => field.trim());
    if (fields.length > 1 && BACKEND.test(fields.at(-1) ?? "")) fields.pop();
    // What is left is "Vendor, Device" (modern ANGLE) or just "Device" (old ANGLE, no commas).
    text = (fields.length > 1 ? fields.slice(1) : fields).join(", ");
  }

  text = text
    .replace(/\s*\(0x[0-9a-f]+\)/gi, "")
    .replace(/\s*(?:direct3d\s*\d*\s*)?vs_\d+_\d+.*$/i, "")
    .replace(/\s*direct3d\s*\d*(?:on12)?\s*$/i, "")
    .replace(/\((?:r|tm|c)\)|[®™©]/gi, "")
    .replace(/\s+/g, " ")
    .replace(/[\s,]+$/, "")
    .trim();

  return text.length > 0 ? text : raw.length > 0 ? raw : UNKNOWN_NAME;
};

const isWindows = (userAgent: string): boolean => /windows nt|win32|win64|windows/i.test(userAgent);

/** Pure. `userAgent` is navigator.userAgent (used only to detect Windows). */
export function classifyGpu(renderer: string, userAgent: string): GpuInfo {
  const gpuClass = classOf(normalize(renderer ?? ""));
  return {
    renderer,
    gpuClass,
    name: extractName(renderer ?? ""),
    hybridHint: (gpuClass === "integrated" || gpuClass === "software") && isWindows(userAgent ?? ""),
  };
}
