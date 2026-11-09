# Swipe Sidecar

A same-origin reverse proxy that runs beside a self-hosted Foundry VTT v14 and makes it usable on phones and tablets, including loading large worlds on iOS. It is the server-side companion to the [Swipe VTT](https://github.com/crlngn/swipe-vtt) module and also works on its own. Foundry's files are never modified: every change is applied at request time, on the user's own machine, to their own licensed copy.

## What it does today

- Proxies HTTP and WebSocket traffic to Foundry on the same origin, so the session cookie and socket.io keep working.
- Injects `client/overlay.css` and `client/runtime.js` into every Foundry view (join, setup, game, ...).
- Patches `scripts/foundry.mjs` on the way through with hash-verified, fail-open text patches (see `src/patches/`).
- Resolves a client profile (`desktop`, `tablet`, `phone`) from `?profile=`, a cookie, or the user agent, and exposes it as `globalThis.SwipeSidecar`.
- Serves `/swipe-sidecar/status` with the proxy state and the patch report.

Mobile fixes shipped so far: join page in one column with the user picker under the input, setup page phone layout, touch long-press as right-click on the canvas and in HTML, touch double-tap tolerance, fixed-layout windows scaled to fit with pinch-zoom and two-finger pan, HTML5 drag-and-drop emulated for touch (hold to lift, drag, drop), tour overlays on phones, and the small-screen warnings silenced.

## Testing on a phone

`tools/cdp.mjs` drives an Android Chrome tab over `adb` with real touch events: pair the phone, run `adb forward tcp:9222 localabstract:chrome_devtools_remote`, then `node tools/cdp.mjs <targetId> eval|touch|console ...`. For iOS, where no debugger is reachable, use the load reports on `/swipe-sidecar/report`.

## Install

Swipe Sidecar is for **self-hosted** Foundry VTT v14: it runs as a second Node process on the machine that runs Foundry, so it cannot be used with hosted services (The Forge, Molten, and similar) where you do not control the server. Swipe Sidecar is in **beta**; see [Document policy](#document-policy) for the switch that turns its most invasive part off.

1. **Node 24 or newer.** Foundry v14 needs it too, so the one you run Foundry with will do.
2. **Get Swipe Sidecar and its dependencies.** Download the release archive (or clone the repository) and run `npm install` in its folder. `sharp` and `basisu` are optional dependencies used only by the compressed-texture service. If either fails to install on your platform, npm skips it and the install still succeeds: Swipe Sidecar starts normally, logs that compressed textures are unavailable, and refuses to enable them (`/swipe-sidecar/status` lists what is missing under `textures.missing`). `npm install --include=optional` retries them; `npm install --omit=optional` leaves them out on purpose.
3. **Create the config.** Copy `swipe-sidecar.config.example.json` to `swipe-sidecar.config.json` and set:
   - `upstream.url` to Foundry's own address, for example `https://localhost:30000`. Keep `rejectUnauthorized: false` if Foundry uses a self-signed certificate.
   - `foundry.installPath` (the folder holding Foundry's `package.json`) and `foundry.dataPath` (the folder holding `Config/` and `Data/`).
   - `listen.port`, the port players will use (30001 by default).
4. **HTTPS.** Phones need a secure origin for a smooth session. Point `listen.tls.cert` and `listen.tls.key` at PEM files: reuse Foundry's own certificate, or on a home network create one with [mkcert](https://github.com/FiloSottile/mkcert) for your machine's LAN address. A certificate from your own CA must be trusted on each device (on iOS: install the root certificate profile, then enable it under Settings → General → About → Certificate Trust Settings). Remove `tls` to serve plain HTTP.
5. **Start it.**

   ```bash
   npm start                                # uses ./swipe-sidecar.config.json
   node src/index.ts /path/to/other.config.json
   ```

   On first start Swipe Sidecar generates an API token, saves it in the config as `api.token`, and prints it once.
6. **Tell Foundry about the new address.** In Foundry's `Config/options.json`, set `proxyPort` to Swipe Sidecar's port and `proxySSL` to `true` when Swipe Sidecar serves HTTPS, then restart Foundry, so invitation links point at Swipe Sidecar.
7. **Connect.** Players open `https://<host>:<sidecar port>/join` instead of Foundry's port. Desktop players can keep using Foundry directly.

**No Node or npm install needed.** Swipe Sidecar's only required package, `ws`, ships with Foundry too, and Swipe Sidecar borrows Foundry's copy when it has none of its own (it looks in `foundry.installPath`, then in the desktop app around the running executable). GMs who use Foundry's desktop app can run Swipe Sidecar on the app's own built-in Node:

```bash
# macOS
ELECTRON_RUN_AS_NODE=1 "/Applications/Foundry Virtual Tabletop.app/Contents/MacOS/Foundry Virtual Tabletop" src/index.ts
```

```powershell
# Windows (PowerShell)
$env:ELECTRON_RUN_AS_NODE=1; & "C:\Program Files\Foundry Virtual Tabletop\Foundry Virtual Tabletop.exe" src\index.ts
```

Without `npm install`, compressed textures stay off (see step 2). If `ws` is found nowhere, Swipe Sidecar still starts and passes sockets through unchanged, without the document policy, and says so in its log.

To keep Swipe Sidecar running across reboots, a process manager works well:

```bash
npm install -g pm2
pm2 start src/index.ts --name swipe-sidecar --interpreter node -- /path/to/swipe-sidecar.config.json
pm2 save && pm2 startup
```

`https://<host>:<sidecar port>/swipe-sidecar/status` confirms the proxy is up and lists which bundle patches applied. A patch whose text no longer matches the running Foundry build is skipped and logged, and the page is served unchanged.

## Configuration

`swipe-sidecar.config.json`:

| Key | Meaning |
|---|---|
| `listen.port`, `listen.host` | Where the sidecar listens |
| `listen.tls.cert`, `listen.tls.key` | PEM files; omit `tls` for plain HTTP |
| `upstream.url` | Foundry's own address |
| `upstream.rejectUnauthorized` | `false` for self-signed Foundry certificates |
| `foundry.installPath` | Lets the sidecar read Foundry's build number for patch verification |
| `features.bundlePatches` | Master switch for `foundry.mjs` patches |
| `features.touchRightClick` | Long-press on the canvas acts as right-click |
| `features.documentPolicy` | Trim the world per profile (default `true`, beta); `false` makes the socket a raw pass-through |
| `profiles.default` | `auto` (user-agent sniff), `desktop`, `tablet`, or `phone` |

For production, point Foundry's `options.json` at the sidecar with `proxyPort` and `proxySSL` so invitation links and client addresses are right.

## Layout

```
src/index.ts          entry point
src/deps.ts           finds `ws` in Swipe Sidecar's node_modules or Foundry's install
src/proxy.ts          HTTP/WebSocket proxy, view and bundle rewriting
src/rewrite/html.ts   tag injection into Foundry views
src/rewrite/bundle.ts patch application and caching
src/patches/          one file per bundle patch
src/profile.ts        client profile resolution
src/textures/         KTX2 texture service (encode, cache, serve, rewrite)
src/routes.ts         /swipe-sidecar/* static files and status
client/overlay.css    unlayered stylesheet, wins over Foundry's cascade layers
client/runtime.js     module script evaluated right after foundry.mjs
client/runtime/*.js   one runtime patch per concern (textures.js: GPU texture eviction on small profiles)
```

## Load diagnostics

Every game load through Swipe Sidecar posts a few beacons (timings, bytes per package, the world payload per collection with its heaviest documents, compendium index weight, textures on the canvas, heap where the browser exposes it, and a clean-exit marker). Open `/swipe-sidecar/report` to list runs, inspect one, or compare two. No debugger is needed on the device, which is the point for iOS Safari. A run whose previous load never reported a clean exit is flagged as a probable crash.

## Module profiles

A profile decides which modules a `desktop`, `tablet` or `phone` client loads. Swipe Sidecar enforces it at three points: the module's script and style tags are removed from the game view, the client sees the module as inactive in the `world` payload (and, by default, its world-scope settings are dropped too), and requests for its code answer 403. Assets such as images still load, since world documents may reference them. Dependencies win over blocking: whatever an active module `requires` stays loaded, and `alwaysOn` modules are never blocked.

Three layers decide, weakest to strongest:

1. The module's manifest: `"flags": { "swipeSidecar": { "profiles": { "phone": false } } }` opts out of a profile. Foundry treats `flags` as opaque, so this is safe to ship in any module.
2. The profile rule in `data/profiles.json`: `mode: "deny"` loads everything except `modules`; `mode: "allow"` loads only `modules`.
3. `alwaysOn`, which wins over both. Defaults to `socketlib` and `lib-wrapper`.

A profile rule also carries `textures.cacheTTL` (seconds a texture may sit unused before Foundry releases it on a later scene draw; phone 0, tablet 120, desktop `null` for Foundry's 15 minutes) and `textures.evictForGM` (off by default, so GMs keep scenes warm while they flip between them).

API, for Swipe or a script (writes need the bearer token Swipe Sidecar prints on first start and stores under `api.token`):

```bash
curl -k https://localhost:30001/swipe-sidecar/api/profiles
curl -k https://localhost:30001/swipe-sidecar/api/modules
curl -k "https://localhost:30001/swipe-sidecar/api/blocked?profile=phone&active=crlngn-ui,swipe-vtt,socketlib"
curl -k -X PUT https://localhost:30001/swipe-sidecar/api/profiles \
  -H "authorization: Bearer $SWIPE_SIDECAR_TOKEN" -H "content-type: application/json" \
  -d '{"profile":"phone","rule":{"mode":"deny","modules":["crlngn-ui","dice-so-nice"]}}'
```

A client picks its profile with `?profile=phone` once (stored in a cookie) or by user-agent sniffing when `profiles.default` is `auto`.

## Document policy

Swipe Sidecar terminates the WebSocket (one upstream socket per client) and keeps a copy of the world in the shape Foundry sends it. Foundry sends every client the complete world regardless of permission and broadcasts every change, so the copy fills from whichever client logs in first and stays current afterwards; no Foundry account is needed. For non-GM clients whose profile has `documents.mode: "trim"` (phone and tablet by default), the login payload and every broadcast are filtered:

- Actors, items and journal entries arrive in full when the user has at least LIMITED permission. Actors a token on a held scene references arrive as **stubs** (name, image, prototype token, no items). Everything else is omitted.
- Only the active scene ships with its embedded documents; other scenes are shells. A scene is hydrated on demand when it is activated, when the GM pulls players to it, or when the client views it.
- Chat history is capped (`documents.messages`, default 300).
- Documents flagged by a module that opts in with `flags.swipeSidecar.documents: "all"` in its manifest are kept in full. This is opt-in because content modules stamp their flag on everything they import; without it a single active module would hand players the whole bestiary.
- Settings of modules not active on the client (inactive in the world, or blocked by the profile) are dropped from the login payload.
- A change that makes an omitted document visible (an ownership grant, a token drop) reaches the client as a synthetic create; a stub is upgraded to the full document (a delete followed by a create, which Foundry applies unambiguously) when its sheet opens or ownership arrives, and unlinked tokens rebuild their synthetic actor.

The client runtime reports lookups of documents it never received to the diagnostics as **misses**, grouped by the module that asked, so exceptions can be made per module (`flags.swipeSidecar.documents: "all"` or a profile rule).

**Beta.** The document policy is what makes large worlds load on phones, and it is also the part of Swipe Sidecar most likely to clash with a system or module that expects every document on every client. If something behaves differently through Swipe Sidecar than through Foundry directly, set `"features": { "documentPolicy": false }` in the config and restart Swipe Sidecar: the socket becomes a raw pass-through and every client receives the full world again. Please report the case with the run from `/swipe-sidecar/report`.

## Compressed textures (KTX2)

Scene-level backgrounds and large tiles are what fill a phone's GPU: a 4200x4350 map costs 73 MB as RGBA. Swipe Sidecar can encode such images once as KTX2 UASTC with the Basis Universal encoder (the `basisu` npm package ships the binary), downscaled first to the profile's cap (2048 px by default), and keep the result in its own data folder under `data/textures/`. Foundry v14 ships the KTX2 parser and transcoder, so the phone receives an ASTC texture at a quarter of the memory; a desktop would get BC7. Trimmed clients (phone and tablet, non-GM) get `texture.src` rewritten to `swipe-sidecar/textures/<key>.ktx2` in the world payload and in broadcasts; any path a client sends back is restored, so no compressed path is ever saved. Nothing in Foundry's data folder is touched.

It is opt-in per world, because it takes disk space and CPU. `GET /swipe-sidecar/api/textures` reports the cache and a disk estimate for the running world (read from image headers, no decoding); `POST /swipe-sidecar/api/textures {"enabled": true}` with the bearer token opts the world in and starts the bulk pass, one file at a time at low priority. Scene creates and updates queue encodes for changed images, and a scene whose images are not encoded yet is served with the originals until they are. Images whose longest side is at or below `textures.minDimension` (1024) and animated files are left alone. UASTC only: ETC1S halos text and streaks gradients. `textures.maxBytes` (1 GB) caps the cache with least-recently-served eviction; `DELETE /swipe-sidecar/api/textures` clears it.

| Config key | Default | Meaning |
|---|---|---|
| `textures.enabled` | `true` | Master switch (a world must still opt in) |
| `textures.cacheDir` | `<dataDir>/textures` | Where compressed files live |
| `textures.caps.phone` / `.tablet` / `.desktop` | 2048 / 2048 / `null` | Longest side after downscaling; `null` disables rewriting for the profile |
| `textures.minDimension` | 1024 | Smaller images are never compressed |
| `textures.mipmaps` | `true` | Bake mipmaps (a third more GPU memory, no shimmer when zoomed out) |
| `textures.maxBytes` | 1 GB | Cache cap |

## Module coexistence

Modules can detect the sidecar with `globalThis.SwipeSidecar` (set before any module script runs) and skip their own touch or layout workarounds when it is present. Stylesheets can do the same through the root element classes `html.swipe-sidecar` and `html.swipe-sidecar-<profile>` (`swipe-sidecar-phone`, `swipe-sidecar-tablet`, `swipe-sidecar-desktop`), which Swipe Sidecar's runtime adds before modules load; Swipe Sidecar owns window placement and scaling on small profiles, so a module's own centring or scaling rules for application windows should carry `html:not(.swipe-sidecar)`.

## Licence

Swipe Sidecar is released under [Creative Commons Attribution-NonCommercial 4.0](https://creativecommons.org/licenses/by-nc/4.0/). See `LICENSE`. Swipe Sidecar contains no Foundry Virtual Tabletop code; every change is applied at request time to the user's own licensed copy.
