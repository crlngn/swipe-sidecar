/**
 * A text patch applied to Foundry's client bundle (public/scripts/foundry.mjs).
 * Patches are exact-string replacements verified by occurrence count. When the count does not match,
 * the patch is skipped and logged; the bundle is otherwise served unchanged (fail-open).
 */
export interface BundlePatch {
  id: string;
  description: string;
  /** Foundry release builds this patch was verified against. Informational; the text check is authoritative. */
  builds: number[];
  find: string;
  replace: string;
  /** Expected number of occurrences of `find`. Defaults to 1. */
  expect?: number;
  /** Feature flag in the sidecar config that enables this patch. */
  feature?: string;
}

import { touchRightClick } from "./touch-right-click.ts";
import { touchDoubleTapTime, touchDoubleTapDistance } from "./touch-double-tap.ts";

export const PATCHES: BundlePatch[] = [
  touchRightClick,
  touchDoubleTapTime,
  touchDoubleTapDistance
];
