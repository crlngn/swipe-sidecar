/**
 * Load diagnostics.
 * Measures what this client actually loaded and posts it to Swipe Sidecar, so runs on different devices and
 * profiles can be compared on /swipe-sidecar/report without a debugger attached (iOS Safari has none we can reach).
 *
 * Two beacons per page load:
 *   ready        timings, bytes per package from the Resource Timing API, the world payload per collection
 *                with the largest documents, compendium index weight, active packages, device facts;
 *   canvasReady  scene, texture memory by category and package, JS heap where the browser exposes it.
 * A pagehide beacon marks a clean exit; a run that never sends it is reported as a probable crash or
 * hard reload on the next start (kept in sessionStorage so it survives the reload but not the tab).
 */
const ENDPOINT = "/swipe-sidecar/api/metrics";
const TOP_DOCUMENTS = 8;
const TOP_TEXTURES = 12;
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
if ( globalThis.SwipeSidecar ) globalThis.SwipeSidecar.runId = runId;

function post(payload) {
  const body = JSON.stringify(payload);
  try {
    if ( navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "application/json" })) ) return;
  } catch {}
  fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
}

function client() {
  const nav = performance.getEntriesByType("navigation")[0];
  return {
    userAgent: navigator.userAgent,
    profile: globalThis.SwipeSidecar?.profile ?? null,
    sidecarVersion: globalThis.SwipeSidecar?.version ?? null,
    screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio, viewportW: innerWidth, viewportH: innerHeight },
    deviceMemoryGB: navigator.deviceMemory ?? null,
    cores: navigator.hardwareConcurrency ?? null,
    navigationType: nav?.type ?? null
  };
}

function heap() {
  const m = performance.memory;
  return m ? { usedMB: round(m.usedJSHeapSize / 1048576), totalMB: round(m.totalJSHeapSize / 1048576), limitMB: round(m.jsHeapSizeLimit / 1048576) } : null;
}

const round = n => Math.round(n * 10) / 10;

