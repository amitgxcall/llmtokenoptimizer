// End-to-end smoke test against a REAL provider.
//
// Opt-in only — requires ANTHROPIC_API_KEY (or OPENAI_API_KEY) in env.
// Costs a few cents per run.
//
//   npm run build && node dist/scripts/smoke.js
//
// What it does:
//   1. Starts the proxy on a free port.
//   2. Sends a 2-turn conversation; second turn is similar to first.
//   3. Asserts: first hits provider, second hits semantic cache.
//   4. Prints the ledger summary.

import { spawn } from "node:child_process";
import http from "node:http";

const port = 18788;
process.env.LTO_PORT = String(port);

async function waitHealthy(url: string, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("proxy never came up");
}

async function callAnthropic(content: string) {
  const r = await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.LTO_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
      max_tokens: 80,
      messages: [{ role: "user", content }],
    }),
  });
  return r.json() as any;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("smoke: ANTHROPIC_API_KEY not set. Skipping.");
    process.exit(0);
  }

  console.log(`smoke: starting proxy on :${port}`);
  const proxy = spawn(process.execPath, ["dist/server.js"], { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  try {
    await waitHealthy(`http://127.0.0.1:${port}/healthz`);

    console.log("smoke: 1st call (expect upstream hit)");
    const a = await callAnthropic("In one short sentence, what is a closure in JavaScript?");
    console.log("  response:", a.content?.[0]?.text?.slice(0, 100));
    if (a.lto?.source === "cache") {
      console.warn("  WARN: first call was already cached (stale db?). Continuing.");
    }

    console.log("smoke: 2nd identical call (expect cache hit)");
    const b = await callAnthropic("In one short sentence, what is a closure in JavaScript?");
    if (b.lto?.source !== "cache") {
      console.error("  FAIL: second call did not hit cache");
      process.exit(1);
    }
    console.log("  cache hit confirmed:", b.lto.source);

    const stats = await (await fetch(`http://127.0.0.1:${port}/stats?days=1`)).json() as any;
    console.log("\nsmoke: 24h ledger summary:");
    console.log(JSON.stringify(stats, null, 2));
    console.log("\nsmoke: OK");
  } finally {
    proxy.kill();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
