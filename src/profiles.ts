import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Client profiles: which modules a phone, tablet or desktop client loads.
 *
 * Three layers decide whether a module is blocked for a profile, from weakest to strongest:
 *   1. the module's own manifest: `flags.swipeSidecar.profiles: { phone: false }` opts out of a profile;
 *   2. the profile's mode and lists in data/profiles.json (editable through the API):
 *        mode "deny"  -> everything loads except `modules`;
 *        mode "allow" -> only `modules` load;
 *   3. `alwaysOn` in the profile, which wins over both.
 * Dependencies win over blocking: a module that stays active pulls in everything it `requires`.
 * Absence of any rule means "loads everywhere", so modules that never heard of Swipe Sidecar behave as today.
 */
export type ProfileName = "desktop" | "tablet" | "phone";

export interface DocumentRule {
  mode: "full" | "trim";
  stubReferenced: boolean;
  keepModuleFlagged: boolean;
  messages: number | null;
  sceneEmbedded: "active" | "all";
}

export interface ProfileRule {
  mode: "allow" | "deny";
  modules: string[];
  alwaysOn: string[];
  /** Also drop this profile's blocked modules' world-scope settings from the login payload. */
  dropSettings: boolean;
  /** What documents this profile's non-GM clients receive; see src/socket/policy.ts. */
  documents: DocumentRule;
  /** GPU texture cache behaviour on this profile's clients; see client/runtime/textures.js. */
  textures: TextureRule;
}

export interface TextureRule {
  /**
   * Seconds a texture may sit unused before Foundry releases it on the next scene draw; null keeps Foundry's
   * default (15 minutes). 0 keeps only the current scene on the GPU.
   */
  cacheTTL: number | null;
  /** Apply the TTL to GM and assistant clients too. Off by default: GMs flip scenes quickly and want them warm. */
  evictForGM: boolean;
}

export type ProfileRules = Record<ProfileName, ProfileRule>;

export interface ManifestSummary {
  id: string;
  title: string;
  version: string | null;
  library: boolean;
  requires: string[];
  swipeSidecar: { profiles?: Partial<Record<ProfileName, boolean>>; documents?: "all" } | null;
}

const FULL_DOCS: DocumentRule = { mode: "full", stubReferenced: true, keepModuleFlagged: true, messages: null, sceneEmbedded: "all" };
const TRIM_DOCS: DocumentRule = { mode: "trim", stubReferenced: true, keepModuleFlagged: true, messages: 300, sceneEmbedded: "active" };
const DEFAULT_RULE: ProfileRule = { mode: "deny", modules: [], alwaysOn: [], dropSettings: true, documents: FULL_DOCS, textures: { cacheTTL: null, evictForGM: false } };
const DEFAULT_DOCS: Record<ProfileName, DocumentRule> = { desktop: FULL_DOCS, tablet: TRIM_DOCS, phone: TRIM_DOCS };
const DEFAULT_TEXTURES: Record<ProfileName, TextureRule> = {
  desktop: { cacheTTL: null, evictForGM: false },
  tablet: { cacheTTL: 120, evictForGM: false },
  phone: { cacheTTL: 0, evictForGM: false }
};
const DEFAULT_ALWAYS_ON = ["socketlib", "lib-wrapper"];

export class ProfileStore {
  #file: string;
  #modulesDir: string | null;
  #rules: ProfileRules;
  #manifests = new Map<string, ManifestSummary>();
  #manifestsScanned = 0;

