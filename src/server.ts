import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { anthropic } from "./proxy/anthropic.js";
import { openai } from "./proxy/openai.js";
import { getDb } from "./ledger/db.js";
import { summary } from "./ledger/tracker.js";
import { topPatterns, decay } from "./optimizers/memory.js";
import { config } from "./config.js";

const app = new Hono();

app.get("/", (c) => c.json({
  service: "llm-token-optimizer",
  version: "0.1.0",
  endpoints: {
    anthropic: "/anthropic/v1/messages",
    openai: "/v1/chat/completions",
    stats: "/stats",
    patterns: "/patterns",
  },
}));

app.get("/stats", (c) => c.json(summary(Number(c.req.query("days") ?? 7))));
app.get("/patterns", (c) => c.json(topPatterns(Number(c.req.query("limit") ?? 20))));
app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/anthropic", anthropic);
app.route("/", openai);

getDb(); // ensure schema exists
setInterval(decay, 24 * 60 * 60 * 1000).unref(); // daily memory decay

serve({ fetch: app.fetch, port: config.port }, info => {
  console.log(`LTO proxy on http://localhost:${info.port}`);
  console.log(`  POST /anthropic/v1/messages   (Anthropic-compatible)`);
  console.log(`  POST /v1/chat/completions     (OpenAI-compatible)`);
  console.log(`  GET  /stats?days=7`);
  console.log(`  GET  /patterns?limit=20`);
});
