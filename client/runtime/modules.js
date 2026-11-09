/**
 * Module profiles, client half.
 * Swipe Sidecar strips a blocked module's script and style tags from the game view and lists the ids in
 * globalThis.SwipeSidecar.blockedModules. That leaves one more source of truth: the `world` payload Foundry sends
 * over the socket, which still says the module is active. Wrapping the socket's `world` request lets this
 * client see those modules as inactive, so other modules' `.active` checks stay honest and, when the
 * profile asks for it, the blocked modules' world-scope settings never reach memory either.
 */
const blocked = new Set(globalThis.SwipeSidecar?.blockedModules ?? []);
const dropSettings = globalThis.SwipeSidecar?.dropSettings !== false;

if ( blocked.size && globalThis.io?.connect ) {
  const originalConnect = globalThis.io.connect;
  globalThis.io.connect = function(...args) {
    const socket = originalConnect.apply(this, args);
    const originalEmit = socket.emit.bind(socket);
    socket.emit = function(event, ...rest) {
      if ( (event === "world") && (typeof rest.at(-1) === "function") ) {
        const callback = rest.pop();
        rest.push(data => { filterWorld(data); callback(data); });
      }
      return originalEmit(event, ...rest);
    };
    return socket;
  };
}

function filterWorld(data) {
  if ( !data ) return;
  let inactive = 0;
  for ( const m of data.modules ?? [] ) {
    if ( !blocked.has(m.id) || !m.active ) continue;
    m.active = false;
    m.flags = { ...(m.flags ?? {}), swipeSidecar: { ...(m.flags?.swipeSidecar ?? {}), blockedByProfile: true } };
    inactive++;
  }
  let dropped = 0;
  if ( dropSettings && Array.isArray(data.settings) ) {
    const before = data.settings.length;
    data.settings = data.settings.filter(s => {
      const scope = String(s.key ?? "").split(".")[0];
      return !blocked.has(scope);
    });
    dropped = before - data.settings.length;
  }
  console.log(`Swipe Sidecar | profile "${globalThis.SwipeSidecar?.profile}" blocked ${inactive} module(s)${dropped ? `, dropped ${dropped} of their settings` : ""}: ${[...blocked].join(", ")}`);
}
