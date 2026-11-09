#!/usr/bin/env node
import { loadConfig, readFoundryBuild } from "./config.ts";
import { SidecarProxy } from "./proxy.ts";

const config = loadConfig();
const proxy = new SidecarProxy(config);
await proxy.listen();

const build = readFoundryBuild(config);
console.log(`[swipe-sidecar] listening on ${proxy.address}`);
console.log(`[swipe-sidecar] upstream ${config.upstream.url}` + (build ? ` (Foundry build ${build})` : ""));
console.log(`[swipe-sidecar] features ${JSON.stringify(config.features)}`);
console.log(`[swipe-sidecar] diagnostics at ${proxy.address}/swipe-sidecar/report; data in ${config.dataDir}`);
if ( (config as any).tokenGenerated ) console.log(`[swipe-sidecar] API token: ${config.api.token}  (saved in your config as api.token; send it as "Authorization: Bearer <token>" to the /swipe-sidecar/api endpoints)`);
