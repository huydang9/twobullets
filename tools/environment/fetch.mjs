#!/usr/bin/env node
// Downloads the CC0 Poly Haven textures and HDRI listed in config.mjs into assets-src/environment/,
// verifying MD5s, and writes credits.json next to the web-ready outputs.
// Usage: node tools/environment/fetch.mjs
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { HDRI, OUT_DIR, POLY_HAVEN_API, SRC_DIR, TEXTURE_MAPS, TEXTURES } from "./config.mjs";

const USER_AGENT = "twobullets-environment-pipeline";

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.json();
}

async function md5Of(file) {
  try {
    return createHash("md5").update(await readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

async function download(url, file, md5) {
  if ((await md5Of(file)) === md5) {
    console.log(`  cached  ${path.relative(SRC_DIR, file)}`);
    return;
  }
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash("md5").update(bytes).digest("hex");
  if (actual !== md5) throw new Error(`MD5 mismatch for ${url}: expected ${md5}, got ${actual}`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  console.log(`  fetched ${path.relative(SRC_DIR, file)} (${(bytes.length / 1e6).toFixed(2)} MB)`);
}

async function main() {
  const credits = [];

  for (const { id, macroOnly } of TEXTURES) {
    console.log(id);
    const [info, files] = await Promise.all([getJson(`${POLY_HAVEN_API}/info/${id}`), getJson(`${POLY_HAVEN_API}/files/${id}`)]);
    const maps = macroOnly ? { Diffuse: TEXTURE_MAPS.Diffuse } : TEXTURE_MAPS;
    const downloaded = [];
    for (const [key, suffix] of Object.entries(maps)) {
      const entry = files[key]?.["2k"]?.jpg;
      if (!entry) throw new Error(`${id} has no 2k jpg for ${key}`);
      await download(entry.url, path.join(SRC_DIR, id, `${id}_${suffix}_2k.jpg`), entry.md5);
      downloaded.push(entry.url);
    }
    credits.push(creditEntry(id, info, "texture", downloaded));
  }

  console.log(HDRI.id);
  const [info, files] = await Promise.all([getJson(`${POLY_HAVEN_API}/info/${HDRI.id}`), getJson(`${POLY_HAVEN_API}/files/${HDRI.id}`)]);
  const entry = files.hdri?.[HDRI.resolution]?.hdr;
  if (!entry) throw new Error(`${HDRI.id} has no ${HDRI.resolution} hdr`);
  await download(entry.url, path.join(SRC_DIR, HDRI.id, `${HDRI.id}_${HDRI.resolution}.hdr`), entry.md5);
  credits.push(creditEntry(HDRI.id, info, "hdri", [entry.url]));

  await mkdir(OUT_DIR, { recursive: true });
  const creditsFile = path.join(OUT_DIR, "credits.json");
  const body = {
    source: "Poly Haven (https://polyhaven.com)",
    license: "CC0 1.0 Universal (public domain). Attribution is not required but given here.",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    retrieved: new Date().toISOString().slice(0, 10),
    assets: credits,
  };
  await writeFile(creditsFile, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), creditsFile)} (${(await stat(creditsFile)).size} B)`);
}

function creditEntry(id, info, type, files) {
  return {
    id,
    name: info.name,
    type,
    authors: Object.entries(info.authors ?? {}).map(([name, role]) => ({ name: name.trim(), role: role.trim() })),
    license: "CC0",
    url: `https://polyhaven.com/a/${id}`,
    sourceFiles: files,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
