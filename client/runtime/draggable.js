/**
 * Draggable: survive touch.
 * Foundry's Draggable listens to pointer events but never to pointercancel, so when the browser takes a
 * touch gesture for scrolling the window-level move/up listeners stay attached. The overlay stylesheet
 * sets touch-action: none on drag and resize handles; this patch adds pointercancel handling and
 * explicit pointer capture for the touch pointer so a fast finger keeps the drag alive.
 */
const Draggable = globalThis.foundry?.applications?.ux?.Draggable;

if ( Draggable && !Draggable.prototype._sidecarPatched ) {
  const wrap = (downName, upName) => {
    const originalDown = Draggable.prototype[downName];
    if ( typeof originalDown !== "function" ) return;
    Draggable.prototype[downName] = function(event) {
      const result = originalDown.call(this, event);
      if ( event.pointerType === "touch" ) {
        const handle = event.currentTarget ?? event.target;
        try { handle?.setPointerCapture?.(event.pointerId); } catch {}
        const onCancel = e => {
          window.removeEventListener("pointercancel", onCancel);
          this[upName]?.(e);
        };
        window.addEventListener("pointercancel", onCancel, { once: true });
      }
      return result;
    };
  };
  wrap("_onDragMouseDown", "_onDragMouseUp");
  wrap("_onResizeMouseDown", "_onResizeMouseUp");
  Draggable.prototype._sidecarPatched = true;
}
