/**
 * Framed windows on small screens.
 *
 * Foundry already caps every window at the viewport width (max-width: 100%), and its own forms reflow
 * cleanly at that width, so nothing is scaled by default. A window is scaled only when it still overflows
 * the viewport after rendering, which happens for fixed-layout system sheets. Those windows get:
 *  - fit-to-width scaling on open (ApplicationV2 supports position.scale natively);
 *  - two-finger pinch to zoom back in, and two-finger drag to pan the zoomed window. Panning uses the CSS
 *    `translate` property, which composes with Foundry's own `transform: scale()` without being overwritten
 *    and is not subject to Foundry's left/top clamping.
 */
const NARROW_VIEWPORT = 720;
const MARGIN_PX = 8;
const MIN_SCALE = 0.3;
const MAX_SCALE = 1.5;
const MIN_VISIBLE_PX = 80;

const isNarrow = () => window.innerWidth <= NARROW_VIEWPORT;

/* -------------------------------------------- */
/*  Fit to width on render                      */
/* -------------------------------------------- */

/** Layout height a scaled window may take when its own height is "auto": what a desktop viewport would allow. */
const AUTO_HEIGHT_CAP_PX = 1000;

/**
 * The size an application class was designed for. `app.options.position` is not usable: Foundry writes the
 * clamped values back into it, so after one render on a phone it only remembers the phone-sized window.
 * The static DEFAULT_OPTIONS along the inheritance chain are never mutated; subclasses override parents.
 */
function designedPosition(app) {
  const chain = [...(app.constructor.inheritanceChain?.() ?? [app.constructor])].reverse();
  const position = {};
  for ( const cls of chain ) Object.assign(position, cls.DEFAULT_OPTIONS?.position ?? {});
  return position;
}

function fitToViewport(app, element) {
  if ( !isNarrow() || !app.hasFrame || app._sidecarFit ) return;
  // Foundry caps every window at the viewport width and its own dialogs reflow to it, so they must stay at
  // scale 1 with normal type. Only a window whose layout still overflows after that cap (a fixed-width
  // system sheet) needs scaling. A re-opened window may carry the scale of its last fit or zoom, and Foundry
  // clamps with that stale scale before this hook runs, so normalise to scale 1 and the designed width first,
  // then measure the real layout width (offsetWidth ignores transforms).
  const designed = designedPosition(app);
  const normalized = { scale: 1 };
  if ( typeof designed.width === "number" ) normalized.width = designed.width;
  if ( ((app.position.scale ?? 1) !== 1) || (normalized.width && app.position.width !== normalized.width) ) {
    app.setPosition(normalized);
  }
  const layoutWidth = element.offsetWidth;
  if ( layoutWidth <= window.innerWidth + 1 ) return;

  const fitted = Number(Math.max(MIN_SCALE, (window.innerWidth - MARGIN_PX) / layoutWidth).toFixed(3));
  const height = (typeof designed.height === "number") ? designed.height : "auto";
  app._sidecarFit = { scale: fitted, width: layoutWidth, height };
  setSizeCaps(element, layoutWidth, height, fitted);
  element.style.translate = "";
  app.setPosition({ left: MARGIN_PX / 2, top: 0, width: layoutWidth, height, scale: fitted });
}

/**
 * Reconcile CSS size caps with Foundry's clamping arithmetic.
 * Foundry caps .application at max-width: 100% / max-height: 100vh, reads the computed caps back and divides
 * them by the scale as if they were on-screen values, then stores the clamped size in its position. Any cap
 * expressed in layout pixels therefore gets inflated (a 1000px min-height at 0.544 becomes a stored height of
 * 1838, which makes Foundry think the window is taller than the screen and pin it to the top).
 *
 * Below scale 1 no cap is needed: with max-* set to "none", Foundry falls back to viewport ÷ scale, which the
 * fit guarantees is at least the designed size, and the layout box is simply the designed size.
 * Above scale 1 the cap is expressed in on-screen pixels (designed × scale): CSS sees a cap larger than the
 * layout, and Foundry divides it back to the designed size. An "auto" height keeps the cap a desktop
 * viewport would give it, so the window keeps its usual proportions instead of stretching to its content.
 */
