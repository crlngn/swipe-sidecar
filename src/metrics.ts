import fs from "node:fs";
import path from "node:path";
import type http from "node:http";

/**
 * Load-diagnostics store. Each client posts a few beacons per page load (see client/runtime/diagnostics.js);
 * beacons sharing a runId are merged into one run. Runs are kept in memory and appended to a JSONL file so
 * they survive a restart; the newest MAX_RUNS are served to the report page.
 */
const MAX_RUNS = 300;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface Run {
  runId: string;
  firstSeen: number;
  lastSeen: number;
  profile: string | null;
  ip: string | null;
  phases: string[];
  [key: string]: unknown;
}

export class MetricsStore {
  #file: string;
  #runs = new Map<string, Run>();

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.#file = path.join(dataDir, "metrics.jsonl");
    this.#load();
  }

  #load(): void {
    if ( !fs.existsSync(this.#file) ) return;
    const lines = fs.readFileSync(this.#file, "utf8").split("\n").filter(Boolean);
    for ( const line of lines ) {
      try { this.#merge(JSON.parse(line), null, null, false); } catch {}
    }
    this.#trim();
  }

  #trim(): void {
    while ( this.#runs.size > MAX_RUNS ) {
      const oldest = this.#runs.keys().next().value;
      if ( oldest === undefined ) break;
      this.#runs.delete(oldest);
    }
  }

  #merge(beacon: any, profile: string | null, ip: string | null, persist: boolean): Run | null {
    if ( !beacon || typeof beacon.runId !== "string" || typeof beacon.phase !== "string" ) return null;
    const now = Number(beacon.at) || Date.now();
    let run = this.#runs.get(beacon.runId);
    if ( !run && beacon.phase === "unloaded" ) return null;  // an exit for a run never recorded
    if ( !run ) {
      run = { runId: beacon.runId, firstSeen: now, lastSeen: now, profile, ip, phases: [] };
      this.#runs.set(beacon.runId, run);
    }
    run.lastSeen = Math.max(run.lastSeen, now);
    if ( profile ) run.profile = profile;
    if ( !run.phases.includes(beacon.phase) ) run.phases.push(beacon.phase);
    const { runId, phase, at, ...rest } = beacon;
    for ( const [key, value] of Object.entries(rest) ) {
      if ( key === "timings" || key === "heap" ) {
        run[key] = { ...(run[key] as object ?? {}), ...(value as object) };
        if ( key === "heap" ) (run as any).heapByPhase = { ...((run as any).heapByPhase ?? {}), [phase]: value };
      }
      else if ( key === "resources" ) run.resources = value;  // latest snapshot wins; it is cumulative
      else run[key] = value;
    }
    if ( persist ) fs.appendFile(this.#file, JSON.stringify(beacon) + "\n", () => {});
    this.#trim();
    return run;
  }

  ingest(beacon: unknown, profile: string | null, ip: string | null): Run | null {
    return this.#merge(beacon, profile, ip, true);
  }

  list(): Run[] {
    return [...this.#runs.values()].sort((a, b) => b.firstSeen - a.firstSeen);
  }

  get(runId: string): Run | undefined {
    return this.#runs.get(runId);
  }
}

/** Read a JSON request body with a size cap. */
export function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if ( size > MAX_BODY_BYTES ) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch(err) { reject(err); }
    });
    req.on("error", reject);
  });
}
