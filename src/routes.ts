import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { CLIENT_DIR } from "./config.ts";
import { readJson, type MetricsStore } from "./metrics.ts";
import { authorized, type ProfileStore, type ProfileName } from "./profiles.ts";
import type { TextureService } from "./textures/service.ts";

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ktx2": "image/ktx2"
};

export interface RouteContext {
  status: (req: http.IncomingMessage) => object;
  metrics: MetricsStore;
  profiles: ProfileStore;
  token: string | null;
  profileOf: (req: http.IncomingMessage) => string;
  hydrate: (sessionId: string, uuid: string) => { sent: number };
  textures: TextureService | null;
  /** The relay's view of the world: id, scene texture sources, and a way to start the bulk encode. */
  world: () => { id: string | null; sources: string[]; encode: () => number };
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": MIME[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(body, null, 2));
}

/**
 * Handle requests under /swipe-sidecar/*. Returns true when the request was handled.
 *   /swipe-sidecar/status              proxy state and patch report
 *   /swipe-sidecar/api/metrics         POST a diagnostics beacon; GET the merged runs
 *   /swipe-sidecar/api/profiles        GET the profile rules; PUT {profile, rule} with a bearer token to change one
 *   /swipe-sidecar/api/modules         GET module manifests as Swipe Sidecar sees them (id, title, requires, flags.swipeSidecar)
 *   /swipe-sidecar/api/hydrate         POST {sessionId, uuid}: push a trimmed-away document to that client
 *   /swipe-sidecar/api/textures        GET status and the disk estimate for the current world; POST {worldId, enabled}
 *                              with a bearer token to opt a world in or out; DELETE with a token clears the cache
 *   /swipe-sidecar/textures/<key>.ktx2 a compressed texture
 *   /swipe-sidecar/report              the diagnostics report page
 *   /swipe-sidecar/<file>              static files from client/
 */
