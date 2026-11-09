/**
 * Join page: keep the user picker on screen.
 * JoinGameForm anchors the Autocomplete menu to the right edge of the username input, which lands
 * off-screen on phones. On narrow viewports we ignore the requested position and open the menu
 * directly under the input, at the input's width.
 */
const NARROW_VIEWPORT = 720;
const Autocomplete = globalThis.foundry?.applications?.ux?.Autocomplete;

if ( Autocomplete && !Autocomplete.prototype._sidecarPatched ) {
  const original = Autocomplete.prototype.activate;
  Autocomplete.prototype.activate = function(target, entries, options = {}) {
    if ( !(target instanceof HTMLElement) || (window.innerWidth > NARROW_VIEWPORT) ) {
      return original.call(this, target, entries, options);
    }
    const rect = target.getBoundingClientRect();
    const result = original.call(this, target, entries, {
      ...options,
      position: { top: rect.bottom + 4, left: rect.left }
    });
    if ( this.element ) {
      this.element.style.width = `${rect.width}px`;
      this.element.style.maxWidth = `${rect.width}px`;
      this.element.style.minWidth = "0";
    }
    return result;
  };
  Autocomplete.prototype._sidecarPatched = true;
}
