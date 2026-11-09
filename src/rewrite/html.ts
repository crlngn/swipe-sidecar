import type { Profile } from "../profile.ts";

export interface HtmlContext {
  version: string;
  profile: Profile;
  build: number | null;
  features: Record<string, boolean>;
  /** Module ids blocked for this client; their script and style tags are removed. */
  blockedModules?: string[];
  dropSettings?: boolean;
  /** The profile's texture rule, exposed to the runtime as SwipeSidecar.textures. */
  textures?: { cacheTTL: number | null; evictForGM: boolean };
}

/** Module ids that have script or style tags in a game view: exactly the world's active modules. */
export function activeModulesIn(html: string): string[] {
  const ids = new Set<string>();
  for ( const m of html.matchAll(/(?:src|href)="[^"]*?modules\/([^/"]+)\/[^"]*"/g) ) ids.add(m[1]);
  for ( const m of html.matchAll(/@import "[^"]*?modules\/([^/"]+)\/[^"]*"/g) ) ids.add(m[1]);
  return [...ids];
}

function stripModules(html: string, blocked: string[]): string {
  let out = html;
  for ( const id of blocked ) {
    const safe = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`^[ \\t]*<script src="[^"]*?modules/${safe}/[^"]*"[^>]*></script>[ \\t]*\\r?\\n?`, "gm"), "");
    out = out.replace(new RegExp(`^[ \\t]*@import "[^"]*?modules/${safe}/[^"]*"[^;]*;[ \\t]*\\r?\\n?`, "gm"), "");
  }
  return out;
}

const FOUNDRY_SCRIPT = /(<script src="[^"]*scripts\/foundry\.mjs" type="module"><\/script>)/;

/**
 * Inject the sidecar marker, overlay stylesheet and runtime module into a Foundry view.
 * The marker goes first in <head> so modules can detect the sidecar before they run.
 * The runtime is a module script placed right after foundry.mjs, so it evaluates after the bundle
 * and before DOMContentLoaded, which is when Foundry constructs its applications.
 */
export function rewriteView(html: string, ctx: HtmlContext): string {
  const marker = `<script>globalThis.SwipeSidecar=${JSON.stringify({
    version: ctx.version, profile: ctx.profile, build: ctx.build, features: ctx.features,
    blockedModules: ctx.blockedModules ?? [], dropSettings: ctx.dropSettings ?? true,
    textures: ctx.textures ?? { cacheTTL: null, evictForGM: false }
  })};</script>`;
  let out = html.replace(/<head>/i, `<head>\n    ${marker}`);
  if ( ctx.blockedModules?.length ) out = stripModules(out, ctx.blockedModules);
  out = out.replace(/<\/head>/i, `    <link rel="stylesheet" href="/swipe-sidecar/overlay.css">\n</head>`);
  if ( FOUNDRY_SCRIPT.test(out) ) {
    out = out.replace(FOUNDRY_SCRIPT, `$1\n    <script src="/swipe-sidecar/runtime.js" type="module"></script>`);
  }
  else {
    out = out.replace(/<\/body>/i, `    <script src="/swipe-sidecar/runtime.js" type="module"></script>\n</body>`);
  }
  return out;
}