function setSizeCaps(element, width, height, scale) {
  element.style.minWidth = "";
  element.style.minHeight = "";
  const heightCap = (typeof height === "number") ? height : AUTO_HEIGHT_CAP_PX;
  if ( scale > 1 ) {
    element.style.maxWidth = `${Math.ceil(width * scale)}px`;
    element.style.maxHeight = `${Math.ceil(heightCap * scale)}px`;
  }
  else {
    element.style.maxWidth = "none";
    element.style.maxHeight = (typeof height === "number") ? "none" : `${AUTO_HEIGHT_CAP_PX}px`;
  }
}

// app.position is a read-only proxy, so nothing is restored on close; the next render re-measures the
// window at its unscaled width and fits it again from the class defaults.
globalThis.Hooks?.on("renderApplicationV2", (app, element) => fitToViewport(app, element));
globalThis.Hooks?.on("closeApplicationV2", app => { delete app._sidecarFit; });

/* -------------------------------------------- */
/*  Pinch to zoom, two-finger pan               */
/* -------------------------------------------- */

const gestures = new Map();

function appFor(element) {
  return globalThis.foundry?.applications?.instances?.get(element.id) ?? null;
}

function pinchState(pointers) {
  const [a, b] = [...pointers.values()];
  return { distance: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}

function parseTranslate(element) {
  const [x = "0", y = "0"] = (element.style.translate || "").split(" ");
  return { x: parseFloat(x) || 0, y: parseFloat(y) || 0 };
}

/** Keep at least MIN_VISIBLE_PX of the window on screen in each axis. */
function clampTranslate(element, x, y) {
  const rect = element.getBoundingClientRect();
  const current = parseTranslate(element);
  const left = rect.left - current.x + x;
  const top = rect.top - current.y + y;
  const minLeft = MIN_VISIBLE_PX - rect.width;
  const maxLeft = window.innerWidth - MIN_VISIBLE_PX;
  const minTop = 0 - rect.height + MIN_VISIBLE_PX;
  const maxTop = window.innerHeight - MIN_VISIBLE_PX;
  return {
    x: x + (Math.min(Math.max(left, minLeft), maxLeft) - left),
    y: y + (Math.min(Math.max(top, minTop), maxTop) - top)
  };
}

document.addEventListener("pointerdown", event => {
  if ( event.pointerType !== "touch" ) return;
  const element = event.target instanceof Element ? event.target.closest(".application") : null;
  if ( !element ) return;
  const app = appFor(element);
  if ( !app?.hasFrame || !app._sidecarFit ) return;
  let gesture = gestures.get(element);
  if ( !gesture ) {
    gesture = { app, pointers: new Map(), start: null, frame: 0 };
    gestures.set(element, gesture);
  }
  gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if ( gesture.pointers.size === 2 ) {
    const pinch = pinchState(gesture.pointers);
    gesture.start = { ...pinch, scale: app.position.scale ?? 1, translate: parseTranslate(element) };
    beginTwoFingerGesture(element, gesture, event);
  }
}, { capture: true, passive: true });

/**
 * The moment a second finger lands, nothing else may own the first one: Foundry's header drag (which would
 * move the window while we scale it) is ended with a synthetic pointerup for the first pointer, the hover
 * tooltip is dismissed, and a header pan in progress is dropped.
 */
function beginTwoFingerGesture(element, gesture, event) {
  const firstId = [...gesture.pointers.keys()].find(id => id !== event.pointerId);
  const header = element.querySelector(".window-header");
  if ( header && (firstId !== undefined) && header.hasPointerCapture?.(firstId) ) {
    const first = gesture.pointers.get(firstId);
    element.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, composed: true, view: window,
      pointerId: firstId, pointerType: "touch", isPrimary: true, clientX: first.x, clientY: first.y
    }));
  }
  headerDrag = null;
  globalThis.game?.tooltip?.deactivate?.();
}

// Stop the browser from starting a scroll with the second finger of a gesture on a fitted window.
document.addEventListener("touchstart", event => {
  if ( event.touches.length < 2 ) return;
  const element = event.target instanceof Element ? event.target.closest(".application") : null;
  if ( element && appFor(element)?._sidecarFit ) event.preventDefault();
}, { passive: false, capture: true });

