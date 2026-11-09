import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import type { SidecarConfig } from "../config.ts";
import { readImageInfo, type ImageInfo } from "./image-size.ts";

/**
 * KTX2 texture service.
 *
 * Scene-level backgrounds and large tiles are the textures that fill a phone's GPU: a 4200x4350 map is 73 MB as
 * RGBA. The same image as a KTX2 UASTC file transcodes on the device to ASTC (phones, Apple) or BC7 (desktop)
 * and costs a quarter of that, and Foundry v14 ships the KTX2 parser and transcoder already. Swipe Sidecar encodes such
 * images once with the Basis Universal encoder (`basisu`, prebuilt binaries from npm), downscaled first to the
 * profile's cap, and keeps the result in its own data folder. The document policy then rewrites `texture.src`
 * for trimmed clients to `swipe-sidecar/textures/<key>.ktx2`; nothing in Foundry's data folder is touched.
 *
 * Encoding is opt-in per world (it takes disk space and CPU), runs one file at a time at low priority, and the
 * original is served until the compressed file exists. UASTC only: ETC1S halos text and streaks gradients.
 */
export interface TextureConfig {
  /** Master switch; a world must also opt in. */
  enabled: boolean;
  /** Where compressed files live. Defaults to <dataDir>/textures. */
  cacheDir: string;
  /** Cache cap; least recently served files go first. */
  maxBytes: number;
  /** Longest side after downscaling, per profile; null disables rewriting for that profile. */
  caps: { phone: number | null; tablet: number | null; desktop: number | null };
  /** Images whose longest side is at or below this stay as they are. */
  minDimension: number;
  /** Bake mipmaps into the file (a third more GPU memory, no shimmer when zoomed out). */
  mipmaps: boolean;
}

export const TEXTURE_DEFAULTS: TextureConfig = {
  enabled: true,
  cacheDir: "",
  maxBytes: 1024 * 1024 * 1024,
  caps: { phone: 2048, tablet: 2048, desktop: null },
  minDimension: 1024,
  mipmaps: true
};

interface Entry {
  key: string;
  source: string;
  file: string;
  mtimeMs: number;
  cap: number;
  width: number;
  height: number;
  outWidth: number;
  outHeight: number;
  bytes: number;
  createdAt: number;
  lastUsed: number;
}

interface Index {
  worlds: Record<string, { enabled: boolean; decidedAt: number }>;
  entries: Record<string, Entry>;
}

interface Job {
  key: string;
  source: string;
  file: string;
  cap: number;
  info: ImageInfo;
  mtimeMs: number;
}

/** Foundry serves these folders from its install, not the user data folder. */
const PUBLIC_FOLDERS = new Set(["ui", "icons", "cards", "css", "fonts", "lang", "scripts", "sounds"]);
const STILL_FORMATS = new Set(["png", "jpeg", "webp"]);
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
export const TEXTURE_URL_PREFIX = "swipe-sidecar/textures/";
const KEY_RE = /swipe-sidecar\/textures\/([a-f0-9]{20})\.ktx2/g;

export class TextureService {
  #config: TextureConfig;
  #dataPath: string | null;
  #installPath: string | null;
  #indexFile: string;
  #index: Index = { worlds: {}, entries: {} };
  #binary: string | null;
  #sharpError: string | null;
  #queue: Job[] = [];
  #inFlight: Job | null = null;
  #queued = new Set<string>();
  #failed = new Map<string, string>();
  #infoCache = new Map<string, { mtimeMs: number; info: ImageInfo | null }>();
  #log: (message: string) => void;
  stats = { encoded: 0, served: 0, rewritten: 0, failed: 0, evicted: 0 };

