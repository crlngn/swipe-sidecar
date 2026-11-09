/**
 * Swipe Sidecar's copy of the world, in the shape Foundry sends it.
 *
 * Foundry sends every client the complete world at login regardless of permission and broadcasts every
 * change to every client, so the relay sees everything: the cache fills from whichever client logs in
 * first and stays current from broadcasts and acks. Nothing here is Foundry-specific beyond the payload
 * keys and the embedded-collection names of each document type.
 */
export type Doc = Record<string, any>;

/** Payload key -> document type. */
export const COLLECTIONS: Record<string, string> = {
  actors: "Actor", items: "Item", scenes: "Scene", journal: "JournalEntry", macros: "Macro",
  tables: "RollTable", playlists: "Playlist", cards: "Cards", combats: "Combat", folders: "Folder",
  users: "User", messages: "ChatMessage", settings: "Setting"
};

/** Document type -> { embedded type: field name }. */
export const EMBEDDED: Record<string, Record<string, string>> = {
  Actor: { ActiveEffect: "effects", Item: "items" },
  Item: { ActiveEffect: "effects" },
  Scene: { AmbientLight: "lights", AmbientSound: "sounds", Drawing: "drawings", Note: "notes", Region: "regions",
    Level: "levels", Tile: "tiles", Token: "tokens", Wall: "walls" },
  JournalEntry: { JournalEntryPage: "pages" },
  Cards: { Card: "cards" },
  Playlist: { PlaylistSound: "sounds" },
  RollTable: { TableResult: "results" },
  Combat: { Combatant: "combatants" },
  Region: { RegionBehavior: "behaviors" },
  Token: { ActorDelta: "delta" },
  ActorDelta: { ActiveEffect: "effects", Item: "items" }
};

export const SCENE_EMBEDDED_FIELDS = Object.values(EMBEDDED.Scene);

/**
 * Apply a Foundry update diff in place: dotted keys expand to paths, "-=key" deletes, plain objects merge,
 * everything else (arrays included) replaces.
 */
export function applyDiff(target: Doc, change: Doc): Doc {
  for ( const [rawKey, value] of Object.entries(change) ) {
    if ( rawKey === "_id" ) continue;
    if ( rawKey.includes(".") ) {
      const [head, ...rest] = rawKey.split(".");
      if ( head.startsWith("-=") ) { delete target[head.slice(2)]; continue; }
      if ( !isPlain(target[head]) ) target[head] = {};
      applyDiff(target[head], { [rest.join(".")]: value });
      continue;
    }
    if ( rawKey.startsWith("-=") ) { delete target[rawKey.slice(2)]; continue; }
    if ( isPlain(value) && isPlain(target[rawKey]) ) applyDiff(target[rawKey], value);
    else target[rawKey] = value;
  }
  return target;
}

const isPlain = (v: unknown): v is Doc => !!v && typeof v === "object" && !Array.isArray(v);

export interface SocketResponse {
  type: string;
  action: "create" | "update" | "delete" | "get";
  operation: Doc;
  result: any[];
  userId?: string | null;
  broadcast?: boolean;
  timestamp?: number;
}

export class WorldCache {
  #docs = new Map<string, Map<string, Doc>>();
  /** The payload minus document collections: world, system, modules, packs, options... */
  meta: Doc | null = null;
  ready = false;
  lastIngest = 0;

  collection(type: string): Map<string, Doc> {
    let c = this.#docs.get(type);
    if ( !c ) { c = new Map(); this.#docs.set(type, c); }
    return c;
  }

  get(type: string, id: string): Doc | undefined {
    return this.#docs.get(type)?.get(id);
  }

  /** Replace the cache from a full world payload. */
  ingest(payload: Doc): void {
    this.#docs.clear();
    const meta: Doc = {};
    for ( const [key, value] of Object.entries(payload) ) {
      const type = COLLECTIONS[key];
      if ( type && Array.isArray(value) ) {
        const c = this.collection(type);
        for ( const doc of value ) if ( doc?._id ) c.set(doc._id, doc);
      }
      else meta[key] = value;
    }
    this.meta = meta;
    this.ready = true;
    this.lastIngest = Date.now();
  }

  /** Resolve "Actor.x.Item.y" to the document and the array that holds it. */
  resolveUuid(uuid: string): { doc: Doc | null; type: string | null } {
    const parts = uuid.split(".");
    if ( parts.length < 2 ) return { doc: null, type: null };
    let type = parts[0];
    let doc: Doc | undefined = this.get(type, parts[1]);
    for ( let i = 2; doc && i + 1 < parts.length; i += 2 ) {
      const childType = parts[i];
      const field = EMBEDDED[type]?.[childType];
      if ( !field ) return { doc: null, type: null };
      const holder = doc[field];
      doc = Array.isArray(holder) ? holder.find((d: Doc) => d._id === parts[i + 1]) : (holder?._id === parts[i + 1] ? holder : undefined);
      type = childType;
    }
    return { doc: doc ?? null, type: doc ? type : null };
  }

  /** Apply a modifyDocument response (broadcast or ack) to the cache. */
  apply(response: SocketResponse): void {
    if ( !this.ready || !response?.type || response.operation?.pack ) return;
    const { type, action, result } = response;
    if ( !Array.isArray(result) ) return;
    const parentUuid: string | undefined = response.operation?.parentUuid;

    if ( !parentUuid ) {
      const c = this.collection(type);
      for ( const r of result ) {
        if ( action === "create" ) { if ( r?._id ) c.set(r._id, r); }
        else if ( action === "update" ) { const doc = c.get(r?._id); if ( doc ) applyDiff(doc, r); }
        else if ( action === "delete" ) c.delete(typeof r === "string" ? r : r?._id);
      }
      return;
    }

    const { doc: parent, type: parentType } = this.resolveUuid(parentUuid);
    if ( !parent || !parentType ) return;
    const field = EMBEDDED[parentType]?.[type];
    if ( !field ) return;
    if ( type === "ActorDelta" ) {
      for ( const r of result ) {
        if ( action === "update" && parent.delta ) applyDiff(parent.delta, r);
        else if ( action === "create" ) parent.delta = r;
      }
      return;
    }
    if ( !Array.isArray(parent[field]) ) parent[field] = [];
    const arr: Doc[] = parent[field];
    for ( const r of result ) {
      if ( action === "create" ) {
        const i = arr.findIndex(d => d._id === r?._id);
        if ( i >= 0 ) arr[i] = r; else arr.push(r);
      }
      else if ( action === "update" ) { const d = arr.find(d => d._id === r?._id); if ( d ) applyDiff(d, r); }
      else if ( action === "delete" ) {
        const id = typeof r === "string" ? r : r?._id;
        const i = arr.findIndex(d => d._id === id);
        if ( i >= 0 ) arr.splice(i, 1);
      }
    }
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for ( const [type, c] of this.#docs ) out[type] = c.size;
    return out;
  }
}
