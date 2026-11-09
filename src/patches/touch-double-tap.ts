import type { BundlePatch } from "./index.ts";

/**
 * Double-tap tolerance for touch pointers in MouseInteractionManager.
 *
 * Foundry accepts a second click as a double-click only within 250 ms and 5 px of the first. A finger
 * rarely lands within 5 px of itself, so double-tap on a token is hit and miss. Touch pointers get a wider
 * window (400 ms, 30 px); mouse and pen keep the defaults.
 */
export const touchDoubleTapTime: BundlePatch = {
  id: "touch-double-tap-time",
  description: "Longer double-click window for touch pointers",
  builds: [367],
  feature: "touchRightClick",
  find: `    const maxTime = MouseInteractionManager.DOUBLE_CLICK_TIME_MS;`,
  replace: `    const isTouch = (event.pointerType === "touch") && (globalThis.SwipeSidecar?.features?.touchRightClick !== false);
    const maxTime = isTouch ? 400 : MouseInteractionManager.DOUBLE_CLICK_TIME_MS;`
};

export const touchDoubleTapDistance: BundlePatch = {
  id: "touch-double-tap-distance",
  description: "Wider double-click distance for touch pointers",
  builds: [367],
  feature: "touchRightClick",
  find: `    const maxDistance = MouseInteractionManager.DOUBLE_CLICK_DISTANCE_PX;`,
  replace: `    const maxDistance = isTouch ? 30 : MouseInteractionManager.DOUBLE_CLICK_DISTANCE_PX;`
};