export async function handleSidecarRoute(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://swipe-sidecar");
  if ( !url.pathname.startsWith("/swipe-sidecar/") ) return false;
  const rel = url.pathname.slice("/swipe-sidecar/".length);

  if ( rel === "status" ) {
    json(res, 200, ctx.status(req));
    return true;
  }

  if ( rel === "api/metrics" ) {
    if ( req.method === "POST" ) {
      try {
        const beacon = await readJson(req);
        const run = ctx.metrics.ingest(beacon, ctx.profileOf(req), req.socket.remoteAddress ?? null);
        json(res, run ? 202 : 400, { ok: !!run, runId: run?.runId });
      } catch(err) {
        json(res, 400, { ok: false, error: (err as Error).message });
      }
      return true;
    }
    const runId = url.searchParams.get("run");
    if ( runId ) {
      const run = ctx.metrics.get(runId);
      json(res, run ? 200 : 404, run ?? { error: "unknown run" });
      return true;
    }
    json(res, 200, { runs: ctx.metrics.list().map(summarize) });
    return true;
  }

  if ( rel === "api/profiles" ) {
    if ( req.method === "PUT" || req.method === "POST" ) {
      if ( !authorized(req.headers.authorization, ctx.token) ) { json(res, 401, { ok: false, error: "bearer token required" }); return true; }
      try {
        const body = await readJson(req) as any;
        const name = body?.profile as ProfileName;
        if ( !["desktop", "tablet", "phone"].includes(name) ) { json(res, 400, { ok: false, error: "profile must be desktop, tablet or phone" }); return true; }
        json(res, 200, { ok: true, profile: name, rule: ctx.profiles.setRule(name, body.rule ?? {}) });
      } catch(err) {
        json(res, 400, { ok: false, error: (err as Error).message });
      }
      return true;
    }
    const me = ctx.profileOf(req);
    json(res, 200, { current: me, rules: ctx.profiles.rules });
    return true;
  }

  if ( rel === "api/hydrate" && req.method === "POST" ) {
    try {
      const body = await readJson(req) as any;
      if ( typeof body?.sessionId !== "string" || typeof body?.uuid !== "string" ) { json(res, 400, { ok: false, error: "sessionId and uuid required" }); return true; }
      json(res, 200, { ok: true, ...ctx.hydrate(body.sessionId, body.uuid) });
    } catch(err) {
      json(res, 400, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  if ( rel.startsWith("textures/") ) {
    const m = /^textures\/([a-f0-9]{20})\.ktx2$/.exec(rel);
    const file = m && ctx.textures ? ctx.textures.fileFor(m[1]) : null;
    if ( !file || !fs.existsSync(file) ) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return true; }
    const stat = fs.statSync(file);
    const etag = `"${m![1]}"`;
    if ( req.headers["if-none-match"] === etag ) { res.writeHead(304, { etag }); res.end(); return true; }
    res.writeHead(200, { "content-type": MIME[".ktx2"], "content-length": stat.size, etag, "cache-control": "public, max-age=31536000, immutable" });
    if ( req.method === "HEAD" ) { res.end(); return true; }
    fs.createReadStream(file).pipe(res);
    return true;
  }

  if ( rel === "api/textures" ) {
    if ( !ctx.textures ) { json(res, 200, { available: false }); return true; }
    if ( req.method === "POST" || req.method === "PUT" || req.method === "DELETE" ) {
      if ( !authorized(req.headers.authorization, ctx.token) ) { json(res, 401, { ok: false, error: "bearer token required" }); return true; }
      if ( req.method === "DELETE" ) { json(res, 200, { ok: true, removed: ctx.textures.clear() }); return true; }
      try {
        const body = await readJson(req) as any;
        const worldId = typeof body?.worldId === "string" && body.worldId ? body.worldId : ctx.world().id;
        if ( !worldId ) { json(res, 400, { ok: false, error: "worldId required (no world seen yet)" }); return true; }
        if ( body?.enabled !== false && !ctx.textures.available ) {
          const missing = ctx.textures.missing;
          const error = missing.length ? `optional package(s) missing or unusable on this platform: ${missing.join(", ")}; run "npm install --include=optional"` : "texture service is disabled in the config";
          json(res, 409, { ok: false, error, missing });
          return true;
        }
        ctx.textures.setWorld(worldId, body?.enabled !== false);
        const queued = body?.enabled !== false ? ctx.world().encode() : 0;
        json(res, 200, { ok: true, worldId, enabled: body?.enabled !== false, scenesQueued: queued });
      } catch(err) {
        json(res, 400, { ok: false, error: (err as Error).message });
      }
      return true;
    }
    const world = ctx.world();
    const cap = ctx.textures.capFor("phone");
    json(res, 200, { ...ctx.textures.status(), world: { id: world.id, enabled: ctx.textures.worldEnabled(world.id), estimate: ctx.textures.estimate(world.sources, cap) }, entries: url.searchParams.has("entries") ? ctx.textures.entries() : undefined });
    return true;
  }

  if ( rel === "api/modules" ) {
    if ( url.searchParams.has("rescan") ) ctx.profiles.scanManifests();
    json(res, 200, { scannedAt: ctx.profiles.manifestsScannedAt, modules: ctx.profiles.manifests });
    return true;
  }

  if ( rel === "api/blocked" ) {
    const active = (url.searchParams.get("active") ?? "").split(",").filter(Boolean);
    const profile = (url.searchParams.get("profile") ?? ctx.profileOf(req)) as ProfileName;
    json(res, 200, { profile, ...ctx.profiles.blockedFor(profile, active) });
    return true;
  }

  if ( rel === "report" ) {
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
    fs.createReadStream(path.join(CLIENT_DIR, "report.html")).pipe(res);
    return true;
  }

  const file = path.normalize(path.join(CLIENT_DIR, rel));
  if ( !file.startsWith(CLIENT_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory() ) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return true;
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
  return true;
}

/** A compact row for the run list; the full run is fetched on demand. */
function summarize(run: any) {
  const pk = run.resources?.packages ?? {};
  const bytes = (Object.values(pk) as any[]).reduce((sum, p) => sum + (p.bytes ?? 0), 0);
  return {
    runId: run.runId,
    firstSeen: run.firstSeen,
    profile: run.profile,
    phases: run.phases,
    endedCleanly: run.phases.includes("unloaded"),
    previousRun: run.previousRun ?? null,
    world: run.world?.title ?? null,
    user: run.world?.userName ?? null,
    scene: run.scene?.name ?? null,
    userAgent: run.client?.userAgent ?? null,
    viewport: run.client?.screen ? `${run.client.screen.viewportW}x${run.client.screen.viewportH}` : null,
    modules: run.packages?.moduleCount ?? null,
    readyMs: run.timings?.readyMs ?? null,
    canvasReadyMs: run.timings?.canvasReadyMs ?? null,
    resourceBytes: bytes,
    worldPayloadBytes: run.worldPayload?.totalBytes ?? null,
    textureBytes: run.textures?.totalBytes ?? null,
    heapMB: run.heap?.usedMB ?? null
  };
}
