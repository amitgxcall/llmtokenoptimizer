// Integration test: spin up an in-process mock Anthropic upstream, point the
// LTO proxy at it, send a real-shaped request, assert that:
//   1. the upstream received headers + body the proxy was supposed to inject
//   2. the response made it back to the caller
//   3. a ledger row was written with sensible numbers
//   4. a second identical request hits the semantic cache (0 upstream calls)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Route DB + config to a temp file BEFORE importing the app
const tmpDb = path.join(os.tmpdir(), `lto-test-${Date.now()}.db`);
process.env.LTO_DB_PATH = tmpDb;
process.env.LTO_PORT = "0"; // we won't bind the real server; we call app.fetch directly
process.env.LTO_OLLAMA = "0"; // force fallback embeddings (no network)
process.env.LTO_HELPER_MODE = "local-only";
process.env.ANTHROPIC_API_KEY = "sk-test";
process.env.OPENAI_API_KEY = "sk-test";

// Mock upstream Anthropic
let upstreamRequests: Array<{ headers: any; body: any }> = [];
let upstream: http.Server;
let upstreamUrl: string;

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      upstreamRequests.push({ headers: req.headers, body: JSON.parse(body) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Sure! Here's your answer: 42.\n\nHope this helps!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
      }));
    });
  });
  await new Promise<void>(r => upstream.listen(0, "127.0.0.1", () => r()));
  const addr = upstream.address() as any;
  upstreamUrl = `http://127.0.0.1:${addr.port}`;
  process.env.ANTHROPIC_BASE_URL = upstreamUrl;
});

after(async () => {
  await new Promise<void>(r => upstream.close(() => r()));
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + "-wal"); } catch {}
  try { fs.unlinkSync(tmpDb + "-shm"); } catch {}
});

test("proxy forwards request and slims the response", async () => {
  // Lazy import after env vars are set
  const { anthropic } = await import("../../src/proxy/anthropic.js");
  const { getDb } = await import("../../src/ledger/db.js");

  const req = new Request("http://lto/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "what is the meaning of life" }],
    }),
  });
  const res = await anthropic.fetch(req);
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;

  // 1. Upstream actually got the call
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0]!.headers["x-api-key"], "sk-test");

  // 2. System addendum was injected (output-slim instruction)
  const sentBody = upstreamRequests[0]!.body;
  assert.ok(typeof sentBody.system === "string" && /no preamble/i.test(sentBody.system));

  // 3. Response slimmer stripped "Sure!" + "Hope this helps!"
  const text = data.content.find((b: any) => b.type === "text").text;
  assert.ok(!/^Sure!/.test(text), `expected no preamble, got: ${text}`);
  assert.ok(!/hope this helps/i.test(text));
  assert.ok(text.includes("42"));

  // 4. Ledger row written
  const row = getDb().prepare(`SELECT * FROM prompts ORDER BY ts DESC LIMIT 1`).get() as any;
  assert.equal(row.provider, "anthropic");
  assert.equal(row.tokens_in_raw > 0, true);
  assert.equal(row.tokens_out_raw, 20);
  // output slimmer trimmed something
  assert.ok(row.tokens_out_returned <= row.tokens_out_raw);
});

test("identical second request hits semantic cache (no upstream call)", async () => {
  const { anthropic } = await import("../../src/proxy/anthropic.js");
  upstreamRequests = []; // reset

  const reqA = new Request("http://lto/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "cache target question that is unique to this test" }],
    }),
  });
  const r1 = await anthropic.fetch(reqA);
  assert.equal(r1.status, 200);
  await r1.json();
  assert.equal(upstreamRequests.length, 1, "first call should hit upstream");

  // Identical request
  const reqB = new Request("http://lto/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "cache target question that is unique to this test" }],
    }),
  });
  const r2 = await anthropic.fetch(reqB);
  assert.equal(r2.status, 200);
  const data = (await r2.json()) as any;

  assert.equal(upstreamRequests.length, 1, "second call should be served from cache, no upstream hit");
  assert.equal(data.lto?.source, "cache");
});

test("ledger summary reflects savings", async () => {
  const { summary } = await import("../../src/ledger/tracker.js");
  const s = summary(1);
  assert.ok(s.prompts >= 2);
  assert.ok(s.costRawUsd > 0);
  assert.ok(s.cacheHitRate > 0, "cache hit rate should be > 0 after second request");
});
