import { COLLECTIONS, EMBEDDED, SCENE_EMBEDDED_FIELDS, type Doc, type SocketResponse, type WorldCache } from "./cache.ts";

/**
 * Document policy: what a trimmed client receives.
 *
 * Applied to the login payload and to every broadcast afterwards. A client with the GAMEMASTER or
 * ASSISTANT role, or a profile in "full" mode, receives everything. For everyone else:
 *   - Actor, Item, JournalEntry: full when the user has at least LIMITED permission; otherwise a stub if a
 *     token on a scene the client holds references it (Actor only); otherwise omitted.
 *   - Scene: the active scene and any scene the client viewed keep their embedded documents; the others
 *     are shipped as shells (embedded arrays empty) and hydrated when activated, pulled to, or viewed.
 *   - ChatMessage: the newest `messages` only.
 *   - Documents flagged by an active module that opts in (manifest flags.swipeSidecar.documents: "all") are kept
 *     in full; content modules stamp flags on everything they import, so this is opt-in.
 * Whatever a client never received is remembered, so a later change that makes it visible (an ownership
 * grant, a token drop) becomes a synthetic create instead of an update the client would ignore.
 */
export interface DocumentPolicy {
  mode: "full" | "trim";
  stubReferenced: boolean;
  keepModuleFlagged: boolean;
  /** Newest chat messages to keep; 0 keeps none, null keeps all. */
  messages: number | null;
  /** "active": embedded documents only for the active scene; "all": every scene in full. */
  sceneEmbedded: "active" | "all";
}

export const FULL_POLICY: DocumentPolicy = { mode: "full", stubReferenced: true, keepModuleFlagged: true, messages: null, sceneEmbedded: "all" };
export const TRIM_POLICY: DocumentPolicy = { mode: "trim", stubReferenced: true, keepModuleFlagged: true, messages: 300, sceneEmbedded: "active" };

const LIMITED = 1;
const ASSISTANT = 3;
const PERMISSIONED = new Set(["Actor", "Item", "JournalEntry"]);
const CORE_FLAG_SCOPES = new Set(["core", "swipeSidecar"]);

export interface ClientState {
  userId: string | null;
  role: number;
  policy: DocumentPolicy;
  /** Module ids active for this client after profile blocking. */
  activeModules: Set<string>;
  /** Active modules whose manifest declares flags.swipeSidecar.documents === "all": their flagged documents are kept. */
  documentModules: Set<string>;
  /** type -> ids the client holds (full or stub). */
  held: Map<string, Set<string>>;
  /** Actor ids the client holds only as stubs. */
  stubs: Set<string>;
  /** Scene ids the client holds with embedded documents. */
  hydratedScenes: Set<string>;
  trimmed: boolean;
  /** Texture rewrite for this client (Scene, Level and Tile documents), set by the relay; null when off. */
  rewrite: ((type: string, doc: Doc) => Doc) | null;
}

/** Apply the client's texture rewrite to a document, if any. */
function tex(state: ClientState, type: string, doc: Doc): Doc {
  return state.rewrite ? state.rewrite(type, doc) : doc;
}

export function newClientState(policy: DocumentPolicy): ClientState {
  return { userId: null, role: 0, policy, activeModules: new Set(), documentModules: new Set(), held: new Map(), stubs: new Set(), hydratedScenes: new Set(), trimmed: false, rewrite: null };
}

function hold(state: ClientState, type: string, id: string): void {
  let s = state.held.get(type);
  if ( !s ) { s = new Set(); state.held.set(type, s); }
  s.add(id);
}
export function holds(state: ClientState, type: string, id: string): boolean {
  return state.held.get(type)?.has(id) ?? false;
}

function level(doc: Doc, userId: string | null): number {
  const o = doc.ownership ?? {};
  const own = userId ? o[userId] : undefined;
  const l = (own !== undefined && own !== -1) ? own : (o.default ?? 0);
  return l === -1 ? 0 : l;
}

/**
 * Content modules stamp their flag on every document they import, so "any active module's flag" would keep
 * whole bestiaries. Only modules that opt in through their manifest (flags.swipeSidecar.documents: "all") keep
 * the documents they flag.
 */
