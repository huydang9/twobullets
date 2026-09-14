// contentHash (netcode.md §6.8, architecture.md D10): a u32 over everything client prediction and the server must agree
// on. Canonical serialization (sorted keys, ECMAScript number-to-string, which is exact across engines) + FNV-1a.
// `packages/protocol/scripts/content-hash.ts` writes the result into version.ts; a test fails when it is stale.

function fnv1a(hash: number, text: string): number {
  let h = hash;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h;
}

function canonical(value: unknown, out: string[]): void {
  if (value === null || value === undefined) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "number":
      out.push(Object.is(value, -0) ? "0" : String(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "function":
      throw new TypeError("contentHash inputs must be plain data (found a function)");
    default:
      break;
  }
  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(",");
      canonical(value[i], out);
    }
    out.push("]");
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  out.push("{");
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out.push(",");
    out.push(JSON.stringify(keys[i]!), ":");
    canonical(record[keys[i]!], out);
  }
  out.push("}");
}

/** Canonical text of plain data (sorted keys); exposed for diffing stale hashes. */
export function canonicalContent(value: unknown): string {
  const parts: string[] = [];
  canonical(value, parts);
  return parts.join("");
}

export function computeContentHash(inputs: unknown): number {
  return fnv1a(0x811c9dc5, canonicalContent(inputs)) >>> 0;
}
