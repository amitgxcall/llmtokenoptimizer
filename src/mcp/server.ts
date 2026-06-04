// MCP server — OPT-IN.
//
// Run with:  npm run mcp
// Gated on:  LTO_MCP_ENABLED=1 in .env
//
// Exposes introspection tools to any MCP client (Claude Code, Claude Desktop):
//   get_savings        — tokens + $ saved over N days, with technique breakdown
//   get_top_patterns   — most-asked questions from learning memory
//   get_cache_stats    — hit rates per layer
//
// Implementation note: this is a minimal stdio MCP server using the bare JSON-RPC
// 2.0 wire format. Drop in @modelcontextprotocol/sdk later if you want streaming /
// resources / prompts. The stub keeps the scaffold dependency-free.

import { config } from "../config.js";
import { summary } from "../ledger/tracker.js";
import { topPatterns } from "../optimizers/memory.js";
import { getDb } from "../ledger/db.js";

if (!config.mcp.enabled) {
  console.error("[lto-mcp] LTO_MCP_ENABLED is not 1. Set it in .env to enable. Exiting.");
  process.exit(0);
}

const TOOLS = [
  { name: "get_savings",      description: "Tokens + $ saved over the last N days, with technique attribution.",
    inputSchema: { type: "object", properties: { days: { type: "number", default: 7 } } } },
  { name: "get_top_patterns", description: "Most-frequently-asked question patterns from learning memory.",
    inputSchema: { type: "object", properties: { limit: { type: "number", default: 20 } } } },
  { name: "get_cache_stats",  description: "Cache hit rates by layer (memory / semantic / provider-native).",
    inputSchema: { type: "object", properties: {} } },
];

function handle(req: any): any {
  if (req.method === "initialize") {
    return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "lto", version: "0.1.0" } };
  }
  if (req.method === "tools/list") return { tools: TOOLS };
  if (req.method === "tools/call") {
    const { name, arguments: args = {} } = req.params ?? {};
    if (name === "get_savings") return { content: [{ type: "text", text: JSON.stringify(summary(args.days ?? 7), null, 2) }] };
    if (name === "get_top_patterns") return { content: [{ type: "text", text: JSON.stringify(topPatterns(args.limit ?? 20), null, 2) }] };
    if (name === "get_cache_stats") {
      const row = getDb().prepare(`
        SELECT
          SUM(CASE WHEN cache_hit_type='memory' THEN 1 ELSE 0 END) AS memory_hits,
          SUM(CASE WHEN cache_hit_type='semantic' THEN 1 ELSE 0 END) AS semantic_hits,
          SUM(CASE WHEN cache_hit_type='exact' THEN 1 ELSE 0 END) AS provider_hits,
          COUNT(*) AS total
        FROM prompts WHERE ts >= ?`).get(Date.now() - 7 * 86_400_000);
      return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
    }
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
  return null;
}

if (config.mcp.transport === "stdio") {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const req = JSON.parse(line);
        const result = handle(req);
        if (req.id != null) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
      } catch (e) { /* ignore parse errors */ }
    }
  });
  console.error("[lto-mcp] stdio ready");
} else {
  // HTTP transport stub
  const { serve } = await import("@hono/node-server");
  const { Hono } = await import("hono");
  const app = new Hono();
  app.post("/", async (c) => {
    const req = await c.req.json();
    return c.json({ jsonrpc: "2.0", id: req.id, result: handle(req) });
  });
  serve({ fetch: app.fetch, port: config.mcp.httpPort });
  console.error(`[lto-mcp] http on :${config.mcp.httpPort}`);
}