function moduleFlagged(doc: Doc, state: ClientState): boolean {
  if ( !state.policy.keepModuleFlagged || !doc.flags ) return false;
  for ( const scope of Object.keys(doc.flags) ) {
    if ( !CORE_FLAG_SCOPES.has(scope) && state.documentModules.has(scope) ) return true;
  }
  return false;
}

export function stubActor(doc: Doc): Doc {
  return {
    _id: doc._id, name: doc.name, type: doc.type, img: doc.img, folder: doc.folder ?? null, sort: doc.sort ?? 0,
    ownership: doc.ownership ?? { default: 0 }, prototypeToken: doc.prototypeToken, system: {}, items: [], effects: [],
    flags: { swipeSidecar: { stub: true } }, _stats: doc._stats
  };
}

function sceneShell(doc: Doc): Doc {
  const shell: Doc = { ...doc };
  for ( const field of SCENE_EMBEDDED_FIELDS ) shell[field] = [];
  return shell;
}

/** Actor ids referenced by tokens of the scenes the client holds hydrated. */
function referencedActors(cache: WorldCache, state: ClientState): Set<string> {
  const ids = new Set<string>();
  for ( const sceneId of state.hydratedScenes ) {
    const scene = cache.get("Scene", sceneId);
    for ( const t of scene?.tokens ?? [] ) if ( t.actorId ) ids.add(t.actorId);
  }
  return ids;
}

/* -------------------------------------------- */

/** Trim a full world payload for a client. Returns the payload to forward (may be the same object). */
export function trimPayload(payload: Doc, cache: WorldCache, state: ClientState): { payload: Doc; report: Record<string, number> } {
  const report: Record<string, number> = {};
  const users: Doc[] = payload.users ?? [];
  state.userId = payload.userId ?? state.userId;
  state.role = users.find(u => u._id === state.userId)?.role ?? 0;

  const full = state.role >= ASSISTANT || state.policy.mode === "full";
  state.trimmed = !full;
  if ( full ) {
    for ( const [key, type] of Object.entries(COLLECTIONS) ) for ( const d of payload[key] ?? [] ) hold(state, type, d._id);
    for ( const s of payload.scenes ?? [] ) state.hydratedScenes.add(s._id);
    return { payload, report };
  }

  const out: Doc = { ...payload };
  const activeSceneId = (payload.scenes ?? []).find((s: Doc) => s.active)?._id ?? null;

  // Scenes: shells except the active one (or all, per policy).
  out.scenes = (payload.scenes ?? []).map((s: Doc) => {
    hold(state, "Scene", s._id);
    if ( state.policy.sceneEmbedded === "all" || s._id === activeSceneId ) { state.hydratedScenes.add(s._id); return tex(state, "Scene", s); }
    report.sceneShells = (report.sceneShells ?? 0) + 1;
    return tex(state, "Scene", sceneShell(s));
  });
  const referenced = state.policy.stubReferenced ? referencedActors(cache, state) : new Set<string>();

  // Permissioned collections.
  for ( const [key, type] of Object.entries(COLLECTIONS) ) {
    if ( !PERMISSIONED.has(type) ) continue;
    const kept: Doc[] = [];
    for ( const d of payload[key] ?? [] ) {
      if ( level(d, state.userId) >= LIMITED || moduleFlagged(d, state) ) { kept.push(d); hold(state, type, d._id); continue; }
      if ( type === "Actor" && referenced.has(d._id) ) { kept.push(stubActor(d)); hold(state, type, d._id); state.stubs.add(d._id); report.stubs = (report.stubs ?? 0) + 1; continue; }
      report[`omitted${type}`] = (report[`omitted${type}`] ?? 0) + 1;
    }
    out[key] = kept;
  }

  // Settings of modules that are not active on this client never get read there.
  if ( Array.isArray(payload.settings) ) {
    const installed = new Set((payload.modules ?? []).map((m: Doc) => m.id));
    const before = payload.settings.length;
    out.settings = payload.settings.filter((s: Doc) => {
      const scope = String(s.key ?? "").split(".")[0];
      return !installed.has(scope) || state.activeModules.has(scope);
    });
    report.omittedSetting = before - out.settings.length;
  }

  // Chat history cap.
  if ( state.policy.messages !== null && Array.isArray(payload.messages) ) {
    const sorted = [...payload.messages].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    out.messages = sorted.slice(Math.max(0, sorted.length - state.policy.messages));
    report.omittedChatMessage = payload.messages.length - out.messages.length;
  }

  // Everything else is held as sent.
  for ( const [key, type] of Object.entries(COLLECTIONS) ) {
    if ( PERMISSIONED.has(type) || key === "scenes" ) continue;
    for ( const d of out[key] ?? [] ) if ( d?._id ) hold(state, type, d._id);
  }
  return { payload: out, report };
}

