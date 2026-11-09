import type { BundlePatch } from "./index.ts";

/**
 * Long-press with a touch pointer becomes a right-click inside MouseInteractionManager.
 *
 * Foundry already arms a 500 ms long-press timer on every left pointer-down. For touch pointers we
 * redirect that timer into the right-click branch, so every placeable, HUD and layer receives the same
 * `clickRight` workflow (with the same permission checks) that a mouse button 2 would trigger.
 * The interaction then continues as a right-click: moving the finger becomes a right drag (canvas pan),
 * lifting it fires `unclickRight` and the long-press fires no ping.
 */
export const touchRightClick: BundlePatch = {
  id: "touch-right-click",
  description: "Map touch long-press to clickRight in MouseInteractionManager",
  builds: [367],
  feature: "touchRightClick",
  find: `  #handleLongPress(event, origin) {
    const action = "longPress";`,
  replace: `  #handleLongPress(event, origin) {
    if ( (event.pointerType === "touch") && (globalThis.SwipeSidecar?.features?.touchRightClick !== false) ) {
      if ( !this.state.between(this.states.HOVER, this.states.DRAG) ) return;
      this._sidecarTouchRight = true;
      return this.#handleRightDown(event);
    }
    const action = "longPress";`
};
