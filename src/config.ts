import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

type SidecarConfigShape = SidecarConfig & { tokenGenerated?: boolean };

export interface SidecarConfig {
  listen: {
    port: number;
    host: string;
    tls?: { cert: string; key: string } | null;
  };
  upstream: {
    url: string;
    rejectUnauthorized: boolean;
  };
  foundry: {
    installPath?: string;
    /** Foundry user data folder (the one holding Config/ and Data/); lets Swipe Sidecar read module manifests. */
    dataPath?: string;
  };
  features: {
    bundlePatches: boolean;
    touchRightClick: boolean;
    /** Terminate the WebSocket and apply the per-profile document policy (default true). */
    documentPolicy?: boolean;
  };
  profiles: {
    default: "auto" | "desktop" | "tablet" | "phone";
  };
  api: {
    /** Bearer token for the management API; generated and written back on first start when absent. */
    token: string | null;
  };
  /** KTX2 texture service; see src/textures/service.ts. Every key optional. */
  textures?: {
    enabled?: boolean;
    cacheDir?: string;
    maxBytes?: number;
    caps?: { phone?: number | null; tablet?: number | null; desktop?: number | null };
    minDimension?: number;
    mipmaps?: boolean;
  };
  /** Where Swipe Sidecar keeps its own data (metrics, profiles, texture cache). Defaults to <repo>/data. */
  dataDir: string;
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLIENT_DIR = path.join(ROOT, "client");

const DEFAULTS: SidecarConfig = {
  listen: { port: 30001, host: "0.0.0.0", tls: null },
  upstream: { url: "http://localhost:30000", rejectUnauthorized: true },
  foundry: {},
  features: { bundlePatches: true, touchRightClick: true },
  profiles: { default: "auto" },
  api: { token: null },
  dataDir: path.join(ROOT, "data")
};

/**
 * Read a JSON file, tolerating the UTF-8 byte order mark that Windows PowerShell and some editors write.
 */
export function readJsonFile(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

/**
 * Load the sidecar configuration from disk, merging over defaults.
 * The path comes from the first CLI argument, then SWIPE_SIDECAR_CONFIG, then ./swipe-sidecar.config.json.
 * A config that is not valid JSON stops startup with the file path and the parser's message.
 */
export function loadConfig(): SidecarConfig {
  const candidate = process.argv[2] ?? process.env.SWIPE_SIDECAR_CONFIG ?? path.join(ROOT, "swipe-sidecar.config.json");
  const file = path.resolve(candidate);
  let parsed: Partial<SidecarConfig> = {};
  if ( fs.existsSync(file) ) {
    try { parsed = readJsonFile(file); }
    catch(err) {
      console.error(`[swipe-sidecar] ${file} is not valid JSON: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  else console.warn(`[swipe-sidecar] No config at ${file}, using defaults`);
  const config: SidecarConfigShape = {
    listen: { ...DEFAULTS.listen, ...parsed.listen },
    upstream: { ...DEFAULTS.upstream, ...parsed.upstream },
    foundry: { ...DEFAULTS.foundry, ...parsed.foundry },
    features: { ...DEFAULTS.features, ...parsed.features },
    profiles: { ...DEFAULTS.profiles, ...parsed.profiles },
    api: { ...DEFAULTS.api, ...parsed.api },
    textures: parsed.textures ?? {},
    dataDir: parsed.dataDir ? path.resolve(parsed.dataDir) : DEFAULTS.dataDir
  };
  if ( !config.api.token ) {
    config.api.token = crypto.randomBytes(24).toString("base64url");
    if ( fs.existsSync(file) ) {
      parsed.api = { ...(parsed.api ?? {}), token: config.api.token };
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
      console.log(`[swipe-sidecar] generated an API token and saved it to ${file}`);
    }
    config.tokenGenerated = true;
  }
  return config;
}

/**
 * Read the Foundry release build number from the install folder, when configured.
 */
export function readFoundryBuild(config: SidecarConfig): number | null {
  const install = config.foundry.installPath;
  if ( !install ) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(install, "package.json"), "utf8"));
    return Number(pkg?.release?.build) || null;
  } catch {
    return null;
  }
}
