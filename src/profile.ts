import type http from "node:http";
import type { SidecarConfig } from "./config.ts";

export type Profile = "desktop" | "tablet" | "phone";
const COOKIE = "swipe_sidecar_profile";
const VALID = new Set<Profile>(["desktop", "tablet", "phone"]);

/**
 * Resolve the client profile for a request.
 * Priority: ?profile= query parameter (which also sets the cookie), the cookie, then user-agent sniffing.
 * Returns the profile and, when the query parameter was used, the Set-Cookie header to emit.
 */
export function resolveProfile(req: http.IncomingMessage, config: SidecarConfig): { profile: Profile; setCookie?: string } {
  const url = new URL(req.url ?? "/", "http://swipe-sidecar");
  const requested = url.searchParams.get("profile") as Profile | null;
  if ( requested && VALID.has(requested) ) {
    return { profile: requested, setCookie: `${COOKIE}=${requested}; Path=/; Max-Age=31536000; SameSite=Lax` };
  }
  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = cookies[COOKIE] as Profile | undefined;
  if ( fromCookie && VALID.has(fromCookie) ) return { profile: fromCookie };
  if ( config.profiles.default !== "auto" ) return { profile: config.profiles.default };
  return { profile: sniff(req.headers["user-agent"] ?? "") };
}

function sniff(ua: string): Profile {
  if ( /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ) return "tablet";
  if ( /iPhone|iPod|Android.*Mobile|Mobi/i.test(ua) ) return "phone";
  return "desktop";
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if ( !header ) return out;
  for ( const part of header.split(";") ) {
    const idx = part.indexOf("=");
    if ( idx < 0 ) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
