/**
 * Texture eviction for phones and tablets.
 * Foundry's TextureLoader already expires cached textures after every scene draw, excluding the ones the new scene
 * uses, but only when they have sat unused for CACHE_TTL (15 minutes) or the total exceeds a desktop-sized memory
 * limit (1.7 GB and up). Neither triggers on a phone, so every scene visited stays on the GPU. The profile rule
 * `textures.cacheTTL` (seconds; phone 0, tablet 120, desktop null = Foundry's default) shortens that window, so a
 * TTL of 0 turns Foundry's own pass into "keep only what this scene needs". GMs keep Foundry's default unless
 * `textures.evictForGM` is set, since they flip between scenes and want them warm. Preloaded scenes survive a
 * zero TTL as long as the next draw is the preloaded scene: Foundry excludes the drawn scene's sources.
 *
 * Swipe VTT applies the same change on mobile for worlds without Swipe Sidecar. Both sides must guard against doing it
 * twice: Swipe skips it when the sidecar is detected, and this file skips it when Swipe has already set the TTL
 * (Swipe marks it with TextureLoader._swipeTextureEviction = true). Setting it twice is harmless, but one owner
 * keeps the behaviour predictable when either side changes the value.
 */
const rule = globalThis.SwipeSidecar?.textures ?? { cacheTTL: null, evictForGM: false };

if ( rule.cacheTTL !== null && rule.cacheTTL !== undefined ) {
  // At "ready" game.user is known, so GMs can keep Foundry's default and flip scenes without reloading textures.
  globalThis.Hooks?.once("ready", () => {
    const TextureLoader = globalThis.foundry?.canvas?.TextureLoader;
    if ( !TextureLoader || TextureLoader._swipeTextureEviction ) return;
    if ( globalThis.game?.user?.isGM && !rule.evictForGM ) return;
    TextureLoader.CACHE_TTL = Math.max(0, Number(rule.cacheTTL)) * 1000;
    console.log(`Swipe Sidecar | texture cache TTL set to ${rule.cacheTTL}s: textures of scenes you leave are released on a later scene draw`);
  });
}

/** Approximate GPU bytes held by unique base textures, for diagnostics and tests. */
globalThis.SwipeSidecar ??= {};
globalThis.SwipeSidecar.textureCensus = function() {
  const seen = new Map();
  for ( const [key, texture] of Object.entries(PIXI.utils.BaseTextureCache) ) {
    if ( !texture || texture.destroyed ) continue;
    if ( !seen.has(texture.uid) ) seen.set(texture.uid, { width: texture.width, height: texture.height, keys: [] });
    seen.get(texture.uid).keys.push(key);
  }
  const textures = [...seen.values()];
  const bytes = textures.reduce((sum, t) => sum + (t.width * t.height * 4), 0);
  return { count: textures.length, mb: Math.round(bytes / 1048576), textures };
};
