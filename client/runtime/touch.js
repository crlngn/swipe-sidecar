/**
 * HTML long-press to contextmenu.
 * Foundry's ContextMenu opens on the DOM "contextmenu" event. Android fires it on long-press natively;
 * iOS Safari never does. For touch pointers outside the canvas we time a long-press ourselves and
 * dispatch a synthetic contextmenu on the pressed element, then swallow the click that follows.
 * The canvas (#board) is handled inside MouseInteractionManager by the touch-right-click bundle patch.
 */
const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;
const CLICK_SUPPRESS_MS = 700;
const NATIVE_DUPLICATE_MS = 1000;
const FINGER_GAP = 24;

let pending = null;
let timer = null;
let suppressClickUntil = 0;
let syntheticAt = 0;

function clear() {
  if ( timer ) clearTimeout(timer);
  timer = null;
  pending = null;
}

function fire() {
  const press = pending;
  timer = null;
  pending = null;
  if ( !press ) return;
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: press.clientX,
    clientY: press.clientY,
    screenX: press.screenX,
    screenY: press.screenY,
    button: 2
  });
  event.sidecarSynthetic = true;
  suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
  syntheticAt = performance.now();
  const previous = document.getElementById("context-menu");
  press.target.dispatchEvent(event);
  const menuOpened = !!document.querySelector("#context-menu");
  if ( !event.defaultPrevented && !menuOpened ) lockTooltip(press.target);
  moveMenuOffFinger(press.clientX, press.clientY, previous);
}

/**
 * Foundry pins a fixed context menu's corner to the press point, i.e. under the finger, so lifting it could land on
 * the menu or just outside it (which closes it). Move it FINGER_GAP px below the press, or above when it opens upward.
 * ContextMenu#render is async, so the new menu (not `previous`, which may still be closing) is looked for on each
 * frame for a short while.
 */
function moveMenuOffFinger(x, y, previous=null, attempts=20) {
  const menu = document.getElementById("context-menu");
  if ( !menu?.isConnected || (menu === previous) ) {
    if ( attempts > 0 ) requestAnimationFrame(() => moveMenuOffFinger(x, y, previous, attempts - 1));
    return;
  }
  const height = document.documentElement.clientHeight;
  if ( menu.classList.contains("expand-up") ) {
    menu.style.bottom = `${height - Math.max(0, y - FINGER_GAP)}px`;
    menu.style.maxHeight = `${Math.max(0, y - FINGER_GAP)}px`;
  }
  else {
    menu.style.top = `${y + FINGER_GAP}px`;
    menu.style.maxHeight = `${Math.max(0, height - y - FINGER_GAP)}px`;
  }
}

/**
 * Nothing owned the long-press. If the element carries a tooltip, pin it the way a middle-click would, so a
 * finger can read it; it dismisses on the next tap away or a long-press on the pinned tooltip itself.
 */
function lockTooltip(target) {
  const manager = globalThis.game?.tooltip;
  if ( !manager || !target.closest("[data-tooltip], [data-tooltip-html], [data-tooltip-text]") ) return;
  const tooltip = manager.tooltip ?? document.getElementById("tooltip");
  if ( !tooltip?.classList.contains("active") ) return;
  manager.lockTooltip();
}

document.addEventListener("pointerdown", event => {
  if ( event.pointerType !== "touch" ) return;
  // A second finger means a gesture, not a press: drop any pending long-press.
  if ( !event.isPrimary ) return clear();
  const target = event.target;
  if ( !(target instanceof Element) || target.closest("#board") ) return;
  clear();
  pending = { target, clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY };
  timer = setTimeout(fire, LONG_PRESS_MS);
}, { capture: true, passive: true });

document.addEventListener("pointermove", event => {
  if ( !pending || (event.pointerType !== "touch") ) return;
  if ( Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) > MOVE_TOLERANCE_PX ) clear();
}, { capture: true, passive: true });

document.addEventListener("pointerup", clear, { capture: true, passive: true });
document.addEventListener("pointercancel", clear, { capture: true, passive: true });

// A touch drag (dragdrop.js) in progress is not a press.
document.addEventListener("swipe-sidecar:drag", clear);

// A native long-press contextmenu (Android) arriving first makes ours redundant; its menu is moved off the finger
// too. Arriving just after ours, it is a duplicate: Foundry treats a second contextmenu on the same element as a
// toggle and would close the menu we just opened, so it is swallowed.
document.addEventListener("contextmenu", event => {
  if ( event.sidecarSynthetic ) return;
  if ( performance.now() - syntheticAt < NATIVE_DUPLICATE_MS ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  const press = pending;
  clear();
  if ( press ) moveMenuOffFinger(press.clientX, press.clientY);
}, { capture: true });

// Swallow the click the browser emits after a long-press so the pressed element is not activated too.
document.addEventListener("click", event => {
  if ( performance.now() < suppressClickUntil ) {
    event.stopImmediatePropagation();
    event.preventDefault();
    suppressClickUntil = 0;
  }
}, { capture: true });
