/**
 * Silence the small-screen warnings.
 * ClientIssues raises permanent ERROR.RESOLUTION.* notifications on every resize when the viewport is
 * under 1024x768. The thresholds are private static fields, so the notification itself is filtered.
 * A stub is returned so ClientIssues can still call Notifications#remove on it later.
 */
const Notifications = globalThis.foundry?.applications?.ui?.Notifications;
const SUPPRESSED = /^ERROR\.RESOLUTION\./;

if ( Notifications && !Notifications.prototype._sidecarPatched ) {
  const original = Notifications.prototype.notify;
  Notifications.prototype.notify = function(message, type, options) {
    if ( (typeof message === "string") && SUPPRESSED.test(message) ) {
      return { id: 0, type, message, active: false, remove() {}, update() {} };
    }
    return original.call(this, message, type, options);
  };
  Notifications.prototype._sidecarPatched = true;
}