  constructor(dataDir: string, foundryDataPath: string | undefined) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.#file = path.join(dataDir, "profiles.json");
    this.#modulesDir = foundryDataPath ? path.join(foundryDataPath, "Data", "modules") : null;
    this.#rules = this.#load();
    this.scanManifests();
  }

  #load(): ProfileRules {
    let parsed: Partial<ProfileRules> = {};
    if ( fs.existsSync(this.#file) ) {
      try { parsed = JSON.parse(fs.readFileSync(this.#file, "utf8")); } catch {}
    }
    const rule = (name: ProfileName): ProfileRule => ({
      ...DEFAULT_RULE,
      alwaysOn: [...DEFAULT_ALWAYS_ON],
      ...(parsed[name] ?? {}),
      documents: { ...DEFAULT_DOCS[name], ...((parsed[name] as any)?.documents ?? {}) },
      textures: { ...DEFAULT_TEXTURES[name], ...((parsed[name] as any)?.textures ?? {}) }
    });
    return { desktop: rule("desktop"), tablet: rule("tablet"), phone: rule("phone") };
  }

  save(): void {
    fs.writeFileSync(this.#file, JSON.stringify(this.#rules, null, 2) + "\n");
  }

  get rules(): ProfileRules {
    return this.#rules;
  }

  setRule(name: ProfileName, rule: Partial<ProfileRule>): ProfileRule {
    const current = this.#rules[name];
    const next: ProfileRule = {
      mode: rule.mode === "allow" ? "allow" : rule.mode === "deny" ? "deny" : current.mode,
      modules: Array.isArray(rule.modules) ? rule.modules.map(String) : current.modules,
      alwaysOn: Array.isArray(rule.alwaysOn) ? rule.alwaysOn.map(String) : current.alwaysOn,
      dropSettings: typeof rule.dropSettings === "boolean" ? rule.dropSettings : current.dropSettings,
      documents: { ...current.documents, ...(rule.documents ?? {}) },
      textures: {
        cacheTTL: rule.textures?.cacheTTL === null ? null
          : Number.isFinite(Number(rule.textures?.cacheTTL)) ? Math.max(0, Number(rule.textures?.cacheTTL)) : current.textures.cacheTTL,
        evictForGM: typeof rule.textures?.evictForGM === "boolean" ? rule.textures.evictForGM : current.textures.evictForGM
      }
    };
    this.#rules[name] = next;
    this.save();
    return next;
  }

  /* -------------------------------------------- */

  /** Read every module.json under the Foundry data folder. Cheap; re-run on demand from the API. */
  scanManifests(): number {
    this.#manifests.clear();
    if ( !this.#modulesDir || !fs.existsSync(this.#modulesDir) ) return 0;
    for ( const entry of fs.readdirSync(this.#modulesDir, { withFileTypes: true }) ) {
      if ( !entry.isDirectory() && !entry.isSymbolicLink() ) continue;
      const file = path.join(this.#modulesDir, entry.name, "module.json");
      try {
        const m = JSON.parse(fs.readFileSync(file, "utf8"));
        const id = String(m.id ?? m.name ?? entry.name);
        this.#manifests.set(id, {
          id,
          title: String(m.title ?? id),
          version: m.version ? String(m.version) : null,
          library: !!m.library,
          requires: (m.relationships?.requires ?? []).map((r: any) => String(r.id)).filter(Boolean),
          swipeSidecar: m.flags?.swipeSidecar ?? null
        });
      } catch {}
    }
    this.#manifestsScanned = Date.now();
    return this.#manifests.size;
  }

  manifest(id: string): ManifestSummary | undefined {
    return this.#manifests.get(id);
  }

  get manifests(): ManifestSummary[] {
    return [...this.#manifests.values()].sort((a, b) => a.title.localeCompare(b.title));
  }

  get manifestsScannedAt(): number {
    return this.#manifestsScanned;
  }

  /* -------------------------------------------- */

  /**
   * Which of the world's active modules are blocked for a profile.
   * @param profile  The client profile.
   * @param active   Module ids the world has active (as seen in the game view's script tags).
   */
  blockedFor(profile: ProfileName, active: Iterable<string>): { blocked: string[]; reasons: Record<string, string> } {
    const rule = this.#rules[profile];
    const activeIds = [...new Set(active)];
    const reasons: Record<string, string> = {};
    const blocked = new Set<string>();

    for ( const id of activeIds ) {
      const manifest = this.#manifests.get(id);
      if ( rule.alwaysOn.includes(id) ) continue;
      if ( rule.mode === "allow" && !rule.modules.includes(id) ) {
        blocked.add(id); reasons[id] = `profile "${profile}" allow-list`;
      }
      else if ( rule.mode === "deny" && rule.modules.includes(id) ) {
        blocked.add(id); reasons[id] = `profile "${profile}" deny-list`;
      }
      else if ( manifest?.swipeSidecar?.profiles?.[profile] === false ) {
        blocked.add(id); reasons[id] = "module manifest flags.swipeSidecar.profiles";
      }
    }

    // Dependencies win: anything an unblocked module requires stays loaded.
    let changed = true;
    while ( changed ) {
      changed = false;
      for ( const id of activeIds ) {
        if ( blocked.has(id) ) continue;
        for ( const dep of this.#manifests.get(id)?.requires ?? [] ) {
          if ( blocked.has(dep) && activeIds.includes(dep) ) {
            blocked.delete(dep);
            reasons[dep] = `kept: required by ${id}`;
            changed = true;
          }
        }
      }
    }
    for ( const id of Object.keys(reasons) ) if ( !blocked.has(id) && !reasons[id].startsWith("kept") ) delete reasons[id];
    return { blocked: [...blocked], reasons };
  }
}

/** Constant-time bearer token check. */
export function authorized(header: string | undefined, token: string | null): boolean {
  if ( !token || !header?.startsWith("Bearer ") ) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