/* -------------------------------------------- */

/**
 * Decide what a trimmed client receives for a broadcast. Returns the frames' worth of responses to send,
 * in order: synthetic creates first (an actor a new token needs, a scene about to be activated), then the
 * original response, or nothing at all when the client holds none of the affected documents.
 */
export function filterResponse(response: SocketResponse, cache: WorldCache, state: ClientState): SocketResponse[] {
  if ( !state.trimmed || !response?.type || response.operation?.pack ) return [response];
  const { type, action, result } = response;
  if ( !Array.isArray(result) ) return [response];
  const parentUuid: string | undefined = response.operation?.parentUuid;
  const out: SocketResponse[] = [];

  // Embedded operations: only if the client holds the root document with its embedded data.
  if ( parentUuid ) {
    const [rootType, rootId] = parentUuid.split(".");
    if ( !holds(state, rootType, rootId) ) return [];
    if ( rootType === "Scene" && !state.hydratedScenes.has(rootId) ) return [];
    if ( rootType === "Actor" && state.stubs.has(rootId) ) return [];
    if ( rootType === "Scene" && type === "Token" && (action === "create" || action === "update") ) {
      for ( const t of result ) {
        const actorId = t?.actorId;
        if ( actorId && !holds(state, "Actor", actorId) ) out.push(...provideActor(actorId, cache, state));
      }
    }
    if ( state.rewrite && (type === "Level" || type === "Tile") && action !== "delete" ) {
      out.push({ ...response, result: result.map((r: Doc) => tex(state, type, r)) });
      return out;
    }
    out.push(response);
    return out;
  }

  // World-level operations.
  if ( action === "delete" ) {
    const kept = result.filter(r => holds(state, type, typeof r === "string" ? r : r?._id));
    for ( const r of kept ) { const id = typeof r === "string" ? r : r?._id; state.held.get(type)?.delete(id); state.stubs.delete(id); state.hydratedScenes.delete(id); }
    return kept.length ? [{ ...response, result: kept }] : [];
  }

  if ( type === "Scene" ) {
    if ( action === "create" ) {
      const shells = result.map((s: Doc) => { hold(state, "Scene", s._id); return tex(state, "Scene", state.policy.sceneEmbedded === "all" ? s : sceneShell(s)); });
      return [{ ...response, result: shells }];
    }
    // An activation hydrates the scene first.
    for ( const r of result ) {
      if ( r?.active === true && holds(state, "Scene", r._id) && !state.hydratedScenes.has(r._id) ) out.push(...hydrateScene(r._id, cache, state));
    }
    // Updates that carry embedded arrays to a shell would partially hydrate it; strip them instead.
    const cleaned = result.map((r: Doc) => {
      if ( state.hydratedScenes.has(r._id) ) return tex(state, "Scene", r);
      const copy = { ...r };
      for ( const field of SCENE_EMBEDDED_FIELDS ) delete copy[field];
      return tex(state, "Scene", copy);
    });
    out.push({ ...response, result: cleaned });
    return out;
  }

  if ( PERMISSIONED.has(type) ) {
    const kept: Doc[] = [];
    for ( const r of result ) {
      const id = r?._id;
      if ( !id ) continue;
      const full = cache.get(type, id);
      if ( holds(state, type, id) ) {
        // A stub that became visible is upgraded to the full document.
        if ( type === "Actor" && state.stubs.has(id) && full && level(full, state.userId) >= LIMITED ) {
          out.push(...upgradeStub(type, full, state, response.userId, response.timestamp));
          continue;
        }
        kept.push(r);
        continue;
      }
      if ( !full ) continue;
      if ( level(full, state.userId) >= LIMITED || moduleFlagged(full, state) ) {
        hold(state, type, id);
        out.push({ type, action: "create", operation: {}, result: [full], userId: response.userId, broadcast: true, timestamp: response.timestamp });
      }
    }
    if ( kept.length ) out.push({ ...response, result: kept });
    return out;
  }

  // Other collections: forward, and remember creates.
  if ( action === "create" ) for ( const r of result ) if ( r?._id ) hold(state, type, r._id);
  if ( type === "ChatMessage" && state.policy.messages === 0 ) return [];
  return [response];
}

