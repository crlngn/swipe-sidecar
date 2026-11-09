/**
 * Swipe Sidecar load report: lists runs posted by client/runtime/diagnostics.js and shows one run's offenders
 * (packages by bytes, world payload by collection with heaviest documents, textures) or a two-run delta.
 */
const state = { runs: [], selected: null, compare: null, cache: new Map() };

const fmtBytes = n => n == null ? "–" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtMs = n => n == null ? "–" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;
const fmtTime = t => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
const device = ua => /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "other";

async function loadRuns() {
  const { runs } = await fetch("/swipe-sidecar/api/metrics").then(r => r.json());
  state.runs = runs;
  renderRuns();
  document.getElementById("summary").textContent = `${runs.length} run${runs.length === 1 ? "" : "s"} recorded`;
}

async function loadRun(id) {
  if ( !state.cache.has(id) ) state.cache.set(id, await fetch(`/swipe-sidecar/api/metrics?run=${encodeURIComponent(id)}`).then(r => r.json()));
  return state.cache.get(id);
}

function renderRuns() {
  const rows = state.runs.map(r => `
    <tr class="run ${r.runId === state.selected ? "selected" : ""}" data-id="${esc(r.runId)}">
      <td>${fmtTime(r.firstSeen)}</td>
      <td>${esc(device(r.userAgent))} <span class="muted">${esc(r.viewport ?? "")}</span></td>
      <td>${esc(r.profile ?? "–")}</td>
      <td>${esc(r.world ?? "–")} <span class="muted">${esc(r.user ?? "")}</span></td>
      <td>${esc(r.scene ?? "–")}</td>
      <td class="num">${r.modules ?? "–"}</td>
      <td class="num">${fmtMs(r.readyMs)}</td>
      <td class="num">${fmtMs(r.canvasReadyMs)}</td>
      <td class="num">${fmtBytes(r.resourceBytes)}</td>
      <td class="num">${fmtBytes(r.worldPayloadBytes)}</td>
      <td class="num">${fmtBytes(r.textureBytes)}</td>
      <td class="num">${r.heapMB != null ? r.heapMB + " MB" : "–"}</td>
      <td>${r.previousRun && !r.previousRun.endedCleanly ? `<span class="pill bad">previous run ${esc(r.previousRun.phase)} → no exit</span>` : ""}
          ${r.endedCleanly ? `<span class="pill ok">clean exit</span>` : `<span class="pill">${esc(r.phases.at(-1))}</span>`}</td>
    </tr>`).join("");
  document.getElementById("runs").innerHTML = `
    <thead><tr><th>When</th><th>Device</th><th>Profile</th><th>World / user</th><th>Scene</th><th class="num">Modules</th>
    <th class="num">Ready</th><th class="num">Canvas</th><th class="num">Downloaded</th><th class="num">World data</th><th class="num">Textures</th><th class="num">Heap</th><th>Exit</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="13" class="muted">No runs yet. Load a world through Swipe Sidecar and come back.</td></tr>`}</tbody>`;
  for ( const tr of document.querySelectorAll("tr.run") ) tr.addEventListener("click", () => select(tr.dataset.id));
}

async function select(id) {
  if ( state.selected && state.selected !== id && !state.compare ) state.compare = id;
  else if ( state.compare === id ) state.compare = null;
  else state.selected = id;
  document.getElementById("clearCompare").hidden = !state.compare;
  renderRuns();
  const a = await loadRun(state.selected);
  const b = state.compare ? await loadRun(state.compare) : null;
  renderDetail(a, b);
}

function table(headers, rows) {
  return `<table><thead><tr>${headers.map((h, i) => `<th class="${i ? "num" : ""}">${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i ? "num" : ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function delta(a, b, fmt = fmtBytes) {
  if ( b == null || a == null ) return "";
  const d = a - b;
  if ( !d ) return `<span class="muted">=</span>`;
  return `<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}</span>`;
}

function renderDetail(a, b) {
  const el = document.getElementById("detail");
  el.hidden = false;
  const pkgA = a.resources?.packages ?? {}, pkgB = b?.resources?.packages ?? {};
  const keys = [...new Set([...Object.keys(pkgA), ...Object.keys(pkgB)])].sort((x, y) => (pkgB[y]?.bytes ?? pkgA[y]?.bytes ?? 0) - (pkgB[x]?.bytes ?? pkgA[x]?.bytes ?? 0));
  const maxPkg = Math.max(1, ...keys.map(k => Math.max(pkgA[k]?.bytes ?? 0, pkgB[k]?.bytes ?? 0)));
  const packagesRows = keys.map(k => {
    const p = pkgA[k], q = pkgB[k];
    return [`<code>${esc(k)}</code><div class="bar" style="width:${Math.round(100 * (p?.bytes ?? 0) / maxPkg)}%"></div>`,
      fmtBytes(p?.bytes), fmtBytes(p?.js), fmtBytes(p?.css), fmtBytes(p?.media), p?.requests ?? "–", b ? `${fmtBytes(q?.bytes)} ${delta(p?.bytes, q?.bytes)}` : ""];
  });

  const colA = a.worldPayload?.collections ?? {}, colB = b?.worldPayload?.collections ?? {};
  const colKeys = [...new Set([...Object.keys(colA), ...Object.keys(colB)])].sort((x, y) => (colA[y]?.bytes ?? 0) - (colA[x]?.bytes ?? 0));
  const collectionRows = colKeys.map(k => [`<code>${esc(k)}</code>`, colA[k]?.count ?? "–", fmtBytes(colA[k]?.bytes), b ? `${fmtBytes(colB[k]?.bytes)} ${delta(colA[k]?.bytes, colB[k]?.bytes)}` : ""]);
  const heavyDocs = colKeys.flatMap(k => (colA[k]?.top ?? []).map(d => ({ ...d, collection: k }))).sort((x, y) => y.bytes - x.bytes).slice(0, 15);

  const tex = a.textures;
  const texRows = (tex?.top ?? []).map(t => [`<span title="${esc(t.src)}">${esc(t.src.split("/").pop())}</span> <span class="muted">${esc(t.packageId)} · ${esc(t.category)}</span>`, `${t.w}×${t.h}`, fmtBytes(t.bytes)]);
  const texCat = Object.entries(tex?.byCategory ?? {}).sort((x, y) => y[1] - x[1]).map(([k, v]) => [esc(k), fmtBytes(v), b ? `${fmtBytes(b.textures?.byCategory?.[k])} ${delta(v, b.textures?.byCategory?.[k])}` : ""]);

  const facts = [
    ["Device", `${esc(device(a.client?.userAgent ?? ""))} · ${esc(a.client?.screen ? `${a.client.screen.viewportW}×${a.client.screen.viewportH} @${a.client.screen.dpr}x` : "")} · ${a.client?.deviceMemoryGB ? a.client.deviceMemoryGB + " GB" : "memory n/a"} · ${a.client?.cores ?? "?"} cores`],
    ["Profile", esc(a.profile ?? "–")],
    ["World", `${esc(a.world?.title)} as ${esc(a.world?.userName)}${a.world?.isGM ? " (GM)" : ""}`],
    ["Scene", a.scene ? `${esc(a.scene.name)} · ${a.scene.w}×${a.scene.h} · ${a.scene.tokens} tokens, ${a.scene.tiles} tiles, ${a.scene.walls} walls, ${a.scene.lights} lights` : "–"],
    ["Packages", `${esc(a.packages?.system)} + ${a.packages?.moduleCount ?? 0} modules`],
    ["Timings", `ready ${fmtMs(a.timings?.readyMs)} · canvas ${fmtMs(a.timings?.canvasReadyMs)}${b ? ` (vs ${fmtMs(b.timings?.readyMs)} / ${fmtMs(b.timings?.canvasReadyMs)})` : ""}`],
    ["Heap", a.heapByPhase ? Object.entries(a.heapByPhase).map(([p, h]) => `${esc(p)} ${h?.usedMB ?? "?"} MB`).join(" · ") : "not exposed by this browser"],
    ["Compendium indexes", `${a.worldPayload?.packCount ?? 0} packs · ${fmtBytes(a.worldPayload?.packIndexBytes)} of index entries in memory`],
    ["Document misses", a.misses ? Object.entries(a.misses).map(([m, v]) => `${esc(m)}: ${v.lookups} lookups of ${v.documents} missing document(s)`).join(" · ") : "none reported"],
    ["Previous run", a.previousRun ? (a.previousRun.endedCleanly ? "ended cleanly" : `<span class="pill bad">stopped at ${esc(a.previousRun.phase)} without unloading (crash or hard reload)</span>`) : "first run in this tab"]
  ];

  el.innerHTML = `
    <div class="panel">
      <h2 style="margin-top:0">Run ${esc(a.runId)} ${b ? `<span class="muted">compared with ${esc(b.runId)}</span>` : ""}</h2>
      ${table(["", ""], facts.map(([k, v]) => [`<strong>${k}</strong>`, `<span style="text-align:left;display:block">${v}</span>`]))}
    </div>
    <div class="grid">
      <div class="panel"><h2 style="margin-top:0">Downloaded per package</h2>
        ${table(["Package", "Total", "JS", "CSS", "Media", "Requests", b ? "Compared" : ""], packagesRows)}
        <p class="muted">${a.resources?.sizedEntries ?? 0} of ${a.resources?.entryCount ?? 0} resources reported a size. Safari before 16.4 reports none.</p></div>
      <div class="panel"><h2 style="margin-top:0">World payload at login</h2>
        ${table(["Collection", "Docs", "Bytes", b ? "Compared" : ""], collectionRows)}
        <h2>Heaviest documents</h2>
        ${table(["Document", "Collection", "Bytes"], heavyDocs.map(d => [esc(d.name), `<code>${esc(d.collection)}</code>`, fmtBytes(d.bytes)]))}
        <h2>Largest compendium indexes</h2>
        ${table(["Pack", "Entries", "Index bytes"], (a.worldPayload?.topPacks ?? []).slice(0, 10).map(p => [`${esc(p.id)} <span class="muted">${esc(p.packageId)}</span>`, p.entries, fmtBytes(p.indexBytes)]))}</div>
      <div class="panel"><h2 style="margin-top:0">Textures on the canvas</h2>
        <p>${tex ? `${tex.count} textures · ${fmtBytes(tex.totalBytes)} of GPU memory` : "no canvas snapshot"}</p>
        ${table(["Category", "Bytes", b ? "Compared" : ""], texCat)}
        <h2>By package</h2>
        ${table(["Package", "Bytes"], Object.entries(tex?.byPackage ?? {}).sort((x, y) => y[1] - x[1]).map(([k, v]) => [`<code>${esc(k)}</code>`, fmtBytes(v)]))}
        <h2>Largest textures</h2>
        ${table(["Texture", "Size", "Bytes"], texRows)}</div>
    </div>`;
}

document.getElementById("refresh").addEventListener("click", () => { state.cache.clear(); loadRuns(); });
document.getElementById("clearCompare").addEventListener("click", () => { state.compare = null; select(state.selected); });
loadRuns();
