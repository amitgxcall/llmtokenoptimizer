// Perf test — measure proxy overhead over a no-op mock upstream.
//
// Goal: confirm the pipeline (memory + semantic cache + cache_control inject
// + output slim + ledger write) adds < a few ms per request on a modern box.
//
// Strategy:
//   - 1000 UNIQUE prompts to stress the embed + cache write path
//   - mock upstream returns instantly
//   - report p50/p95/p99 + budget check

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDb = path.join(os.tmpdir(), `lto-perf-${Date.now()}.db`);
process.env.LTO_DB_PATH = tmpDb;
process.env.LTO_OLLAMA = "0";
process.env.LTO_HELPER_MODE = "local-only";
process.env.ANTHROPIC_API_KEY = "sk-test";

let upstream: http.Server;
before(async () => {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "m", type: "message", role: "assistant", model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "ok." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0 },
      }));
    });
  });
  await new Promise<void>(r => upstream.listen(0, "127.0.0.1", () => r()));
  const addr = upstream.address() as any;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>(r => upstream.close(() => r()));
  for (const f of [tmpDb, tmpDb + "-wal", tmpDb + "-shm"]) {
    try { fs.unlinkSync(f); } catch {}
  }
});

const N = Number(process.env.PERF_N ?? 1000);
const BUDGET_P50_MS = Number(process.env.PERF_BUDGET_P50_MS ?? 8);
const BUDGET_P99_MS = Number(process.env.PERF_BUDGET_P99_MS ?? 40);

test(`pipeline overhead under budget across ${N} unique requests`, async () => {
  const { anthropic } = await import("../../src/proxy/anthropic.js");

  const latencies: number[] = [];
  // Warmup
  for (let i = 0; i < 20; i++) {
    await anthropic.fetch(new Request("http://lto/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 8, messages: [{ role: "user", content: `warm ${i}` }] }),
    }));
  }

  for (let i = 0; i < N; i++) {
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8,
      messages: [{ role: "user", content: `perf-prompt-${i}-${Math.random().toString(36).slice(2)}` }],
    });
    const t0 = performance.now();
    const r = await anthropic.fetch(new Request("http://lto/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
    await r.json();
    latencies.push(performance.now() - t0);
  }

  latencies.sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]!;
  const p50 = pct(0.50);
  const p95 = pct(0.95);
  const p99 = pct(0.99);
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  console.log(`\n  perf: N=${N}  p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  p99=${p99.toFixed(2)}ms  mean=${mean.toFixed(2)}ms`);
  console.log(`  budget: p50<${BUDGET_P50_MS}ms p99<${BUDGET_P99_MS}ms`);

  assert.ok(p50 < BUDGET_P50_MS, `p50 ${p50.toFixed(2)}ms exceeded budget ${BUDGET_P50_MS}ms`);
  assert.ok(p99 < BUDGET_P99_MS, `p99 ${p99.toFixed(2)}ms exceeded budget ${BUDGET_P99_MS}ms`);
});

test("cache hit latency is dramatically lower than miss", async () => {
  const { anthropic } = await import("../../src/proxy/anthropic.js");

  const prompt = "repeat-this-question-for-cache-perf-" + Date.now();
  const body = JSON.stringify({
    model: "claude-sonnet-4-6", max_tokens: 8,
    messages: [{ role: "user", content: prompt }],
  });
  // Miss
  const t0 = performance.now();
  await (await anthropic.fetch(new Request("http://lto/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }))).json();
  const missMs = performance.now() - t0;

  // Hit
  const t1 = performance.now();
  const r2 = await anthropic.fetch(new Request("http://lto/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }));
  const data = await r2.json() as any;
  const hitMs = performance.now() - t1;

  console.log(`  cache miss=${missMs.toFixed(2)}ms  hit=${hitMs.toFixed(2)}ms  (${(missMs/hitMs).toFixed(1)}x faster)`);
  assert.equal(data.lto?.source, "cache");
  assert.ok(hitMs < missMs, "cache hit should be faster than miss");
});
