import type { NavGrid } from "../types";
import { finishInfo } from "./buildNavGrid";
import { NavGridData, asNavGridData, type NavGridArrays, type NavPlacement, type NavPrefabLayer } from "./navGrid";

// Bytes form of a NavGrid for worker transfer or a bake: "TBNV", u32 header length, JSON header, then every typed array
// 8-byte aligned in header order. Deserialize verifies the checksum.

const MAGIC = 0x564e4254; // "TBNV" little-endian

type ArrayKind = "u8" | "u16" | "i32" | "f32";
const CTOR = { u8: Uint8Array, u16: Uint16Array, i32: Int32Array, f32: Float32Array } as const;

function kindOf(view: ArrayBufferView): ArrayKind {
  if (view instanceof Uint8Array) return "u8";
  if (view instanceof Uint16Array) return "u16";
  if (view instanceof Int32Array) return "i32";
  if (view instanceof Float32Array) return "f32";
  throw new Error("nav serialize: unsupported array type");
}

interface Header {
  readonly info: NavGridData["info"];
  readonly layout: NavGridData["layout"];
  readonly arrayKeys: readonly (keyof NavGridArrays)[];
  readonly layers: readonly Omit<NavPrefabLayer, "colStart" | "spanY" | "spanCol" | "spanFlags">[];
  readonly placements: readonly NavPlacement[];
  readonly arrays: readonly { readonly kind: ArrayKind; readonly length: number }[];
}

export function serializeNavGrid(grid: NavGrid): Uint8Array {
  const data = asNavGridData(grid);
  const arrayKeys = Object.keys(data.arrays) as (keyof NavGridArrays)[];
  const views: ArrayBufferView[] = arrayKeys.map((k) => data.arrays[k]);
  for (const l of data.layers) views.push(l.colStart, l.spanY, l.spanCol, l.spanFlags);
  const header: Header = {
    info: data.info,
    layout: data.layout,
    arrayKeys,
    layers: data.layers.map(({ prefab, minX, minZ, cols, rows, minY, maxY }) => ({ prefab, minX, minZ, cols, rows, minY, maxY })),
    placements: data.placements,
    arrays: views.map((v) => ({ kind: kindOf(v), length: (v as Uint8Array).length })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  let offset = align(8 + json.length);
  const offsets = views.map((v) => {
    const at = offset;
    offset = align(offset + v.byteLength);
    return at;
  });
  const out = new Uint8Array(offset);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, json.length, true);
  out.set(json, 8);
  views.forEach((v, i) => out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), offsets[i]!));
  return out;
}

/** `verify` (default true) recomputes the checksum (~80 ms on Map v1); skip it for trusted worker transfers. */
export function deserializeNavGrid(bytes: Uint8Array, options: { readonly verify?: boolean } = {}): NavGridData {
  // Copy into a fresh buffer so every typed array view is aligned.
  const buffer = new ArrayBuffer(align(bytes.byteLength));
  new Uint8Array(buffer).set(bytes);
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("nav deserialize: bad magic");
  const jsonLength = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, jsonLength))) as Header;
  let offset = align(8 + jsonLength);
  const views = header.arrays.map(({ kind, length }) => {
    const ctor = CTOR[kind];
    const view = new ctor(buffer, offset, length);
    offset = align(offset + view.byteLength);
    return view;
  });
  const arrays = {} as Record<keyof NavGridArrays, ArrayBufferView>;
  header.arrayKeys.forEach((key, i) => (arrays[key] = views[i]!));
  let next = header.arrayKeys.length;
  const layers: NavPrefabLayer[] = header.layers.map((meta) => ({
    ...meta,
    colStart: views[next++] as Int32Array,
    spanY: views[next++] as Float32Array,
    spanCol: views[next++] as Int32Array,
    spanFlags: views[next++] as Uint8Array,
  }));
  const typed = arrays as unknown as NavGridArrays;
  if (options.verify !== false) {
    const info = finishInfo(header.info, header.layout, typed, layers, header.placements, header.info.components);
    if (info.checksum !== header.info.checksum) throw new Error(`nav deserialize: checksum ${info.checksum} != ${header.info.checksum}`);
  }
  return new NavGridData(header.info, header.layout, typed, layers, header.placements, null);
}

function align(n: number): number {
  return (n + 7) & ~7;
}
