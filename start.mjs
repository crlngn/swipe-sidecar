#!/usr/bin/env node
/**
 * Launcher for Swipe Sidecar. Plain JavaScript on purpose: it checks the runtime before loading the TypeScript
 * sources, so an older Node (for example the one inside Foundry v13's desktop app) gets a clear message instead
 * of an "Unknown file extension .ts" error. Arguments pass through unchanged (the first one is the config path).
 */
const [major] = process.versions.node.split(".").map(Number);
if ( major < 24 ) {
  const where = process.versions.electron ? `the Foundry desktop app's built-in Node (Electron ${process.versions.electron})` : process.execPath;
  console.error(`[swipe-sidecar] needs Node 24 or newer; ${where} is Node ${process.versions.node}.`);
  console.error("[swipe-sidecar] Install Node 24+ from https://nodejs.org, or run it with the desktop app of Foundry v14, whose built-in Node is new enough.");
  process.exit(1);
}
await import(new URL("./src/index.ts", import.meta.url).href);
