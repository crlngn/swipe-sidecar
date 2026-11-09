/**
 * Document policy, client half.
 * When Swipe Sidecar trims the world for this client, three things ask Swipe Sidecar for more on demand:
 *   - viewing a scene whose embedded documents were shipped empty (Scene#view);
 *   - rendering the sheet of an actor that arrived as a stub;
 *   - any code looking up a world document this client never received, which is also reported to the
 *     diagnostics as a "miss" so the GM can see which module needs an exception.
 * Swipe Sidecar answers by pushing the document over the socket as a create or update, exactly as Foundry would.
 */
const NARROW_VIEWPORT = 720;
const misses = new Map();
let reported = false;

async function hydrate(uuid) {
  const sessionId = globalThis.game?.socket?.session?.sessionId;
  if ( !sessionId ) return false;
  try {
    const r = await fetch("/swipe-sidecar/api/hydrate", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, uuid }) });
    const { sent } = await r.json();
    return sent > 0;
  } catch { return false; }
}

/** Wait until the collection holds the document, or give up. */
function waitFor(collection, id, ms = 1500) {
  return new Promise(resolve => {
    const start = performance.now();
    const tick = () => {
      const doc = collection.get(id);
      if ( doc && !doc.flags?.swipeSidecar?.stub ) return resolve(doc);
      if ( performance.now() - start > ms ) return resolve(collection.get(id) ?? null);
      setTimeout(tick, 50);
    };
    tick();
  });
}

globalThis.Hooks?.once("ready", () => {
  const Scene = globalThis.foundry?.documents?.Scene ?? globalThis.Scene;
  if ( Scene?.prototype?.view && !Scene.prototype._sidecarPatched ) {
    const originalView = Scene.prototype.view;
    Scene.prototype.view = async function(options) {
      const empty = !this.tokens.size && !this.walls.size && !this.tiles.size && !this.lights.size;
      if ( empty && await hydrate(`Scene.${this.id}`) ) await new Promise(r => setTimeout(r, 150));
      return originalView.call(this, options);
    };
    Scene.prototype._sidecarPatched = true;
  }

  // Miss detector on the world collections the policy trims.
  for ( const name of ["actors", "items", "journal"] ) {
    const collection = game[name];
    if ( !collection || collection._sidecarPatched ) continue;
    const originalGet = collection.get.bind(collection);
    collection.get = function(id, options) {
      const doc = originalGet(id, options);
      if ( !doc && typeof id === "string" && id.length === 16 ) recordMiss(name, id);
      return doc;
    };
    collection._sidecarPatched = true;
  }
});

function recordMiss(collection, id) {
  const key = `${collection}:${id}`;
  const stack = (new Error().stack ?? "").split("\n").slice(2, 6).map(l => l.trim()).join(" < ");
  const module = (stack.match(/\/modules\/([^/]+)\//) ?? [])[1] ?? (stack.match(/\/systems\/([^/]+)\//) ? "system" : "core");
  if ( !misses.has(key) ) misses.set(key, { collection, id, module, count: 0 });
  misses.get(key).count++;
  hydrate(`${{ actors: "Actor", items: "Item", journal: "JournalEntry" }[collection]}.${id}`);
  if ( !reported ) { reported = true; setTimeout(reportMisses, 5000); }
}

function reportMisses() {
  reported = false;
  const list = [...misses.values()];
  misses.clear();
  if ( !list.length ) return;
  const byModule = {};
  for ( const m of list ) { byModule[m.module] ??= { lookups: 0, documents: 0 }; byModule[m.module].lookups += m.count; byModule[m.module].documents++; }
  console.warn("Swipe Sidecar | document misses (looked up but not delivered to this client):", byModule);
  navigator.sendBeacon?.("/swipe-sidecar/api/metrics", new Blob([JSON.stringify({
    runId: globalThis.SwipeSidecar?.runId ?? "misses", phase: "misses", at: Date.now(), misses: byModule
  })], { type: "application/json" }));
}

// Swipe Sidecar upgrades a stub with a delete followed by a create. Unlinked tokens cache a synthetic actor built from
// the base actor, and that cache is emptied by the delete; rebuild it when the full actor arrives.
globalThis.Hooks?.on("createActor", actor => {
  for ( const scene of game.scenes ) {
    for ( const token of scene.tokens ) {
      if ( token.actorId !== actor.id || token.actorLink || !token.delta ) continue;
      try { token.delta._createSyntheticActor({ reinitializeCollections: true }); } catch {}
      if ( scene === canvas.scene ) token.object?.renderFlags.set({ redraw: true });
    }
  }
});

// A stub actor's sheet asks for the real thing first.
globalThis.Hooks?.on("preRenderActorSheetV2", app => {
  const actor = app.document;
  if ( actor?.flags?.swipeSidecar?.stub ) hydrate(`Actor.${actor.id}`).then(sent => { if ( sent ) waitFor(game.actors, actor.id).then(() => app.render()); });
});
