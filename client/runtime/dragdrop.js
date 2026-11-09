/**
 * HTML5 drag-and-drop for touch.
 * Mobile browsers do not turn a touch into the dragstart/dragover/drop events that Foundry's DragDrop
 * controller (and every sheet, sidebar tab, the hotbar and the canvas) relies on. This emulates them:
 *
 *   hold a draggable element for HOLD_MS  -> "lift": dragstart is dispatched with a real DataTransfer,
 *                                            and a translucent ghost of the element follows the finger;
 *   move                                  -> dragenter / dragover / dragleave on whatever is under the finger;
 *   release                               -> drop on the current target when its dragover was accepted,
 *                                            then dragend on the source;
 *   release without moving                -> dragend only; the long-press context menu (touch.js) still fires.
 *
 * Elements are eligible when they or an ancestor carry draggable="true", which is exactly what
 * DragDrop#bind sets. A lift that produced no drag data (no handler picked it up) is abandoned.
 */
const HOLD_MS = 300;
const MOVE_TOLERANCE_PX = 10;
const GHOST_OPACITY = 0.75;

let press = null;      // pending hold: {source, pointerId, x, y, timer}
let drag = null;       // active drag: {source, pointerId, dataTransfer, ghost, target, dropAllowed, moved, offsetX, offsetY}

function dragEvent(type, x, y, dataTransfer) {
  return new DragEvent(type, {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, screenX: x, screenY: y, dataTransfer
  });
}

function makeGhost(source, x, y) {
  const rect = source.getBoundingClientRect();
  const ghost = source.cloneNode(true);
  ghost.classList.add("swipe-sidecar-drag-ghost");
  Object.assign(ghost.style, {
    position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`,
    height: `${rect.height}px`, margin: "0", opacity: String(GHOST_OPACITY), pointerEvents: "none",
    zIndex: "2147483647", boxSizing: "border-box", transition: "none"
  });
  document.body.append(ghost);
  return { ghost, offsetX: x - rect.left, offsetY: y - rect.top };
}

function elementUnder(x, y) {
  return document.elementFromPoint(x, y);
}

function lift() {
  const pending = press;
  press = null;
  if ( !pending ) return;
  const dataTransfer = new DataTransfer();
  dataTransfer.effectAllowed = "all";
  const start = dragEvent("dragstart", pending.x, pending.y, dataTransfer);
  pending.source.dispatchEvent(start);
  if ( start.defaultPrevented || !dataTransfer.types.length ) return;
  const { ghost, offsetX, offsetY } = makeGhost(pending.source, pending.x, pending.y);
  drag = { source: pending.source, pointerId: pending.pointerId, dataTransfer, ghost, offsetX, offsetY,
    target: null, dropAllowed: false, moved: false, startX: pending.x, startY: pending.y, x: pending.x, y: pending.y };
}

function clearPress() {
  if ( press?.timer ) clearTimeout(press.timer);
  press = null;
}

function finish(event, dropped) {
  const active = drag;
  drag = null;
  if ( !active ) return;
  active.ghost.remove();
  const x = event?.clientX ?? active.x;
  const y = event?.clientY ?? active.y;
  if ( active.target ) active.target.dispatchEvent(dragEvent("dragleave", x, y, active.dataTransfer));
  if ( dropped && active.moved && active.target && active.dropAllowed ) {
    active.target.dispatchEvent(dragEvent("drop", x, y, active.dataTransfer));
  }
  active.source.dispatchEvent(dragEvent("dragend", x, y, active.dataTransfer));
}

document.addEventListener("pointerdown", event => {
  if ( (event.pointerType !== "touch") || !event.isPrimary ) return;
  const target = event.target;
  const source = target instanceof Element ? target.closest("[draggable=\"true\"]") : null;
  clearPress();
  if ( !source || drag ) return;
  press = { source, pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer: setTimeout(lift, HOLD_MS) };
}, { capture: true, passive: true });

document.addEventListener("pointermove", event => {
  if ( event.pointerType !== "touch" ) return;
  if ( press && (event.pointerId === press.pointerId) ) {
    if ( Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_TOLERANCE_PX ) clearPress();
    return;
  }
  if ( !drag || (event.pointerId !== drag.pointerId) ) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if ( !drag.moved ) {
    if ( Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= MOVE_TOLERANCE_PX ) return;
    drag.moved = true;
    document.dispatchEvent(new CustomEvent("swipe-sidecar:drag"));
  }
  drag.ghost.style.left = `${event.clientX - drag.offsetX}px`;
  drag.ghost.style.top = `${event.clientY - drag.offsetY}px`;
  const under = elementUnder(event.clientX, event.clientY);
  if ( under !== drag.target ) {
    if ( drag.target ) drag.target.dispatchEvent(dragEvent("dragleave", event.clientX, event.clientY, drag.dataTransfer));
    drag.target = under;
    drag.dropAllowed = false;
    if ( under ) under.dispatchEvent(dragEvent("dragenter", event.clientX, event.clientY, drag.dataTransfer));
  }
  if ( under ) {
    const over = dragEvent("dragover", event.clientX, event.clientY, drag.dataTransfer);
    under.dispatchEvent(over);
    drag.dropAllowed = over.defaultPrevented;
  }
}, { capture: true, passive: true });

document.addEventListener("pointerup", event => {
  if ( event.pointerType !== "touch" ) return;
  if ( press && (event.pointerId === press.pointerId) ) clearPress();
  if ( drag && (event.pointerId === drag.pointerId) ) finish(event, true);
}, { capture: true, passive: true });

document.addEventListener("pointercancel", event => {
  if ( event.pointerType !== "touch" ) return;
  if ( press && (event.pointerId === press.pointerId) ) clearPress();
  if ( drag && (event.pointerId === drag.pointerId) ) finish(event, false);
}, { capture: true, passive: true });

// While something is lifted, the finger must not scroll the page or the sheet.
document.addEventListener("touchmove", event => {
  if ( drag ) event.preventDefault();
}, { passive: false, capture: true });
