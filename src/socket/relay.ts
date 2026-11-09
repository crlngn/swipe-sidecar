import type http from "node:http";
import type net from "node:net";
import type { WebSocketServer, WebSocket } from "ws";
import type { WsLib } from "../deps.ts";
import { parseFrame, buildFrame, eventFrame, EVENT, ACK, type Packet } from "./frames.ts";
import { WorldCache, type SocketResponse } from "./cache.ts";
import { newClientState, trimPayload, filterResponse, hydrateDocument, hydrateScene, type ClientState, type DocumentPolicy } from "./policy.ts";
import { TextureService } from "../textures/service.ts";

/**
 * Terminating WebSocket relay. Each browser socket gets its own upstream socket to Foundry; frames pass
 * through untouched except for the handful Swipe Sidecar understands: the `world` acknowledgement (cached in full,
 * forwarded trimmed), `modifyDocument` and `modifyDocumentBatch` broadcasts (cached, filtered, with
 * synthetic creates injected ahead of them), `pullToScene` (scene hydrated first) and `session`
 * (identifies the user). Binary frames and everything else are relayed as-is.
 */
export interface RelayOptions {
  upstream: URL;
  rejectUnauthorized: boolean;
  policyFor: (req: http.IncomingMessage) => { policy: DocumentPolicy; profile: string; activeModules: (all: string[]) => string[]; documentModules: (active: string[]) => string[] };
  log: (message: string) => void;
  /** KTX2 texture service; rewrites scene textures for trimmed clients when the world opted in. */
  textures?: TextureService | null;
  /** The `ws` library, from Swipe Sidecar's node_modules or Foundry's (see deps.ts). */
  ws: WsLib;
}

const CONNECTING = 0;
const OPEN = 1;

interface Session {
  id: string;
  foundrySessionId: string | null;
  profile: string;
  client: WebSocket;
  upstream: WebSocket;
  state: ClientState;
  worldAckIds: Set<number>;
  modifyAckIds: Set<number>;
  activeModulesOf: (all: string[]) => string[];
  documentModulesOf: (active: string[]) => string[];
  connectedAt: number;
}

let nextSession = 1;

export class SocketRelay {
  #wss: WebSocketServer;
  #options: RelayOptions;
  #sessions = new Map<string, Session>();
  cache = new WorldCache();
  /** Id of the world Foundry is serving, from the first `world` acknowledgement. */
  worldId: string | null = null;
  stats = { connections: 0, worldPayloads: 0, trimmedPayloads: 0, injected: 0, dropped: 0 };

  constructor(options: RelayOptions) {
    this.#options = options;
    this.#wss = new options.ws.WebSocketServer({ noServer: true, perMessageDeflate: true });
  }

  handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    this.#wss.handleUpgrade(req, socket, head, client => this.#connect(req, client));
  }

  #connect(req: http.IncomingMessage, client: WebSocket): void {
    const { upstream, rejectUnauthorized, policyFor } = this.#options;
    const url = new URL(req.url ?? "/socket.io/", "http://swipe-sidecar");
    const target = `${upstream.protocol === "https:" ? "wss" : "ws"}://${upstream.host}${url.pathname}${url.search}`;
    const headers: Record<string, string> = {};
    if ( req.headers.cookie ) headers.cookie = req.headers.cookie;
    if ( req.headers["user-agent"] ) headers["user-agent"] = String(req.headers["user-agent"]);
    const up = new this.#options.ws.WebSocket(target, { headers, rejectUnauthorized, perMessageDeflate: true });
    const { policy, profile, activeModules, documentModules } = policyFor(req);
    const session: Session = {
      id: String(nextSession++), foundrySessionId: null, profile, client, upstream: up, state: newClientState(policy),
      worldAckIds: new Set(), modifyAckIds: new Set(), activeModulesOf: activeModules, documentModulesOf: documentModules, connectedAt: Date.now()
    };
    this.#sessions.set(session.id, session);
    this.stats.connections++;

    const queue: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
    up.on("open", () => { for ( const m of queue ) up.send(m.data, { binary: m.binary }); queue.length = 0; });
    client.on("message", (data, binary) => {
      const frame = binary ? null : this.#fromClient(session, data.toString());
      const payload = frame === null ? data : frame;
      if ( up.readyState === OPEN ) up.send(payload, { binary });
      else queue.push({ data: payload as WebSocket.RawData, binary });
    });
    up.on("message", (data, binary) => {
      if ( client.readyState !== OPEN ) return;
      if ( binary ) { client.send(data, { binary: true }); return; }
      for ( const out of this.#fromServer(session, data.toString()) ) client.send(out);
    });
    const close = (why: string) => {
      if ( this.#sessions.has(session.id) ) this.#options.log(`socket ${session.id} closed (${why}) after ${Math.round((Date.now() - session.connectedAt) / 1000)}s, user ${session.state.userId ?? "-"}, ${String(req.headers["user-agent"] ?? "").slice(0, 40)}`);
      this.#sessions.delete(session.id);
      if ( client.readyState === OPEN || client.readyState === CONNECTING ) client.close();
      if ( up.readyState === OPEN || up.readyState === CONNECTING ) up.close();
    };
    client.on("close", (code, reason) => close(`client ${code} ${reason?.toString() ?? ""}`));
    client.on("error", err => close(`client error ${err.message}`));
    up.on("close", (code, reason) => close(`upstream ${code} ${reason?.toString() ?? ""}`));
    up.on("error", err => close(`upstream error ${err.message || err.code || String(err)}`));
  }

  /* -------------------------------------------- */

  /** Client -> Foundry. Returns the (unchanged) frame; records ack ids worth watching. */
  #fromClient(session: Session, text: string): string {
    if ( session.state.rewrite && this.#options.textures ) text = this.#options.textures.restore(text);
    const packet = parseFrame(text);
    if ( packet?.type === EVENT && Array.isArray(packet.data) && packet.id !== null ) {
      const name = packet.data[0];
      if ( name === "world" ) session.worldAckIds.add(packet.id);
      else if ( name === "modifyDocument" || name === "modifyDocumentBatch" ) session.modifyAckIds.add(packet.id);
    }
    return text;
  }

  /** Foundry -> client. Returns the frames to forward. */
  #fromServer(session: Session, text: string): string[] {
    const packet = parseFrame(text);
    if ( !packet ) return [text];

    if ( packet.type === ACK && packet.id !== null ) {
      if ( session.worldAckIds.delete(packet.id) ) return [this.#worldAck(session, packet)];
      if ( session.modifyAckIds.delete(packet.id) ) {
        const body = Array.isArray(packet.data) ? packet.data[0] : null;
        if ( body?.results ) for ( const r of body.results ) this.cache.apply(r);
        else if ( body?.type ) this.cache.apply(body);
        return [text];
      }
      return [text];
    }

    if ( packet.type === EVENT && Array.isArray(packet.data) ) {
      const [name, arg] = packet.data;
      if ( name === "session" ) {
        session.foundrySessionId = arg?.sessionId ?? null;
        session.state.userId = arg?.userId ?? session.state.userId;
        return [text];
      }
      if ( name === "modifyDocument" && arg?.type ) {
        this.cache.apply(arg);
        this.#ensureTextures(arg);
        const responses = filterResponse(arg, this.cache, session.state);
        if ( session.state.trimmed && process.env.SWIPE_SIDECAR_DEBUG_SOCKET ) {
          const ids = (arg.result ?? []).map((r: any) => typeof r === "string" ? r : r?._id).join(",");
          this.#options.log(`socket ${session.id} ${arg.type}.${arg.action} [${ids}] parent=${arg.operation?.parentUuid ?? "-"} -> ${responses.map(r => `${r.type}.${r.action}x${r.result.length}`).join(" ") || "dropped"}`);
        }
        return this.#emitResponses(session, responses, text);
      }
      if ( name === "modifyDocumentBatch" && Array.isArray(arg?.results) ) {
        for ( const r of arg.results ) { this.cache.apply(r); this.#ensureTextures(r); }
        if ( !session.state.trimmed ) return [text];
        const results = arg.results.flatMap((r: SocketResponse) => filterResponse(r, this.cache, session.state));
        if ( !results.length ) { this.stats.dropped++; return []; }
        return [eventFrame("modifyDocumentBatch", { results })];
      }
      if ( name === "pullToScene" && typeof arg === "string" && session.state.trimmed ) {
        const pre = hydrateScene(arg, this.cache, session.state).map(r => eventFrame("modifyDocument", r));
        this.stats.injected += pre.length;
        return [...pre, text];
      }
    }
    return [text];
  }

  #worldAck(session: Session, packet: Packet): string {
    const payload = Array.isArray(packet.data) ? packet.data[0] : null;
    if ( !payload || typeof payload !== "object" ) return buildFrame(packet);
    this.stats.worldPayloads++;
    this.cache.ingest(payload);
    const firstWorld = !this.worldId;
    this.worldId = payload.world?.id ?? this.worldId;
    const all = (payload.modules ?? []).filter((m: any) => m.active).map((m: any) => m.id);
    session.state.activeModules = new Set(session.activeModulesOf(all));
    session.state.documentModules = new Set(session.documentModulesOf([...session.state.activeModules]));
    this.#attachTextures(session);
    if ( firstWorld ) this.encodeWorld();
    const { payload: trimmed, report } = trimPayload(payload, this.cache, session.state);
    if ( session.state.trimmed ) {
      this.stats.trimmedPayloads++;
      this.#options.log(`trimmed world for user ${session.state.userId} (${session.profile}): ${JSON.stringify(report)}`);
    }
    return buildFrame({ ...packet, data: [trimmed] });
  }

  /** Give a session its texture rewrite when the service is on for this world and the profile has a cap. */
  #attachTextures(session: Session): void {
    const textures = this.#options.textures;
    const cap = textures?.capFor(session.profile) ?? null;
    if ( !textures || cap === null || !textures.worldEnabled(this.worldId) ) { session.state.rewrite = null; return; }
    const worldId = this.worldId;
    session.state.rewrite = (type, doc) => textures.rewriteDoc(type, doc, cap, worldId);
  }

  /** Queue encodes for the textures a broadcast touches, whoever it is for. */
  #ensureTextures(response: SocketResponse): void {
    const textures = this.#options.textures;
    if ( !textures || !response?.type || response.action === "delete" || !Array.isArray(response.result) ) return;
    if ( !["Scene", "Level", "Tile"].includes(response.type) ) return;
    for ( const r of response.result ) textures.ensureDoc(response.type, r, this.worldId);
  }

  /** Queue encodes for every large texture in the cached world (the bulk pass after a world opts in). */
  encodeWorld(): number {
    const textures = this.#options.textures;
    if ( !textures || !textures.worldEnabled(this.worldId) ) return 0;
    let n = 0;
    for ( const scene of this.cache.collection("Scene").values() ) { textures.ensureDoc("Scene", scene, this.worldId); n++; }
    for ( const s of this.#sessions.values() ) this.#attachTextures(s);
    return n;
  }

  /** Every texture path the cached world's scenes reference, for the disk estimate. */
  sceneTextureSources(): string[] {
    const out: string[] = [];
    for ( const scene of this.cache.collection("Scene").values() ) for ( const f of TextureService.textureFields("Scene", scene) ) out.push(String(f.get()));
    return out;
  }

  #emitResponses(session: Session, responses: SocketResponse[], original: string): string[] {
    if ( !session.state.trimmed ) return [original];
    if ( !responses.length ) { this.stats.dropped++; return []; }
    const frames = responses.map(r => eventFrame("modifyDocument", r));
    this.stats.injected += Math.max(0, responses.length - 1);
    return frames;
  }

  /* -------------------------------------------- */

  /** Runtime request: deliver a document (or a scene's embedded data) to the session that asked. */
  hydrate(foundrySessionId: string, uuid: string): { sent: number } {
    const session = [...this.#sessions.values()].find(s => s.foundrySessionId === foundrySessionId);
    if ( !session || !session.state.trimmed ) return { sent: 0 };
    const responses = hydrateDocument(uuid, this.cache, session.state);
    for ( const r of responses ) session.client.send(eventFrame("modifyDocument", r));
    this.stats.injected += responses.length;
    return { sent: responses.length };
  }

  status(): object {
    return {
      stats: this.stats,
      cacheReady: this.cache.ready,
      worldId: this.worldId,
      cache: this.cache.stats(),
      sessions: [...this.#sessions.values()].map(s => ({
        id: s.id, profile: s.profile, userId: s.state.userId, role: s.state.role, trimmed: s.state.trimmed, textures: !!s.state.rewrite,
        held: Object.fromEntries([...s.state.held].map(([t, ids]) => [t, ids.size])), stubs: s.state.stubs.size,
        hydratedScenes: [...s.state.hydratedScenes], since: s.connectedAt
      }))
    };
  }
}
