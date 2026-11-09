# Swipe Sidecar roadmap

What ships today and what is planned. The git log has the detail.

## Shipped

**Mobile interface**
- `/join` in one column on phones, both join themes.
- `/setup` phone layout: sticky menu, scrolling tab strip, world and module tiles.
- Touch long-press as right-click, on the canvas and in HTML; touch double-tap tolerance (400 ms / 30 px).
- Windows that overflow the screen fit to width, with pinch zoom and two-finger or header pan.
- Readable standard forms (labels, inputs and buttons stack on narrow screens).
- HTML5 drag-and-drop on touch (hold 300 ms to lift).
- Tours on phones; small-screen warnings silenced.
- Coexistence with Swipe VTT through `globalThis.SwipeSidecar` and the `html.swipe-sidecar` classes.

**Loading control**
- Module profiles: per-profile allow/deny rules, manifest opt-out (`flags.swipeSidecar.profiles`), `alwaysOn`, dependency closure, settings of blocked modules dropped.
- Document policy (beta): actors, items and journals by permission, stubs for token-referenced actors, scene shells hydrated on activation, pull or view, capped chat history. A test world went from a 13.7 MB to a 9.1 MB login payload.
- Texture eviction of scenes left behind, per profile (`textures.cacheTTL`), GMs exempt by default.
- KTX2 UASTC texture service, opt-in per world: maps downscaled to the profile cap and served at about a quarter of the GPU memory (73 MB to 18 MB for a 4200 px map). Optional dependencies; Swipe Sidecar runs without them.

**Diagnostics**
- Load beacons (timings, bytes per package, world payload, compendium indexes, textures, heap, clean exit) on `/swipe-sidecar/report`, with run comparison and crash detection.
- Document misses per module; texture census (`SwipeSidecar.textureCensus()`).

**Install**
- Self-hoster install guide; runs on the Node bundled with Foundry's desktop app with no `npm install`.

## Planned

- Verified loads on iOS Safari across scene switches.
- Windows testing (Node install and desktop app).
- A launcher that keeps the GM's existing port: Swipe Sidecar takes the port and starts Foundry on a private socket.
- Compendium index trimming per profile.
- Per-profile downscaling of token and tile art; still frames for animated WebM on phones.
- A companion module with a configuration screen: profile rules editor, per-user overrides, texture cache opt-in with a disk estimate.
