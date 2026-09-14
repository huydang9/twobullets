import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function hashBytes(...parts: (Uint8Array | string)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex").slice(0, 16);
}

export async function hashFiles(paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(path);
    hash.update(await readFile(path));
  }
  return hash.digest("hex").slice(0, 16);
}

/** JSON-serializable build records keyed by output id; an entry is reused when its input key matches. */
export class StampStore {
  private saving = Promise.resolve();
  private readonly file: string;
  private readonly entries: Record<string, { key: string; value: unknown }>;

  private constructor(file: string, entries: Record<string, { key: string; value: unknown }>) {
    this.file = file;
    this.entries = entries;
  }

  static async open(cacheDir: string): Promise<StampStore> {
    const file = join(cacheDir, "stamps.json");
    try {
      return new StampStore(file, JSON.parse(await readFile(file, "utf8")));
    } catch {
      return new StampStore(file, {});
    }
  }

  /** The recorded value; when `key` is given, only if it was built from that input key. */
  get<T>(id: string, key?: string): T | undefined {
    const entry = this.entries[id];
    return entry && (key === undefined || entry.key === key) ? (entry.value as T) : undefined;
  }

  set(id: string, key: string, value: unknown): void {
    this.entries[id] = { key, value };
  }

  /** Serialized so concurrent builds never interleave writes. */
  save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.entries, null, 2));
    });
    return this.saving;
  }
}
