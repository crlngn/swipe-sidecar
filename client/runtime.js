/**
 * Swipe Sidecar runtime.
 * Evaluated as a module script immediately after foundry.mjs, before Foundry constructs its applications.
 * Each file patches public or protected APIs only; anything private lives in a server-side bundle patch.
 */
// Mark the document early so module stylesheets can defer to Swipe Sidecar (e.g. `html.swipe-sidecar` / `html.swipe-sidecar-phone`).
// Runs before <body> exists, hence the root element.
{
  const root = document.documentElement;
  root.classList.add("swipe-sidecar");
  if ( globalThis.SwipeSidecar?.profile ) root.classList.add(`swipe-sidecar-${globalThis.SwipeSidecar.profile}`);
}

import "./runtime/modules.js";
import "./runtime/documents.js";
import "./runtime/join.js";
import "./runtime/notifications.js";
import "./runtime/draggable.js";
import "./runtime/touch.js";
import "./runtime/windows.js";
import "./runtime/tours.js";
import "./runtime/dragdrop.js";
import "./runtime/textures.js";
import "./runtime/diagnostics.js";

console.log("Swipe Sidecar | runtime ready", globalThis.SwipeSidecar);
