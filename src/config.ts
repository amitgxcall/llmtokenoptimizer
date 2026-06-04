import path from "node:path";
import os from "node:os";

export const config = {
  port: Number(process.env.LTO_PORT ?? 8788),
  dashboardPort: Number(process.env.LTO_DASHBOARD_PORT ?? 8789),
  dbPath: process.env.LTO_DB_PATH ?? path.join(os.homedir(), ".lto", "lto.db"),
  presetsDir: process.env.LTO_PRESETS_DIR ?? path.join(os.homedir(), ".lto", "presets"),
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    defaultModel: process.env.LTO_ANTHROPIC_MODEL ?? "claude-opus-4-7",
    cheapModel: process.env.LTO_ANTHROPIC_CHEAP_MODEL ?? "claude-haiku-4-5-20251001",
    enablePromptCaching: process.env.LTO_PROMPT_CACHING !== "0",
    enableTokenEfficientTools: process.env.LTO_TOKEN_EFFICIENT_TOOLS !== "0",
    enableMemoryTool: process.env.LTO_MEMORY_TOOL === "1",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
    defaultModel: process.env.LTO_OPENAI_MODEL ?? "gpt-4o",
    cheapModel: process.env.LTO_OPENAI_CHEAP_MODEL ?? "gpt-4o-mini",
  },
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    intentModel: process.env.LTO_INTENT_MODEL ?? "qwen2.5-coder:1.5b",
    embedModel: process.env.LTO_EMBED_MODEL ?? "bge-m3",
    enabled: process.env.LTO_OLLAMA !== "0",
  },

  // --- Helper LLM tier (intent classification / compression assistance) ---
  // Default: "local-only" — NOTHING leaves your machine for optimization work.
  // The only outbound call LTO ever makes is the final provider call you
  // were going to make anyway (i.e. the request being proxied).
  //
  // If you opt in to a helper, LTO uses a small/cheap/free model for intent
  // classification — purely additive savings, no privacy regression vs not
  // running LTO at all (the helper sees the same prompt the main provider would).
  helper: {
    // local-only | ollama | groq | cerebras | deepseek | anthropic | openai | custom
    mode: (process.env.LTO_HELPER_MODE ?? "local-only") as
      "local-only" | "ollama" | "groq" | "cerebras" | "deepseek" | "anthropic" | "openai" | "custom",
    baseUrl: process.env.LTO_HELPER_BASE_URL ?? "",   // for "custom"
    apiKey:  process.env.LTO_HELPER_API_KEY  ?? "",
    model:   process.env.LTO_HELPER_MODEL    ?? "",   // overrides per-mode default
    // Hard cap on helper spend per day, USD. Crosses → fall back to local-only.
    dailyBudgetUsd: Number(process.env.LTO_HELPER_DAILY_BUDGET_USD ?? 0.50),
  },
  cache: {
    exactMatchEnabled: true,
    semanticThreshold: 0.97,
    deltaThreshold: 0.85,
  },
  memory: {
    faqPromotionHits: 3,
    decayDays: 90,
  },

  // --- MCP server (OPT-IN, default off) ---
  // Exposes ledger / pattern introspection to Claude Code / Claude Desktop.
  // Run separately with `npm run mcp`. Does nothing unless enabled here AND
  // wired into the MCP client's config.
  mcp: {
    enabled: process.env.LTO_MCP_ENABLED === "1",
    transport: (process.env.LTO_MCP_TRANSPORT ?? "stdio") as "stdio" | "http",
    httpPort: Number(process.env.LTO_MCP_HTTP_PORT ?? 8790),
  },
} as const;

export type Config = typeof config;
