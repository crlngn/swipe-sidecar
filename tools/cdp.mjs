#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol client for driving a page on an adb-forwarded Android Chrome.
 *
 *   node tools/cdp.mjs <targetId> eval '<expression>'          evaluate (awaits promises), prints JSON
 *   node tools/cdp.mjs <targetId> touch <json-steps>            dispatch touch events, e.g.
 *       '[{"type":"touchStart","points":[{"x":100,"y":200}]},{"wait":700},{"type":"touchEnd","points":[]}]'
 *   node tools/cdp.mjs <targetId> console <seconds>             collect console messages for N seconds
 *
 * Requires: adb forward tcp:9222 localabstract:chrome_devtools_remote
 */
const [targetId, command, ...rest] = process.argv.slice(2);
if ( !targetId || !command ) {
  console.error("usage: cdp.mjs <targetId> eval|touch|console ...");
  process.exit(1);
}

const ws = new WebSocket(`ws://localhost:9222/devtools/page/${targetId}`);
let nextId = 1;
const pending = new Map();
const events = [];

ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if ( message.id && pending.has(message.id) ) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  }
  else if ( message.method ) events.push(message);
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable");
    if ( command === "eval" ) {
      // The code is an async function body: `await` works, `const` names do not leak between calls,
      // and the value comes from `return`. A bare expression with no `return` is returned as-is.
      let body = rest.join(" ").trim();
      if ( !/\breturn\b/.test(body) && !body.includes(";") ) body = `return (${body});`;
      const result = await send("Runtime.evaluate", {
        expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true
      });
      if ( result.exceptionDetails ) console.error("Exception:", result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      else console.log(JSON.stringify(result.result.value, null, 2));
    }
    else if ( command === "touch" ) {
      const steps = JSON.parse(rest.join(" "));
      for ( const step of steps ) {
        if ( step.wait ) { await sleep(step.wait); continue; }
        await send("Input.dispatchTouchEvent", { type: step.type, touchPoints: step.points });
      }
      console.log("touch sequence done");
    }
    else if ( command === "nav" ) {
      await send("Page.enable");
      await send("Page.navigate", { url: rest[0] });
      console.log(`navigating to ${rest[0]}`);
    }
    else if ( command === "shot" ) {
      const { writeFileSync } = await import("node:fs");
      const file = rest[0] ?? "phone.png";
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`saved ${file}`);
    }
    else if ( command === "console" ) {
      await send("Log.enable");
      await sleep(Number(rest[0] ?? 3) * 1000);
      for ( const event of events ) {
        if ( event.method === "Runtime.consoleAPICalled" ) {
          console.log(`[${event.params.type}]`, event.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 300));
        }
        else if ( event.method === "Runtime.exceptionThrown" ) {
          console.log("[exception]", event.params.exceptionDetails.exception?.description?.slice(0, 300));
        }
        else if ( event.method === "Log.entryAdded" ) {
          console.log(`[log:${event.params.entry.level}]`, event.params.entry.text.slice(0, 300));
        }
      }
    }
  } catch(err) {
    console.error("CDP error:", err.message);
  } finally {
    ws.close();
  }
});

ws.addEventListener("error", err => { console.error("WebSocket error", err.message ?? err); process.exit(1); });