document.addEventListener("pointermove", event => {
  if ( event.pointerType !== "touch" ) return;
  for ( const [element, gesture] of gestures ) {
    if ( !gesture.pointers.has(event.pointerId) ) continue;
    gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if ( gesture.pointers.size !== 2 || !gesture.start || gesture.frame ) return;
    // A timer rather than requestAnimationFrame: it keeps working while the tab is throttled.
    gesture.frame = setTimeout(() => {
      gesture.frame = 0;
      const { start, app } = gesture;
      // A finger may lift between the move event and this tick.
      if ( !start || (gesture.pointers.size !== 2) ) return;
      const now = pinchState(gesture.pointers);
      const fit = app._sidecarFit.scale;
      const scale = Number(Math.min(MAX_SCALE, Math.max(fit, start.scale * (now.distance / start.distance))).toFixed(3));
      if ( scale !== (app.position.scale ?? 1) ) {
        const { width, height } = app._sidecarFit;
        setSizeCaps(element, width, height, scale);
        app.setPosition({ width, height, scale });
      }
      if ( scale <= fit ) {
        element.style.translate = "";
        return;
      }
      const moved = clampTranslate(element, start.translate.x + (now.cx - start.cx), start.translate.y + (now.cy - start.cy));
      element.style.translate = `${Math.round(moved.x)}px ${Math.round(moved.y)}px`;
    }, 16);
    return;
  }
}, { capture: true, passive: true });

function release(event) {
  if ( event.pointerType !== "touch" ) return;
  for ( const [element, gesture] of gestures ) {
    gesture.pointers.delete(event.pointerId);
    if ( gesture.pointers.size < 2 ) gesture.start = null;
    if ( gesture.pointers.size === 0 ) gestures.delete(element);
  }
}
document.addEventListener("pointerup", release, { capture: true, passive: true });
document.addEventListener("pointercancel", release, { capture: true, passive: true });

/* -------------------------------------------- */
/*  One-finger header drag for oversized windows */
/* -------------------------------------------- */

/**
 * Foundry clamps a window's top/left to 0 once it is larger than the viewport, so a zoomed sheet cannot be
 * moved by its header. For fitted windows, a touch drag on the header also pans through `translate`,
 * which Foundry's clamp does not see; at fit scale the window fits and the translate stays at zero.
 */
let headerDrag = null;

document.addEventListener("pointerdown", event => {
  if ( event.pointerType !== "touch" || !event.isPrimary ) return;
  const header = event.target instanceof Element ? event.target.closest(".window-header") : null;
  const element = header?.closest(".application");
  if ( !header || !element || event.target.closest(".header-control, button, a") ) return;
  const app = appFor(element);
  if ( !app?._sidecarFit ) return;
  const rect = element.getBoundingClientRect();
  const oversized = (rect.width > window.innerWidth + 1) || (rect.height > window.innerHeight + 1);
  if ( !oversized ) return;
  headerDrag = { element, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, translate: parseTranslate(element) };
}, { capture: true, passive: true });

document.addEventListener("pointermove", event => {
  if ( !headerDrag || (event.pointerId !== headerDrag.pointerId) ) return;
  const { element, translate } = headerDrag;
  const moved = clampTranslate(element, translate.x + (event.clientX - headerDrag.startX), translate.y + (event.clientY - headerDrag.startY));
  element.style.translate = `${Math.round(moved.x)}px ${Math.round(moved.y)}px`;
}, { capture: true, passive: true });

function endHeaderDrag(event) {
  if ( headerDrag && (event.pointerId === headerDrag.pointerId) ) headerDrag = null;
}
document.addEventListener("pointerup", endHeaderDrag, { capture: true, passive: true });
document.addEventListener("pointercancel", endHeaderDrag, { capture: true, passive: true });

// While two fingers are on a window, keep the browser from turning the gesture into a scroll or zoom.
document.addEventListener("touchmove", event => {
  for ( const gesture of gestures.values() ) {
    if ( gesture.pointers.size === 2 ) { event.preventDefault(); return; }
  }
}, { passive: false });
