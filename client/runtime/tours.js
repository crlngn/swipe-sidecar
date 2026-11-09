/**
 * Tours on phones.
 * The new-user experience starts the core welcome tour on the first world load. Its steps point at the
 * sidebar, which is collapsed off-screen on a phone, so on narrow viewports the automatic start is skipped.
 * Tours started by the user (Settings > Tours) still run.
 */
const NARROW_VIEWPORT = 720;
const Tour = globalThis.foundry?.nue?.Tour;
const NUE = globalThis.foundry?.nue?.NewUserExperienceManager;

let suppressAutoStart = false;

if ( Tour && NUE && !Tour.prototype._sidecarPatched ) {
  const originalInitialize = NUE.prototype.initialize;
  NUE.prototype.initialize = function(...args) {
    suppressAutoStart = window.innerWidth <= NARROW_VIEWPORT;
    try {
      return originalInitialize.apply(this, args);
    } finally {
      suppressAutoStart = false;
    }
  };

  const originalStart = Tour.prototype.start;
  Tour.prototype.start = async function(...args) {
    if ( suppressAutoStart ) {
      console.log(`Swipe Sidecar | skipped automatic start of tour ${this.namespace}.${this.id} on a narrow viewport`);
      return;
    }
    return originalStart.apply(this, args);
  };
  Tour.prototype._sidecarPatched = true;
}
