// Minimal dependency-free image I/O: Radiance RGBE (.hdr) read/write and 24-bit BMP read/write.
// Heavy lifting (resampling, JPEG encoding) is delegated to macOS `sips` and `ffmpeg` in process.mjs.

/** Decodes a Radiance .hdr (new-style RLE or flat) into linear float RGB, rows top to bottom. */
export function readHdr(buffer) {
  let pos = 0;
  const readLine = () => {
    let end = buffer.indexOf(0x0a, pos);
    if (end < 0) end = buffer.length;
    const line = buffer.toString("latin1", pos, end);
    pos = end + 1;
    return line;
  };
  if (!readLine().startsWith("#?")) throw new Error("Not a Radiance HDR file");
  for (let line = readLine(); line !== ""; line = readLine()) {
    if (line.startsWith("FORMAT=") && line !== "FORMAT=32-bit_rle_rgbe") throw new Error(`Unsupported ${line}`);
  }
  const match = /^-Y (\d+) \+X (\d+)$/.exec(readLine());
  if (!match) throw new Error("Unsupported HDR orientation (expected -Y H +X W)");
  const height = Number(match[1]);
  const width = Number(match[2]);

  const data = new Float32Array(width * height * 3);
  const scanline = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    const rle = width >= 8 && width < 32768 && buffer[pos] === 2 && buffer[pos + 1] === 2 && !(buffer[pos + 2] & 0x80);
    if (rle) {
      if (((buffer[pos + 2] << 8) | buffer[pos + 3]) !== width) throw new Error("Bad RLE scanline width");
      pos += 4;
      for (let c = 0; c < 4; c++) {
        for (let x = 0; x < width; ) {
          let count = buffer[pos++];
          if (count > 128) {
            count -= 128;
            const value = buffer[pos++];
            for (let k = 0; k < count; k++) scanline[(x + k) * 4 + c] = value;
          } else {
            for (let k = 0; k < count; k++) scanline[(x + k) * 4 + c] = buffer[pos++];
          }
          x += count;
        }
      }
    } else {
      scanline.set(buffer.subarray(pos, pos + width * 4));
      pos += width * 4;
    }
    for (let x = 0; x < width; x++) {
      const e = scanline[x * 4 + 3];
      const f = e === 0 ? 0 : Math.pow(2, e - 136); // 2^(e-128) / 256
      const o = (y * width + x) * 3;
      data[o] = (scanline[x * 4] + 0.5) * f;
      data[o + 1] = (scanline[x * 4 + 1] + 0.5) * f;
      data[o + 2] = (scanline[x * 4 + 2] + 0.5) * f;
    }
  }
  return { width, height, data };
}

/** Encodes linear float RGB (rows top to bottom) as a new-style RLE Radiance .hdr. */
export function writeHdr({ width, height, data }) {
  const header = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, "latin1");
  const chunks = [header];
  const rgbe = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const max = Math.max(r, g, b);
      if (max < 1e-32) {
        rgbe.fill(0, x * 4, x * 4 + 4);
        continue;
      }
      const exponent = Math.ceil(Math.log2(max) + 1e-9);
      const scale = 256 / Math.pow(2, exponent);
      rgbe[x * 4] = Math.min(255, Math.floor(r * scale));
      rgbe[x * 4 + 1] = Math.min(255, Math.floor(g * scale));
      rgbe[x * 4 + 2] = Math.min(255, Math.floor(b * scale));
      rgbe[x * 4 + 3] = exponent + 128;
    }
    const line = [2, 2, width >> 8, width & 0xff];
    for (let c = 0; c < 4; c++) encodeRleChannel(rgbe, c, width, line);
    chunks.push(Buffer.from(line));
  }
  return Buffer.concat(chunks);
}

function encodeRleChannel(rgbe, c, width, out) {
  const at = (x) => rgbe[x * 4 + c];
  let x = 0;
  while (x < width) {
    // Find the next run of at least 4 equal bytes.
    let runStart = x;
    let runLength = 0;
    while (runStart < width) {
      runLength = 1;
      while (runStart + runLength < width && runLength < 127 && at(runStart + runLength) === at(runStart)) runLength++;
      if (runLength >= 4) break;
      runStart += runLength;
    }
    if (runLength < 4) runStart = width;
    // Literal bytes before the run.
    while (x < runStart) {
      const count = Math.min(128, runStart - x);
      out.push(count);
      for (let k = 0; k < count; k++) out.push(at(x + k));
      x += count;
    }
    if (runStart < width) {
      out.push(128 + runLength, at(runStart));
      x = runStart + runLength;
    }
  }
}

/** Writes 8-bit RGB (rows top to bottom) as an uncompressed 24-bit BMP. */
export function writeBmp(width, height, rgb) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + rowSize * height);
  buf.write("BM", 0, "latin1");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(-height, 22); // top-down
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(rowSize * height, 34);
  for (let y = 0; y < height; y++) {
    const row = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      buf[row + x * 3] = rgb[i + 2];
      buf[row + x * 3 + 1] = rgb[i + 1];
      buf[row + x * 3 + 2] = rgb[i];
    }
  }
  return buf;
}

/** Reads an uncompressed 24/32-bit BMP into 8-bit RGB rows top to bottom. */
export function readBmp(buf) {
  if (buf.toString("latin1", 0, 2) !== "BM") throw new Error("Not a BMP");
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  if (buf.readUInt32LE(30) !== 0 && buf.readUInt32LE(30) !== 3) throw new Error("Compressed BMP not supported");
  if (bpp !== 24 && bpp !== 32) throw new Error(`Unsupported BMP depth ${bpp}`);
  const height = Math.abs(rawHeight);
  const bytes = bpp / 8;
  const rowSize = Math.ceil((width * bytes) / 4) * 4;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const srcRow = rawHeight > 0 ? height - 1 - y : y;
    const row = offset + srcRow * rowSize;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      rgb[i] = buf[row + x * bytes + 2];
      rgb[i + 1] = buf[row + x * bytes + 1];
      rgb[i + 2] = buf[row + x * bytes];
    }
  }
  return { width, height, rgb };
}