  constructor(config: SidecarConfig, log: (message: string) => void) {
    const tex = (config as any).textures ?? {};
    this.#config = {
      ...TEXTURE_DEFAULTS, ...tex,
      caps: { ...TEXTURE_DEFAULTS.caps, ...(tex.caps ?? {}) },
      cacheDir: tex.cacheDir ? path.resolve(tex.cacheDir) : path.join(config.dataDir, "textures")
    };
    this.#dataPath = config.foundry.dataPath ? path.join(config.foundry.dataPath, "Data") : null;
    this.#installPath = config.foundry.installPath ? path.join(config.foundry.installPath, "public") : null;
    this.#indexFile = path.join(this.#config.cacheDir, "index.json");
    this.#log = log;
    this.#binary = findBasisu();
    this.#sharpError = probeSharp();
    if ( this.#config.enabled && this.missing.length ) {
      this.#log(`textures: compressed textures unavailable, optional package(s) missing or unusable on this platform: ${this.missing.join(", ")}. Everything else works; run "npm install --include=optional" to enable them.`);
    }
    fs.mkdirSync(path.join(this.#config.cacheDir, "tmp"), { recursive: true });
    this.#load();
  }

  /* -------------------------------------------- */
  /*  State                                       */
  /* -------------------------------------------- */

  get available(): boolean {
    return this.#config.enabled && !!this.#binary && !this.#sharpError && !!this.#dataPath;
  }

  /** Optional packages the encoder needs that are missing or failed to load on this platform. */
  get missing(): string[] {
    const out: string[] = [];
    if ( !this.#binary ) out.push("basisu");
    if ( this.#sharpError ) out.push("sharp");
    return out;
  }

  get config(): TextureConfig {
    return this.#config;
  }

  worldEnabled(worldId: string | null | undefined): boolean {
    return !!worldId && this.available && (this.#index.worlds[worldId]?.enabled ?? false);
  }

  setWorld(worldId: string, enabled: boolean): void {
    this.#index.worlds[worldId] = { enabled, decidedAt: Date.now() };
    this.#save();
  }

  capFor(profile: string): number | null {
    return (this.#config.caps as any)[profile] ?? null;
  }

  #load(): void {
    try {
      if ( fs.existsSync(this.#indexFile) ) this.#index = { worlds: {}, entries: {}, ...JSON.parse(fs.readFileSync(this.#indexFile, "utf8")) };
    } catch { this.#index = { worlds: {}, entries: {} }; }
    // Drop entries whose file went missing.
    for ( const [key, e] of Object.entries(this.#index.entries) ) {
      if ( !fs.existsSync(path.join(this.#config.cacheDir, `${key}.ktx2`)) ) delete this.#index.entries[key];
    }
  }

  #save(): void {
    fs.writeFileSync(this.#indexFile, JSON.stringify(this.#index, null, 2) + "\n");
  }

  /* -------------------------------------------- */
  /*  Sources                                     */
  /* -------------------------------------------- */

  /** Map a document texture path to a file on disk, or null when it is not a local still image. */
  resolveSource(src: unknown): { rel: string; file: string } | null {
    if ( typeof src !== "string" || !src ) return null;
    let rel = src.split("?")[0].split("#")[0];
    if ( /^[a-z]+:\/\//i.test(rel) || rel.startsWith("data:") || rel.startsWith("blob:") ) return null;
    try { rel = decodeURIComponent(rel); } catch {}
    rel = rel.replace(/^\/+/, "");
    if ( !IMAGE_EXT.test(rel) || rel.includes("..") ) return null;
    const top = rel.split("/")[0];
    const base = PUBLIC_FOLDERS.has(top) ? this.#installPath : this.#dataPath;
    if ( !base ) return null;
    const file = path.join(base, rel);
    if ( !file.startsWith(base + path.sep) ) return null;
    return { rel, file };
  }

  #info(file: string): { info: ImageInfo | null; mtimeMs: number } | null {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return null; }
    const cached = this.#infoCache.get(file);
    if ( cached && cached.mtimeMs === stat.mtimeMs ) return { info: cached.info, mtimeMs: stat.mtimeMs };
    const info = readImageInfo(file);
    this.#infoCache.set(file, { mtimeMs: stat.mtimeMs, info });
    return { info, mtimeMs: stat.mtimeMs };
  }

  /** A still image larger than the floor, on disk. */
  #eligible(src: unknown): Job | null {
    const resolved = this.resolveSource(src);
    if ( !resolved ) return null;
    const meta = this.#info(resolved.file);
    if ( !meta?.info || meta.info.animated || !STILL_FORMATS.has(meta.info.format) ) return null;
    if ( Math.max(meta.info.width, meta.info.height) <= this.#config.minDimension ) return null;
    return { key: "", source: resolved.rel, file: resolved.file, cap: 0, info: meta.info, mtimeMs: meta.mtimeMs };
  }

  #keyFor(job: Job): string {
    const mip = this.#config.mipmaps ? "mip" : "nomip";
    return crypto.createHash("sha1").update(`${job.source}|${job.mtimeMs}|${job.cap}|uastc|${mip}`).digest("hex").slice(0, 20);
  }

  /* -------------------------------------------- */
  /*  Lookup and rewrite                          */
  /* -------------------------------------------- */

  /**
   * The compressed URL for a source at a profile cap, or null. When the file is not there yet, the encode is
   * queued and the caller keeps the original path this time.
   */
  lookup(src: unknown, cap: number | null): string | null {
    if ( !this.available || cap === null ) return null;
    const job = this.#eligible(src);
    if ( !job ) return null;
    job.cap = cap;
    job.key = this.#keyFor(job);
    const entry = this.#index.entries[job.key];
    if ( entry ) {
      entry.lastUsed = Date.now();
      this.stats.rewritten++;
      return `${TEXTURE_URL_PREFIX}${job.key}.ktx2`;
    }
    this.ensure(src, cap);
    return null;
  }

  /** Queue an encode for a source if it is eligible and not cached. Returns true when queued. */
  ensure(src: unknown, cap: number | null): boolean {
    if ( !this.available || cap === null ) return false;
    const job = this.#eligible(src);
    if ( !job ) return false;
    job.cap = cap;
    job.key = this.#keyFor(job);
    if ( this.#index.entries[job.key] || this.#queued.has(job.key) || this.#failed.has(job.key) ) return false;
    this.#queued.add(job.key);
    this.#queue.push(job);
    this.#drain();
    return true;
  }

  /** The texture fields of a scene-side document, in place of a schema: what the rewrite touches. */
  static textureFields(type: string, doc: any): Array<{ get: () => unknown; set: (v: string) => void }> {
    const out: Array<{ get: () => unknown; set: (v: string) => void }> = [];
    const at = (obj: any, key: string) => {
      if ( obj && typeof obj === "object" && typeof obj[key] === "string" ) out.push({ get: () => obj[key], set: v => { obj[key] = v; } });
    };
    if ( !doc || typeof doc !== "object" ) return out;
    if ( type === "Scene" ) {
      at(doc.background, "src"); at(doc.foreground, "src"); at(doc, "background.src"); at(doc, "foreground.src");
      for ( const level of Array.isArray(doc.levels) ? doc.levels : [] ) { at(level?.background, "src"); at(level?.foreground, "src"); }
      for ( const tile of Array.isArray(doc.tiles) ? doc.tiles : [] ) at(tile?.texture, "src");
    }
    else if ( type === "Level" ) { at(doc.background, "src"); at(doc.foreground, "src"); at(doc, "background.src"); at(doc, "foreground.src"); }
    else if ( type === "Tile" ) { at(doc.texture, "src"); at(doc, "texture.src"); }
    return out;
  }

  /**
   * Return a copy of a Scene, Level or Tile document with large texture paths pointing at compressed files,
   * or the same object when nothing changes. Encodes are queued for anything eligible but missing.
   */
  rewriteDoc(type: string, doc: any, cap: number | null, worldId: string | null): any {
    if ( !this.worldEnabled(worldId) || cap === null ) return doc;
    const probe = TextureService.textureFields(type, doc);
    if ( !probe.length ) return doc;
    let copy: any = null;
    const fields = () => TextureService.textureFields(type, copy);
    probe.forEach((field, i) => {
      const url = this.lookup(field.get(), cap);
      if ( !url ) return;
      if ( !copy ) copy = structuredClone(doc);
      fields()[i].set(url);
    });
    return copy ?? doc;
  }

  /** Queue encodes for every large texture a document references. */
  ensureDoc(type: string, doc: any, worldId: string | null): void {
    if ( !this.worldEnabled(worldId) ) return;
    const caps = new Set([this.#config.caps.phone, this.#config.caps.tablet].filter((c): c is number => c !== null));
    for ( const field of TextureService.textureFields(type, doc) ) for ( const cap of caps ) this.ensure(field.get(), cap);
  }

  /** Put original paths back in a frame a client sends upstream, so no compressed path is ever saved. */
  restore(text: string): string {
    if ( !text.includes(TEXTURE_URL_PREFIX) ) return text;
    return text.replace(KEY_RE, (match, key) => this.#index.entries[key]?.source ?? match);
  }

  sourceOf(key: string): string | null {
    return this.#index.entries[key]?.source ?? null;
  }

  /* -------------------------------------------- */
  /*  Estimate                                    */
  /* -------------------------------------------- */

  /** Disk the compressed versions of these sources would take, before encoding anything. */
  estimate(sources: Iterable<unknown>, cap: number | null): { count: number; bytes: number; largest: Array<{ source: string; width: number; height: number; bytes: number }>; skipped: number } {
    const seen = new Set<string>();
    const items: Array<{ source: string; width: number; height: number; bytes: number }> = [];
    let skipped = 0;
    for ( const src of sources ) {
      const job = this.#eligible(src);
      if ( !job ) { if ( typeof src === "string" && src ) skipped++; continue; }
      if ( seen.has(job.source) ) continue;
      seen.add(job.source);
      const [w, h] = fit(job.info.width, job.info.height, cap ?? Infinity);
      items.push({ source: job.source, width: job.info.width, height: job.info.height, bytes: estimateBytes(w, h, this.#config.mipmaps) });
    }
    items.sort((a, b) => b.bytes - a.bytes);
    return { count: items.length, bytes: items.reduce((s, i) => s + i.bytes, 0), largest: items.slice(0, 8), skipped };
  }

  /* -------------------------------------------- */
  /*  Encoding                                    */
  /* -------------------------------------------- */

  #drain(): void {
    if ( this.#inFlight || !this.#queue.length ) return;
    const job = this.#queue.shift()!;
    this.#inFlight = job;
    this.#encode(job).then(entry => {
      this.#index.entries[entry.key] = entry;
      this.stats.encoded++;
      this.#log(`textures: encoded ${entry.source} ${entry.width}x${entry.height} -> ${entry.outWidth}x${entry.outHeight} UASTC, ${(entry.bytes / 1048576).toFixed(1)} MB (${this.#queue.length} queued)`);
      this.#evict();
      this.#save();
    }).catch(err => {
      this.stats.failed++;
      this.#failed.set(job.key, String(err?.message ?? err));
      this.#log(`textures: failed ${job.source}: ${err?.message ?? err}`);
    }).finally(() => {
      this.#queued.delete(job.key);
      this.#inFlight = null;
      this.#drain();
    });
  }

  async #encode(job: Job): Promise<Entry> {
    const sharp = (await import("sharp")).default;
    const tmpPng = path.join(this.#config.cacheDir, "tmp", `${job.key}.png`);
    const out = path.join(this.#config.cacheDir, `${job.key}.ktx2`);
    const [outWidth, outHeight] = fit(job.info.width, job.info.height, job.cap);
    const started = Date.now();
    try {
      await sharp(job.file, { limitInputPixels: false })
        .resize({ width: outWidth, height: outHeight, fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 1 })
        .toFile(tmpPng);
      const args = ["-ktx2", "-uastc", "-uastc_level", "2", "-uastc_rdo_l", "1.0", "-output_file", out, tmpPng];
      if ( this.#config.mipmaps ) args.splice(2, 0, "-mipmap");
      await new Promise<void>((resolve, reject) => {
        const child = execFile(this.#binary!, args, { maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
          if ( err ) reject(new Error(`basisu: ${stderr?.toString().trim().split("\n").pop() ?? err.message}`));
          else resolve();
        });
        try { if ( child.pid ) os.setPriority(child.pid, 19); } catch {}
      });
      const bytes = fs.statSync(out).size;
      this.#log(`textures: ${job.source} took ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return { key: job.key, source: job.source, file: job.file, mtimeMs: job.mtimeMs, cap: job.cap, width: job.info.width, height: job.info.height, outWidth, outHeight, bytes, createdAt: Date.now(), lastUsed: Date.now() };
    } finally {
      try { fs.unlinkSync(tmpPng); } catch {}
    }
  }

  #evict(): void {
    const entries = Object.values(this.#index.entries);
    let total = entries.reduce((s, e) => s + e.bytes, 0);
    if ( total <= this.#config.maxBytes ) return;
    for ( const e of entries.sort((a, b) => a.lastUsed - b.lastUsed) ) {
      if ( total <= this.#config.maxBytes ) break;
      try { fs.unlinkSync(path.join(this.#config.cacheDir, `${e.key}.ktx2`)); } catch {}
      delete this.#index.entries[e.key];
      total -= e.bytes;
      this.stats.evicted++;
    }
  }

  /** Remove every compressed file; world opt-ins are kept. */
  clear(): number {
    const n = Object.keys(this.#index.entries).length;
    for ( const key of Object.keys(this.#index.entries) ) {
      try { fs.unlinkSync(path.join(this.#config.cacheDir, `${key}.ktx2`)); } catch {}
    }
    this.#index.entries = {};
    this.#save();
    return n;
  }

  /* -------------------------------------------- */
  /*  Serving                                     */
  /* -------------------------------------------- */

  /** The file for a compressed texture key, marking it used. */
  fileFor(key: string): string | null {
    const entry = this.#index.entries[key];
    if ( !entry ) return null;
    entry.lastUsed = Date.now();
    this.stats.served++;
    return path.join(this.#config.cacheDir, `${key}.ktx2`);
  }

  status(): object {
    const entries = Object.values(this.#index.entries);
    return {
      available: this.available,
      enabled: this.#config.enabled,
      binary: this.#binary,
      missing: this.missing,
      sharpError: this.#sharpError,
      cacheDir: this.#config.cacheDir,
      caps: this.#config.caps,
      minDimension: this.#config.minDimension,
      mipmaps: this.#config.mipmaps,
      maxBytes: this.#config.maxBytes,
      bytes: entries.reduce((s, e) => s + e.bytes, 0),
      files: entries.length,
      queued: this.#queue.length + (this.#inFlight ? 1 : 0),
      encoding: this.#inFlight?.source ?? null,
      failed: Object.fromEntries(this.#failed),
      worlds: this.#index.worlds,
      stats: this.stats
    };
  }

  entries(): Entry[] {
    return Object.values(this.#index.entries).sort((a, b) => b.bytes - a.bytes);
  }
}

/* -------------------------------------------- */

function fit(width: number, height: number, cap: number): [number, number] {
  const longest = Math.max(width, height);
  if ( longest <= cap ) return [width, height];
  const scale = cap / longest;
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/** UASTC is 8 bits per pixel before supercompression; zstd roughly halves it on typical maps. */
function estimateBytes(width: number, height: number, mipmaps: boolean): number {
  return Math.round(width * height * 0.5 * (mipmaps ? 4 / 3 : 1) * 1.1);
}

/**
 * Load sharp once to confirm its native binding exists for this platform. Returns null when it loads, or the
 * first line of the load error (a failed or skipped optional install leaves the package without its binding).
 */
function probeSharp(): string | null {
  try {
    createRequire(import.meta.url)("sharp");
    return null;
  } catch ( err: any ) {
    return String(err?.message ?? err).split("\n")[0];
  }
}

function findBasisu(): string | null {
  const require = createRequire(import.meta.url);
  const candidates: string[] = [];
  try { candidates.push((require("basisu") as { path: string }).path); } catch {}
  try {
    const dir = path.dirname(require.resolve("basisu/package.json"));
    const platform = process.platform === "win32" ? "win" : process.platform;
    const exe = platform === "win" ? "basisu.exe" : "basisu";
    for ( const arch of [process.arch, `${process.arch}_sse`, "x64_sse", "x64"] ) candidates.push(path.join(dir, "bin", platform, arch, exe));
  } catch {}
  for ( const file of candidates ) {
    if ( file && fs.existsSync(file) ) {
      try { fs.chmodSync(file, 0o755); } catch {}
      return file;
    }
  }
  return null;
}