/* -------------------------------------------- */

/** Replace a stub with the full document: a delete then a create, which Foundry applies without ambiguity. */
function upgradeStub(type: string, full: Doc, state: ClientState, userId: string | null = null, timestamp: number = Date.now()): SocketResponse[] {
  state.stubs.delete(full._id);
  return [
    { type, action: "delete", operation: {}, result: [full._id], userId, broadcast: true, timestamp },
    { type, action: "create", operation: {}, result: [full], userId, broadcast: true, timestamp }
  ];
}

export function provideActor(actorId: string, cache: WorldCache, state: ClientState): SocketResponse[] {
  const full = cache.get("Actor", actorId);
  if ( !full || holds(state, "Actor", actorId) ) return [];
  hold(state, "Actor", actorId);
  let doc = full;
  if ( level(full, state.userId) < LIMITED && !moduleFlagged(full, state) ) {
    if ( !state.policy.stubReferenced ) return [];
    doc = stubActor(full);
    state.stubs.add(actorId);
  }
  return [{ type: "Actor", action: "create", operation: {}, result: [doc], userId: null, broadcast: true, timestamp: Date.now() }];
}

export function hydrateScene(sceneId: string, cache: WorldCache, state: ClientState): SocketResponse[] {
  const scene = cache.get("Scene", sceneId);
  if ( !scene || state.hydratedScenes.has(sceneId) ) return [];
  state.hydratedScenes.add(sceneId);
  const out: SocketResponse[] = [];
  for ( const t of scene.tokens ?? [] ) if ( t.actorId && !holds(state, "Actor", t.actorId) ) out.push(...provideActor(t.actorId, cache, state));
  const doc = tex(state, "Scene", scene);
  if ( !holds(state, "Scene", sceneId) ) {
    hold(state, "Scene", sceneId);
    out.push({ type: "Scene", action: "create", operation: {}, result: [doc], userId: null, broadcast: true, timestamp: Date.now() });
  }
  else out.push({ type: "Scene", action: "update", operation: {}, result: [doc], userId: null, broadcast: true, timestamp: Date.now() });
  return out;
}

/** Upgrade a stub, or deliver a document the client lacks, on request from the client runtime. */
export function hydrateDocument(uuid: string, cache: WorldCache, state: ClientState): SocketResponse[] {
  const [type, id] = uuid.split(".");
  if ( !type || !id ) return [];
  if ( type === "Scene" ) return hydrateScene(id, cache, state);
  const full = cache.get(type, id);
  if ( !full ) return [];
  if ( type === "Actor" && state.stubs.has(id) ) {
    if ( level(full, state.userId) < LIMITED && !moduleFlagged(full, state) ) return [];
    return upgradeStub(type, full, state);
  }
  if ( holds(state, type, id) ) return [];
  if ( PERMISSIONED.has(type) && level(full, state.userId) < LIMITED && !moduleFlagged(full, state) ) return [];
  hold(state, type, id);
  return [{ type, action: "create", operation: {}, result: [full], userId: null, broadcast: true, timestamp: Date.now() }];
}

export { EMBEDDED };
