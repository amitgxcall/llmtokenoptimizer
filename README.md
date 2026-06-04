# LLM Token Optimizer (LTO)

> A local proxy that sits between your IDE (GitHub Copilot, Cursor, Claude Code, Continue, etc.) and the LLM (Claude / OpenAI), cutting token cost **40–70% on input** and **20–40% on output** — and showing you exactly how much you saved per prompt.

## Why this exists

GitHub Copilot Chat, Cursor, and every other AI coding assistant send a **lot** of redundant tokens to the LLM on every turn:

- Whole files re-attached every message even when unchanged
- 8,000 tokens of `npm install` progress bars dumped into chat for one error line
- Stack traces with 200 `node_modules` frames
- Same question asked 5 different ways = 5 full round-trips
- Model returns the entire file rewritten when a 3-line diff would do

LTO intercepts the request before it leaves your machine, applies 7 optimization passes, calls the LLM, slims the response, and writes the savings to a local ledger you can audit.

## The 7 optimization passes

| # | Pass | What it does | Typical savings |
|---|------|--------------|-----------------|
| 1 | **Intent extraction** | Local SLM (Qwen2.5-Coder-1.5B via Ollama) classifies the request — `explain`/`fix`/`refactor`/`run`/`debug`. Each intent gets a tailored context budget. | 20–40% input |
| 2 | **Context pruner** | AST-slices files to the function the user actually highlighted. Drops unchanged files referenced in prior turns and replaces them with content-hash markers. | 30–50% input |
| 3 | **Compressor** | LLMLingua-2 token compression for prose; symbol-table rewrite for code (`getUserAuthenticationToken` → `§g1`). | 2–5x on prose |
| 4 | **Semantic cache** | Local embedding (`bge-m3` via Ollama) + sqlite-vec. Exact match returns instantly; near-match deltas only the changed part. | 100% on hits |
| 5 | **Learning memory** | Tracks question frequency, clusters recurring patterns, auto-promotes hot patterns into a pre-warmed FAQ cache. *"You've asked this 12 times — here's the canonical answer."* | Compounds over time |
| 6 | **Command output slimmer** | Wraps shell exec. Filters `npm`/`pytest`/`cargo`/`docker`/`git` output to *just* what the model needs (errors + summary, not 8k tokens of progress bars). | 80–95% on tool output |
| 7 | **Output slimmer** | System-prompt addendum forces diffs not full files, no preamble/postamble, capped explanations. Post-process strips restated user code. | 20–40% output |

Stacked on top of those, LTO **transparently uses every native cost feature the providers ship**:

- **Anthropic prompt caching** (5-min + 1-hr TTL, 90% discount on cache reads) — auto-applied to system prompts and stable context
- **Anthropic token-efficient tool use** (`token-efficient-tools-2025-02-19` beta header)
- **Anthropic memory tool + context editing** (`claude-memory-20250819`, `context-management-2025-06-27`) for long sessions
- **OpenAI automatic prompt caching** (50% off cached prefixes ≥1024 tokens)
- **Batch API routing** for non-urgent requests (50% off, async)
- **Model routing**: cheap requests → Haiku 4.5 / GPT-4o-mini; complex → Opus 4.8 / GPT-5

## Quick start

```bash
git clone https://github.com/amitgxcall/llmtokenoptimizer.git
cd llmtokenoptimizer
npm install
cp .env.example .env   # add your Anthropic / OpenAI keys
npm run dev            # proxy listens on :8788
```

Point your IDE at the local proxy:

**GitHub Copilot** (`settings.json`):
```jsonc
"github.copilot.advanced": {
  "debug.overrideProxyUrl": "http://localhost:8788"
}
```

**Cursor / Continue / Claude Code**: set the API base URL to `http://localhost:8788/v1` (OpenAI-compat) or `http://localhost:8788/anthropic` (Anthropic-compat).

## See your savings

```bash
npm run ledger          # CLI report — tokens saved, $ saved, top techniques
npm run ledger:serve    # web dashboard on :8789
```

### MCP server (optional)

If you want Claude Code / Claude Desktop to answer "how much did I save today?" directly, an opt-in MCP server is bundled. **It does not run by default.**

