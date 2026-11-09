import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import path from "node:path";
import type { SidecarConfig } from "./config.ts";
import { readFoundryBuild, ROOT } from "./config.ts";
import { loadWs } from "./deps.ts";
import { resolveProfile } from "./profile.ts";
import { rewriteView, activeModulesIn } from "./rewrite/html.ts";
import { patchBundle, etagFor, type PatchReport } from "./rewrite/bundle.ts";
import { handleSidecarRoute } from "./routes.ts";
import { MetricsStore } from "./metrics.ts";
import { ProfileStore, type ProfileName } from "./profiles.ts";
import { SocketRelay } from "./socket/relay.ts";
import { TextureService } from "./textures/service.ts";

const VERSION = "0.1.0";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

interface UpstreamResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface BundleCache {
  upstreamEtag: string | null;
  upstreamLastModified: string | null;
  text: Buffer;
  etag: string;
  report: PatchReport;
}

export class SidecarProxy {
  #config: SidecarConfig;
  #upstream: URL;
  #agent: http.Agent | https.Agent;
  #build: number | null;
  #bundle: BundleCache | null = null;
  #server: http.Server | https.Server;
  #stats = { requests: 0, viewsRewritten: 0, upgrades: 0 };
  #metrics: MetricsStore;
  #profiles: ProfileStore;
  #relay: SocketRelay | null = null;
  #textures: TextureService | null = null;

