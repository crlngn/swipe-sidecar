/**
 * Runtime dependencies that Swipe Sidecar can borrow from Foundry's own install.
 * `ws` is Swipe Sidecar's only required package, and Foundry ships it too. Resolving it from Swipe Sidecar's node_modules
 * first and Foundry's second means a GM can run Swipe Sidecar with no `npm install` at all, including on the Node
 * runtime bundled inside Foundry's desktop app (ELECTRON_RUN_AS_NODE=1).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SidecarConfig } from "./config.ts";

export type WsLib = typeof import("ws");

/**
 * Folders that may hold a Foundry install with its node_modules: the configured install path, then the app
 * bundle around the running executable when Swipe Sidecar runs on the desktop app's own runtime (macOS keeps the app
 * in Contents/Resources/app, Windows and Linux in resources/app).
 */
export function foundryInstallCandidates(config: SidecarConfig): string[] {
  const exeDir = path.dirname(process.execPath);
  const out = [
    config.foundry.installPath,
    path.join(exeDir, "..", "Resources", "app"),
    path.join(exeDir, "resources", "app")
  ].filter((p): p is string => !!p).map(p => path.resolve(p));
  return [...new Set(out)].filter(p => fs.existsSync(path.join(p, "package.json")));
}

/**
 * Load `ws` from Swipe Sidecar's own dependencies, falling back to Foundry's copy. Returns null when neither exists.
 */
export function loadWs(config: SidecarConfig): { lib: WsLib; from: string } | null {
  const bases = [import.meta.url, ...foundryInstallCandidates(config).map(p => path.join(p, "package.json"))];
  for ( const base of bases ) {
    try {
      const require = createRequire(base);
      const lib = require("ws") as WsLib;
      if ( typeof lib?.WebSocketServer !== "function" ) continue;
      return { lib, from: path.dirname(require.resolve("ws/package.json")) };
    } catch {}
  }
  return null;
}