/** Group Resource Timing entries into core, system and modules with js/css/other byte buckets. */
function resources() {
  const entries = performance.getEntriesByType("resource");
  const packages = {};
  let sized = 0;
  const bucketFor = url => {
    if ( url.endsWith(".js") || url.endsWith(".mjs") ) return "js";
    if ( url.endsWith(".css") ) return "css";
    if ( /\.(png|jpe?g|webp|gif|svg|avif|webm|mp4|ogg|mp3|wav)(\?|$)/i.test(url) ) return "media";
    if ( /\.(hbs|html|json)(\?|$)/i.test(url) ) return "data";
    if ( /\.(woff2?|ttf|otf)(\?|$)/i.test(url) ) return "font";
    return "other";
  };
  for ( const e of entries ) {
    const size = e.decodedBodySize || e.transferSize || 0;
    if ( size ) sized++;
    const url = e.name;
    const path = url.replace(location.origin, "");
    let key = "core";
    const m = path.match(/^\/(modules|systems)\/([^/]+)\//);
    if ( m ) key = `${m[1] === "systems" ? "system" : "module"}:${m[2]}`;
    else if ( path.startsWith("/swipe-sidecar/") ) key = "swipe-sidecar";
    else if ( !/^\/(scripts|css|fonts|icons|ui|lang|templates|sounds|cards|canvas)\//.test(path) && !/^\/[^/]+$/.test(path) ) key = "world";
    const pkg = packages[key] ??= { requests: 0, bytes: 0, js: 0, css: 0, media: 0, data: 0, font: 0, other: 0, durationMs: 0 };
    pkg.requests++;
    pkg.bytes += size;
    pkg[bucketFor(path)] += size;
    pkg.durationMs += e.duration;
  }
  return { packages, entryCount: entries.length, sizedEntries: sized };
}

/** The world payload Foundry sent at login, weighed per collection with its heaviest documents. */
function worldPayload() {
  const data = game.data;
  if ( !data ) return null;
  const collections = {};
  let totalBytes = 0;
  for ( const [key, value] of Object.entries(data) ) {
    if ( !Array.isArray(value) ) continue;
    let bytes = 0;
    const docs = [];
    for ( const doc of value ) {
      let size = 0;
      try { size = JSON.stringify(doc).length; } catch { continue; }
      bytes += size;
      docs.push({ name: doc.name ?? doc.label ?? doc.key ?? doc._id, id: doc._id, bytes: size,
        type: doc.type ?? undefined, packageId: doc.flags?.swipeSidecar?.packageId ?? undefined });
    }
    docs.sort((a, b) => b.bytes - a.bytes);
    collections[key] = { count: value.length, bytes, top: docs.slice(0, TOP_DOCUMENTS) };
    totalBytes += bytes;
  }
  let packIndexBytes = 0;
  const packs = [];
  for ( const pack of game.packs ?? [] ) {
    let bytes = 0;
    for ( const entry of pack.index ) { try { bytes += JSON.stringify(entry).length; } catch {} }
    packIndexBytes += bytes;
    packs.push({ id: pack.collection, packageId: pack.metadata.packageName, type: pack.documentName, entries: pack.index.size, indexBytes: bytes });
  }
  packs.sort((a, b) => b.indexBytes - a.indexBytes);
  return { totalBytes, collections, packIndexBytes, packCount: packs.length, topPacks: packs.slice(0, 15) };
}

function packageList() {
  return {
    system: game.system?.id ?? null,
    modules: game.modules.filter(m => m.active).map(m => m.id),
    moduleCount: game.modules.filter(m => m.active).length,
    blockedByProfile: globalThis.SwipeSidecar?.blockedModules ?? [],
    sidecarFlags: Object.fromEntries(game.modules.filter(m => m.flags?.swipeSidecar).map(m => [m.id, m.flags.swipeSidecar]))
  };
}

/** PIXI base textures currently alive, grouped by what they are for and which package they came from. */
function textures() {
  const cache = globalThis.PIXI?.utils?.BaseTextureCache;
  if ( !cache ) return null;
  const seen = new Set();
  const byCategory = {};
  const byPackage = {};
  const list = [];
  let total = 0;
  for ( const [id, bt] of Object.entries(cache) ) {
    if ( !bt || bt.destroyed || !bt.valid || seen.has(bt) ) continue;
    seen.add(bt);
    const bytes = bt.realWidth * bt.realHeight * 4;
    const src = bt.resource?.src || bt.resource?.url || id;
    const path = String(src).replace(location.origin, "");
    const pkg = path.match(/^\/?(modules|systems)\/([^/]+)\//);
    const packageId = pkg ? pkg[2] : (path.startsWith("/") || path.startsWith("worlds/") || path.startsWith("/worlds/") ? "world" : "core");
    let category = "other";
    if ( /\/scenes?\//i.test(path) || /maps?\//i.test(path) ) category = "scene";
    else if ( /tokens?\//i.test(path) ) category = "token";
    else if ( /\/(ui|icons)\//.test(path) ) category = "ui";
    else if ( /\.(webm|mp4)(\?|$)/i.test(path) ) category = "video";
    if ( canvas.scene?.background?.src && path.endsWith(canvas.scene.background.src.replace(/^\/?/, "")) ) category = "scene";
    total += bytes;
    byCategory[category] = (byCategory[category] ?? 0) + bytes;
    byPackage[packageId] = (byPackage[packageId] ?? 0) + bytes;
    list.push({ src: path.slice(0, 160), w: bt.realWidth, h: bt.realHeight, bytes, category, packageId });
  }
  list.sort((a, b) => b.bytes - a.bytes);
  return { totalBytes: total, count: seen.size, byCategory, byPackage, top: list.slice(0, TOP_TEXTURES) };
}

/* -------------------------------------------- */

let previous = null;
try {
  previous = JSON.parse(sessionStorage.getItem("swipe-sidecar.run") ?? "null");
  // Only a game view starts a run; other views leave the previous record alone.
  if ( document.body.classList.contains("game") ) {
    sessionStorage.setItem("swipe-sidecar.run", JSON.stringify({ id: runId, started: Date.now(), phase: "loading" }));
  }
} catch {}

function markPhase(phase) {
  try { sessionStorage.setItem("swipe-sidecar.run", JSON.stringify({ id: runId, started: Date.now(), phase })); } catch {}
}

globalThis.Hooks?.once("ready", () => {
  markPhase("ready");
  const t0 = performance.timeOrigin;
  post({
    runId, phase: "ready", at: Date.now(),
    world: { id: game.world?.id, title: game.world?.title, userId: game.user?.id, userName: game.user?.name, isGM: game.user?.isGM },
    client: client(),
    previousRun: previous ? { id: previous.id, phase: previous.phase, endedCleanly: previous.phase === "unloaded" } : null,
    timings: { readyMs: Math.round(performance.now()), domContentLoadedMs: Math.round((performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd) ?? 0) },
    heap: heap(),
    packages: packageList(),
    resources: resources(),
    worldPayload: worldPayload()
  });
});

globalThis.Hooks?.on("canvasReady", () => {
  markPhase("canvasReady");
  post({
    runId, phase: "canvasReady", at: Date.now(),
    scene: canvas.scene ? { id: canvas.scene.id, name: canvas.scene.name, w: canvas.scene.width, h: canvas.scene.height,
      background: canvas.scene.background?.src ?? null, tokens: canvas.scene.tokens.size, tiles: canvas.scene.tiles.size,
      walls: canvas.scene.walls.size, lights: canvas.scene.lights.size } : null,
    timings: { canvasReadyMs: Math.round(performance.now()) },
    heap: heap(),
    textures: textures(),
    resources: resources()
  });
});

let reachedReady = false;
globalThis.Hooks?.once("ready", () => { reachedReady = true; });

// Only a run that reached "ready" is worth an exit record; join and setup pages never get one.
window.addEventListener("pagehide", () => {
  if ( !reachedReady ) { try { sessionStorage.removeItem("swipe-sidecar.run"); } catch {} return; }
  markPhase("unloaded");
  post({ runId, phase: "unloaded", at: Date.now(), heap: heap() });
});
