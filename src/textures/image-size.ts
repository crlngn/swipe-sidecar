import fs from "node:fs";

/**
 * Read image dimensions from the file header only (PNG, JPEG, WebP, GIF), so a world with hundreds of
 * images can be sized in milliseconds without decoding anything.
 */
export interface ImageInfo {
  width: number;
  height: number;
  format: "png" | "jpeg" | "webp" | "gif";
  /** Animated WebP or GIF: not a still image, never compressed. */
  animated: boolean;
}

export function readImageInfo(file: string): ImageInfo | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, n);
    return parsePng(buf) ?? parseWebp(buf) ?? parseGif(buf) ?? parseJpeg(buf);
  } catch {
    return null;
  } finally {
    if ( fd !== null ) fs.closeSync(fd);
  }
}

function parsePng(b: Buffer): ImageInfo | null {
  if ( b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 ) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: "png", animated: b.includes("acTL") };
}

function parseGif(b: Buffer): ImageInfo | null {
  if ( b.length < 10 || b.toString("ascii", 0, 3) !== "GIF" ) return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), format: "gif", animated: true };
}

function parseWebp(b: Buffer): ImageInfo | null {
  if ( b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP" ) return null;
  const chunk = b.toString("ascii", 12, 16);
  if ( chunk === "VP8X" ) {
    const flags = b[20];
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width, height, format: "webp", animated: !!(flags & 0x02) };
  }
  if ( chunk === "VP8L" ) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp", animated: false };
  }
  if ( chunk === "VP8 " ) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, format: "webp", animated: false };
  }
  return null;
}

function parseJpeg(b: Buffer): ImageInfo | null {
  if ( b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 ) return null;
  let i = 2;
  while ( i + 9 < b.length ) {
    if ( b[i] !== 0xff ) { i++; continue; }
    const marker = b[i + 1];
    if ( marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) ) { i += 2; continue; }
    const length = b.readUInt16BE(i + 2);
    if ( (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc ) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), format: "jpeg", animated: false };
    }
    i += 2 + length;
  }
  return null;
}
