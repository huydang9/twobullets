// Downloads the audio sources listed in sources.ts into assets-src/audio/downloads/ with size checks,
// then extracts archives into assets-src/audio/sources/<id>/ (bsdtar reads 7z and zip; no 7z binary needed).
// Usage: node tools/audio/fetch.ts [--only=<id>]
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DOWNLOAD_DIR, EXTRACT_DIR, MAX_DOWNLOAD_BYTES, OWNER_DIR, SOURCES, type AudioSource } from "./sources.ts";

setTimeout(() => {
  console.error("fetch: timed out after 20 minutes");
  process.exit(2);
}, 20 * 60_000).unref();

const USER_AGENT = "Mozilla/5.0 (twobullets audio pipeline)";
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);

async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

function expectedSize(source: AudioSource): number {
  return source.rangeBytes !== undefined ? Math.min(source.rangeBytes, source.bytes) : source.bytes;
}

async function download(source: AudioSource): Promise<void> {
  const file = path.join(DOWNLOAD_DIR, source.file);
  const expected = expectedSize(source);
  if ((await sizeOf(file)) === expected) {
    console.log(`  cached  ${source.file} (${mb(expected)})`);
    return;
  }

  const head = await fetch(source.url, { method: "HEAD", headers: { "User-Agent": USER_AGENT } });
  const length = Number(head.headers.get("content-length"));
  if (!head.ok || length !== source.bytes) {
    throw new Error(`${source.id}: expected ${source.bytes} B at ${source.url}, server reports ${head.status} / ${length} B`);
  }

  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (source.rangeBytes !== undefined) headers.Range = `bytes=0-${expected - 1}`;
  const response = await fetch(source.url, { headers });
  if (!response.ok || !response.body) throw new Error(`${source.id}: GET ${response.status}`);
  const part = `${file}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
  const got = await sizeOf(part);
  if (got !== expected) throw new Error(`${source.id}: downloaded ${got} B, expected ${expected} B`);
  await rename(part, file);
  console.log(`  fetched ${source.file} (${mb(expected)})`);
}

async function extract(source: AudioSource): Promise<void> {
  if (!source.archive) return;
  const target = path.join(EXTRACT_DIR, source.id);
  const existing = await readdir(target).catch(() => []);
  if (existing.length > 0) {
    console.log(`  extracted already: sources/${source.id}`);
    return;
  }
  await mkdir(target, { recursive: true });
  const result = spawnSync("bsdtar", ["-xf", path.join(DOWNLOAD_DIR, source.file), "-C", target], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${source.id}: bsdtar failed (${result.status}); install 7z/unar if this archive uses an unsupported codec`);
  console.log(`  extracted sources/${source.id}`);
}

async function main(): Promise<void> {
  // Owner-supplied clips are never downloaded; only check that they were copied in.
  for (const source of SOURCES.filter((s) => s.ownerSupplied && (!only || s.id === only))) {
    const size = await sizeOf(path.join(OWNER_DIR, source.file));
    console.log(`  ${size === source.bytes ? "present" : "MISSING"} ${source.file} (owner-supplied, copy into assets-src/audio/owner/)`);
  }
  const selected = SOURCES.filter((s) => !s.ownerSupplied && (!only || s.id === only));
  const total = selected.reduce((sum, s) => sum + expectedSize(s), 0);
  if (total > MAX_DOWNLOAD_BYTES) throw new Error(`Refusing to download ${mb(total)} (cap ${mb(MAX_DOWNLOAD_BYTES)})`);
  console.log(`Audio sources: ${selected.length}, ${mb(total)} total`);
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  // Sequential on purpose: one big transfer and one extraction at a time.
  for (const source of selected) {
    console.log(source.id);
    await download(source);
    await extract(source);
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
