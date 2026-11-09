import crypto from "node:crypto";
import { PATCHES, type BundlePatch } from "../patches/index.ts";

export interface PatchReport {
  applied: string[];
  skipped: { id: string; reason: string }[];
}

/**
 * Apply every enabled bundle patch to the source text. Each patch must match exactly `expect` times,
 * otherwise it is skipped so that an unknown Foundry build never receives a half-applied change.
 */
export function patchBundle(source: string, features: Record<string, boolean>, build: number | null): { text: string; report: PatchReport } {
  const report: PatchReport = { applied: [], skipped: [] };
  let text = source;
  for ( const patch of PATCHES ) {
    if ( patch.feature && features[patch.feature] === false ) {
      report.skipped.push({ id: patch.id, reason: "disabled by config" });
      continue;
    }
    const expect = patch.expect ?? 1;
    const count = countOccurrences(text, patch.find);
    if ( count !== expect ) {
      report.skipped.push({ id: patch.id, reason: `expected ${expect} match(es), found ${count}` });
      continue;
    }
    if ( build && !patch.builds.includes(build) ) {
      console.warn(`[swipe-sidecar] patch ${patch.id} was not verified against build ${build}; text matched, applying anyway`);
    }
    text = text.split(patch.find).join(patch.replace);
    report.applied.push(patch.id);
  }
  return { text, report };
}

function countOccurrences(haystack: string, needle: string): number {
  if ( !needle ) return 0;
  let count = 0;
  let idx = 0;
  while ( (idx = haystack.indexOf(needle, idx)) !== -1 ) {
    count++;
    idx += needle.length;
  }
  return count;
}

export function etagFor(text: string): string {
  return `"swipe-sidecar-${crypto.createHash("sha1").update(text).digest("hex").slice(0, 16)}"`;
}

export { type BundlePatch };