  constructor(config: SidecarConfig) {
    this.#config = config;
    this.#upstream = new URL(config.upstream.url);
    this.#build = readFoundryBuild(config);
    this.#metrics = new MetricsStore(config.dataDir);
    this.#profiles = new ProfileStore(config.dataDir, config.foundry.dataPath);
    if ( config.textures?.enabled !== false ) this.#textures = new TextureService(config, message => console.log(`[swipe-sidecar] ${message}`));
    const ws = config.features.documentPolicy !== false ? loadWs(config) : null;
    if ( config.features.documentPolicy !== false && !ws ) {
      console.warn("[swipe-sidecar] the ws package was found neither in Swipe Sidecar's node_modules nor in Foundry's install; the document policy is off and sockets pass through unchanged. Run npm install, or set foundry.installPath.");
    }
    if ( ws ) {
      if ( !ws.from.startsWith(ROOT) ) console.log(`[swipe-sidecar] using Foundry's ws from ${ws.from}`);
      this.#relay = new SocketRelay({
        ws: ws.lib,
        upstream: this.#upstream,
        rejectUnauthorized: config.upstream.rejectUnauthorized,
        log: message => console.log(`[swipe-sidecar] ${message}`),
        textures: this.#textures,
        policyFor: req => {
          const profile = resolveProfile(req, config).profile as ProfileName;
          const rule = this.#profiles.rules[profile];
          return {
            profile,
            policy: rule.documents,
            activeModules: (all: string[]) => { const { blocked } = this.#profiles.blockedFor(profile, all); return all.filter(id => !blocked.includes(id)); },
            documentModules: (active: string[]) => active.filter(id => this.#profiles.manifest(id)?.swipeSidecar?.documents === "all")
          };
        }
      });
    }
    const isHttps = this.#upstream.protocol === "https:";
    this.#agent = isHttps
      ? new https.Agent({ keepAlive: true, rejectUnauthorized: config.upstream.rejectUnauthorized })
      : new http.Agent({ keepAlive: true });
    const tlsConfig = config.listen.tls;
    if ( tlsConfig ) {
      this.#server = https.createServer({
        cert: readFile(tlsConfig.cert),
        key: readFile(tlsConfig.key)
      }, this.#onRequest.bind(this));
    }
    else this.#server = http.createServer(this.#onRequest.bind(this));
    this.#server.on("upgrade", this.#onUpgrade.bind(this));
  }

  get address(): string {
    const proto = this.#config.listen.tls ? "https" : "http";
    return `${proto}://localhost:${this.#config.listen.port}`;
  }

  listen(): Promise<void> {
    return new Promise(resolve => {
      this.#server.listen(this.#config.listen.port, this.#config.listen.host, () => resolve());
    });
  }

  status(req?: http.IncomingMessage): object {
    return {
      version: VERSION,
      upstream: this.#upstream.href,
      client: req ? { profile: resolveProfile(req, this.#config).profile, userAgent: req.headers["user-agent"] } : undefined,
      foundryBuild: this.#build,
      features: this.#config.features,
      stats: this.#stats,
      bundle: this.#bundle ? { etag: this.#bundle.etag, upstreamEtag: this.#bundle.upstreamEtag, patches: this.#bundle.report } : null,
      socket: this.#relay ? this.#relay.status() : { mode: "passthrough" },
      textures: this.#textures ? this.#textures.status() : { available: false }
    };
  }

  /* -------------------------------------------- */
  /*  HTTP                                        */
  /* -------------------------------------------- */

  async #onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.#stats.requests++;
    try {
      if ( await handleSidecarRoute(req, res, { status: r => this.status(r), metrics: this.#metrics, profiles: this.#profiles, token: this.#config.api.token, profileOf: r => resolveProfile(r, this.#config).profile, hydrate: (sid, uuid) => this.#relay?.hydrate(sid, uuid) ?? { sent: 0 }, textures: this.#textures, world: () => ({ id: this.#relay?.worldId ?? null, sources: this.#relay?.sceneTextureSources() ?? [], encode: () => this.#relay?.encodeWorld() ?? 0 }) }) ) return;
      const url = new URL(req.url ?? "/", "http://swipe-sidecar");
      const { profile, setCookie } = resolveProfile(req, this.#config);
      if ( setCookie ) res.setHeader("set-cookie", setCookie);

      if ( url.pathname.endsWith("/scripts/foundry.mjs") && this.#config.features.bundlePatches ) {
        return await this.#serveBundle(req, res);
      }

      const isView = !path.extname(url.pathname) && (req.method === "GET");
      if ( isView ) return await this.#serveView(req, res, profile);
      if ( this.#isBlockedCode(url.pathname, profile) ) {
        res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
        res.end(`Swipe Sidecar: module code blocked for profile "${profile}"`);
        return;
      }
      return this.#pipeThrough(req, res);
    } catch(err) {
      console.error("[swipe-sidecar] request failed", req.url, err);
      if ( !res.headersSent ) res.writeHead(502, { "content-type": "text/plain" });
      res.end("Swipe Sidecar: upstream request failed");
    }
  }

  /**
   * Scripts, styles and templates of a module blocked for this profile never load, even if something
   * imports them directly. Images, audio and other assets still do: world documents may reference them.
   */
  #isBlockedCode(pathname: string, profile: string): boolean {
    const m = pathname.match(/\/modules\/([^/]+)\/.*\.(m?js|css|hbs|html)$/);
    if ( !m ) return false;
    const rule = this.#profiles.rules[profile as ProfileName];
    if ( !rule ) return false;
    const { blocked } = this.#profiles.blockedFor(profile as ProfileName, [m[1]]);
    return blocked.includes(m[1]);
  }

  /**
   * Stream a request to Foundry and the response back, untouched.
   */
  #pipeThrough(req: http.IncomingMessage, res: http.ServerResponse): void {
    const upstreamReq = this.#request(req, req.headers);
    upstreamReq.on("response", upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, filterHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });
    upstreamReq.on("error", err => {
      console.error("[swipe-sidecar] upstream error", req.url, err.message);
      if ( !res.headersSent ) res.writeHead(502, { "content-type": "text/plain" });
      res.end("Swipe Sidecar: upstream unavailable");
    });
    req.pipe(upstreamReq);
  }

  /**
   * Fetch a Foundry view, and when it is HTML, inject the sidecar assets before returning it.
   * Non-HTML responses (redirects, JSON from API routes) pass through as-is.
   */
  async #serveView(req: http.IncomingMessage, res: http.ServerResponse, profile: string): Promise<void> {
    // The rewritten body differs from Foundry's, so Foundry's validators must not reach the browser and the
    // browser's conditional headers must not reach Foundry: otherwise Foundry answers 304 for an unchanged
    // template and the browser keeps a stale rewritten copy.
    const requestHeaders: http.IncomingHttpHeaders = { ...req.headers, "accept-encoding": "identity" };
    delete requestHeaders["if-none-match"];
    delete requestHeaders["if-modified-since"];
    const upstream = await this.#fetch(req, requestHeaders);
    const type = String(upstream.headers["content-type"] ?? "");
    const headers = filterHeaders(upstream.headers);
    if ( upstream.status === 200 && type.includes("text/html") ) {
      const source = upstream.body.toString("utf8");
      const active = activeModulesIn(source);
      const { blocked } = active.length ? this.#profiles.blockedFor(profile as ProfileName, active) : { blocked: [] as string[] };
      const html = rewriteView(source, {
        version: VERSION, profile: profile as any, build: this.#build, features: this.#config.features,
        blockedModules: blocked, dropSettings: this.#profiles.rules[profile as ProfileName]?.dropSettings ?? true,
        textures: this.#profiles.rules[profile as ProfileName]?.textures
      });
      const body = Buffer.from(html, "utf8");
      const etag = etagFor(html);
      this.#stats.viewsRewritten++;
      if ( req.headers["if-none-match"] === etag ) {
        res.writeHead(304, { etag, "cache-control": "no-cache" });
        res.end();
        return;
      }
      delete headers["content-encoding"];
      delete headers["last-modified"];
      headers["etag"] = etag;
      headers["content-length"] = String(body.length);
      res.writeHead(200, headers);
      res.end(body);
      return;
    }
    res.writeHead(upstream.status, headers);
    res.end(upstream.body);
  }

  /**
   * Serve the patched client bundle. The upstream copy is revalidated with a conditional request on every
   * hit, so a Foundry update invalidates the cache immediately while the common case costs one 304.
   */
  async #serveBundle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const conditional: http.IncomingHttpHeaders = { ...req.headers, "accept-encoding": "identity" };
    delete conditional["if-none-match"];
    delete conditional["if-modified-since"];
    if ( this.#bundle?.upstreamEtag ) conditional["if-none-match"] = this.#bundle.upstreamEtag;
    else if ( this.#bundle?.upstreamLastModified ) conditional["if-modified-since"] = this.#bundle.upstreamLastModified;

    const upstream = await this.#fetch(req, conditional);
    if ( upstream.status === 200 ) {
      const { text, report } = patchBundle(upstream.body.toString("utf8"), this.#config.features, this.#build);
      const buffer = Buffer.from(text, "utf8");
      this.#bundle = {
        upstreamEtag: (upstream.headers.etag as string) ?? null,
        upstreamLastModified: (upstream.headers["last-modified"] as string) ?? null,
        text: buffer,
        etag: etagFor(text),
        report
      };
      console.log(`[swipe-sidecar] bundle patched: applied=${report.applied.join(",") || "none"}`
        + (report.skipped.length ? ` skipped=${report.skipped.map(s => `${s.id} (${s.reason})`).join("; ")}` : ""));
    }
    else if ( upstream.status !== 304 || !this.#bundle ) {
      res.writeHead(upstream.status, filterHeaders(upstream.headers));
      res.end(upstream.body);
      return;
    }

    const cached = this.#bundle!;
    if ( req.headers["if-none-match"] === cached.etag ) {
      res.writeHead(304, { etag: cached.etag, "cache-control": "no-cache" });
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "content-length": String(cached.text.length),
      "cache-control": "no-cache",
      etag: cached.etag
    });
    res.end(cached.text);
  }

  /* -------------------------------------------- */
  /*  WebSocket                                   */
  /* -------------------------------------------- */

  /**
   * Pipe a WebSocket upgrade to Foundry as raw TCP so socket.io frames, including per-message deflate,
   * pass through untouched.
   */
  #onUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    this.#stats.upgrades++;
    if ( this.#relay ) return this.#relay.handleUpgrade(req, socket, head);
    const isHttps = this.#upstream.protocol === "https:";
    const port = Number(this.#upstream.port) || (isHttps ? 443 : 80);
    const onConnect = () => {
      const headers = { ...req.headers, ...this.#forwardedHeaders(req) };
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for ( const [key, value] of Object.entries(headers) ) {
        if ( value === undefined ) continue;
        for ( const v of Array.isArray(value) ? value : [value] ) lines.push(`${key}: ${v}`);
      }
      upstreamSocket.write(lines.join("\r\n") + "\r\n\r\n");
      if ( head.length ) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    };
    const upstreamSocket = isHttps
      ? tls.connect({ host: this.#upstream.hostname, port, servername: this.#upstream.hostname,
        rejectUnauthorized: this.#config.upstream.rejectUnauthorized }, onConnect)
      : net.connect({ host: this.#upstream.hostname, port }, onConnect);
    const close = () => { socket.destroy(); upstreamSocket.destroy(); };
    upstreamSocket.on("error", close);
    socket.on("error", close);
    upstreamSocket.on("close", () => socket.destroy());
    socket.on("close", () => upstreamSocket.destroy());
  }

  /* -------------------------------------------- */
  /*  Helpers                                     */
  /* -------------------------------------------- */

  #forwardedHeaders(req: http.IncomingMessage): Record<string, string> {
    const proto = this.#config.listen.tls ? "https" : "http";
    const prior = req.headers["x-forwarded-for"];
    return {
      "x-forwarded-proto": proto,
      "x-forwarded-host": String(req.headers.host ?? ""),
      "x-forwarded-for": [prior, req.socket.remoteAddress].filter(Boolean).join(", ")
    };
  }

  #request(req: http.IncomingMessage, headers: http.IncomingHttpHeaders): http.ClientRequest {
    const isHttps = this.#upstream.protocol === "https:";
    const options: https.RequestOptions = {
      protocol: this.#upstream.protocol,
      hostname: this.#upstream.hostname,
      port: this.#upstream.port || (isHttps ? 443 : 80),
      method: req.method,
      path: req.url,
      headers: { ...headers, ...this.#forwardedHeaders(req) },
      agent: this.#agent,
      servername: isHttps ? this.#upstream.hostname : undefined
    };
    return (isHttps ? https : http).request(options);
  }

  #fetch(req: http.IncomingMessage, headers: http.IncomingHttpHeaders): Promise<UpstreamResponse> {
    return new Promise((resolve, reject) => {
      const upstreamReq = this.#request(req, headers);
      upstreamReq.on("response", upstreamRes => {
        const chunks: Buffer[] = [];
        upstreamRes.on("data", chunk => chunks.push(chunk));
        upstreamRes.on("end", () => {
          let body = Buffer.concat(chunks);
          const encoding = upstreamRes.headers["content-encoding"];
          if ( encoding === "gzip" ) body = zlib.gunzipSync(body);
          else if ( encoding === "br" ) body = zlib.brotliDecompressSync(body);
          else if ( encoding === "deflate" ) body = zlib.inflateSync(body);
          resolve({ status: upstreamRes.statusCode ?? 502, headers: upstreamRes.headers, body });
        });
        upstreamRes.on("error", reject);
      });
      upstreamReq.on("error", reject);
      req.pipe(upstreamReq);
    });
  }
}

function filterHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for ( const [key, value] of Object.entries(headers) ) {
    if ( value === undefined || HOP_BY_HOP.has(key) ) continue;
    out[key] = value;
  }
  return out;
}

function readFile(file: string): Buffer {
  return require_fs().readFileSync(file);
}

function require_fs() {
  return process.getBuiltinModule("node:fs") as typeof import("node:fs");
}