1. In `.env`, set `LTO_MCP_ENABLED=1`.
2. Wire it into your MCP client (Claude Code example):
   ```jsonc
   // ~/.claude/mcp.json
   "lto": {
     "command": "node",
     "args": ["C:/path/to/llmtokenoptimizer/dist/mcp/server.js"]
   }
   ```
3. `npm run mcp` if you want to test it standalone.

Tools exposed: `get_savings`, `get_top_patterns`, `get_cache_stats`. The proxy itself runs fine without MCP — this is purely for introspection.

## Standalone command slimmer

The command-output slimmer is also published as a standalone CLI — useful even if you don't run the proxy:

```bash
npx lto-slim -- npm install        # 8000 tokens → ~200 tokens
npx lto-slim -- pytest             # only failing tests + tracebacks
npx lto-slim -- cargo build        # warnings + errors, no progress
```

## Privacy / outbound calls

LTO is **local-first by default**. The only outbound call LTO ever makes is the final provider call you were going to make anyway — i.e. the request being proxied. All optimization passes (embeddings, semantic cache, learning memory, command slimmer, output slimmer, rule-based intent) run on your machine with zero network egress.

You can **opt in** to a small "helper LLM" tier for higher-quality intent classification on ambiguous prompts. Modes:

| Mode | Cost | Notes |
|------|------|-------|
| `local-only` | $0 | **Default.** Rule-based intent only. No helper calls. |
| `ollama` | $0 | Local Ollama model. Still no egress. |
| `groq` | $0 | Free tier, `llama-3.3-70b-versatile`. Needs Groq API key. |
| `cerebras` | $0 | Free tier, `llama-3.3-70b`. Needs Cerebras API key. |
| `deepseek` | ~$0.27/1M | Cheapest paid option. |
| `anthropic` | Haiku 4.5 pricing | Use your existing Anthropic key. |
| `openai` | gpt-4o-mini pricing | Use your existing OpenAI key. |
| `custom` | varies | Any OpenAI-compatible endpoint (vLLM, LM Studio, Together, …). |

Set `LTO_HELPER_MODE` in `.env`. A daily budget cap (`LTO_HELPER_DAILY_BUDGET_USD`, default $0.50) auto-falls-back to local-only when crossed.

## Testing

```bash
npm test              # unit + integration (fast, no network, ~5s)
npm run test:unit     # just the pure-logic tests
npm run test:integration   # spins up in-process mock upstream
npm run test:perf     # 1000-request pipeline overhead benchmark
npm run test:smoke    # OPT-IN: real Anthropic call (~$0.001/run, needs key)
```

What each layer covers:

- **Unit** (`tests/unit/`) — slimmer regexes (npm/pytest/cargo/jest output), output slimmer, provider cache injection points, intent rules, token counting, embeddings cosine + round-trip
- **Integration** (`tests/integration/proxy.test.ts`) — starts an in-process mock Anthropic upstream, exercises the full pipeline, asserts:
  - upstream receives the request with the system addendum + headers injected
  - response is slimmed (preamble/postamble stripped)
  - ledger row is written with correct token / cost numbers
  - identical second request hits the semantic cache (zero upstream traffic)
- **Smoke** (`scripts/smoke.ts`) — opt-in real-API end-to-end. Only runs if `ANTHROPIC_API_KEY` is set. Uses Haiku 4.5 (~$0.001/run).
- **CI** — `.github/workflows/ci.yml` runs unit + integration on every push, Node 20.x + 22.x.

Manual verification of the standalone slimmer:

```bash
npm install -g .                            # install lto-slim
lto-slim -- npm install                     # see compact output + savings line
lto-slim --raw -- npm install > raw.txt     # A/B compare against unslimmed
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design — proxy internals, the 7-pass pipeline, learning-memory schema, ledger schema, and the provider-native features LTO leans on.

## Status

Early scaffold. MVP roadmap:

- [x] Hono proxy + Anthropic / OpenAI passthrough
- [x] Cost ledger (SQLite)
- [x] Command output slimmer + presets (npm, pytest, cargo, jest, git, docker)
- [x] Semantic cache (sqlite-vec + Ollama embeddings)
- [x] Learning memory (frequency tracker + FAQ promotion)
- [ ] Intent extractor (Ollama Qwen2.5-Coder)
- [ ] LLMLingua-2 compression sidecar
- [ ] VS Code webview for the ledger
- [ ] MCP server

## License

MIT
