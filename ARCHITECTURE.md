# Architecture

```
┌──────────────────┐     ┌────────────────────────────────────────┐     ┌────────────┐
│  IDE / Client    │     │           LTO Proxy (:8788)            │     │  Provider  │
│                  │     │  ┌──────────────────────────────────┐  │     │            │
│  GHCP Chat       │────▶│  │  /v1/chat/completions (OpenAI)   │  │     │  Anthropic │
│  Cursor          │     │  │  /anthropic/v1/messages          │  │     │  OpenAI    │
│  Claude Code     │     │  └────────────────┬─────────────────┘  │────▶│            │
│  Continue        │◀────│                   ▼                    │◀────│            │
└──────────────────┘     │  ┌──────────────────────────────────┐  │     └────────────┘
                         │  │      Optimization Pipeline       │  │
                         │  │  1. Intent extractor (SLM)       │  │
                         │  │  2. Context pruner (AST)         │  │
                         │  │  3. Compressor (LLMLingua-2)     │  │
                         │  │  4. Semantic cache (sqlite-vec)  │  │
                         │  │  5. Learning memory (FAQ)        │  │
                         │  │  6. Cmd output slimmer           │  │
                         │  │  7. Output slimmer (post)        │  │
                         │  └──────────────────────────────────┘  │
                         │  ┌──────────────────────────────────┐  │
                         │  │  Cost ledger (SQLite)            │  │
                         │  │  MCP server (introspection)      │  │
                         │  │  Web dashboard (:8789)           │  │
                         │  └──────────────────────────────────┘  │
                         └────────────────────────────────────────┘
```

## Pipeline order matters

Cheapest checks first. Each pass can short-circuit downstream work.

```
Request
  │
  ▼
┌──────────────────────┐
│ Learning memory hit? │──── yes ───▶ return canonical answer (0 tokens out, 0 in)
└──────────┬───────────┘
           │ no
           ▼
┌──────────────────────┐
│ Semantic cache hit?  │──── yes ───▶ return cached / delta-prompt only changes
└──────────┬───────────┘
           │ no
           ▼
┌──────────────────────┐
│ Intent extract (SLM) │ adds ~50ms, saves later
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Prune context        │ AST-slice + drop unchanged files
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Compress             │ LLMLingua-2 + symbol table
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Inject prompt cache  │ Anthropic cache_control / OpenAI auto
│ + token-efficient    │
│   tool-use header    │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Provider call        │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Slim output          │ strip preamble, force diff format
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Write ledger row     │ raw vs optimized in/out, cost saved
│ Update memory stats  │ frequency, embedding, FAQ promotion
└──────────┬───────────┘
           ▼
        Response
```

## Provider-native features LTO leans on

These do nothing if you don't ask for them. LTO injects them automatically.

### Anthropic

| Feature | Header / Field | Discount | Notes |
|---------|----------------|----------|-------|
| Prompt caching (5min) | `cache_control: {"type": "ephemeral"}` | 90% off cache reads, 25% premium on writes | Auto-applied to system prompt + first 2 stable user blocks |
| Prompt caching (1hr) | `cache_control: {"type": "ephemeral", "ttl": "1h"}` | Same, longer window | Used when session activity suggests long horizon |
| Token-efficient tool use | beta header `token-efficient-tools-2025-02-19` | ~14% fewer tool tokens on Claude 3.7+ | Auto-on when request has tools |
| Memory tool | beta header `context-management-2025-06-27` | Lets model offload to file-based memory | Enabled for sessions > 50k tokens |
| Context editing | Auto context clearing | Drops stale tool results | Enabled for long sessions |
| Batch API | `/v1/messages/batches` | 50% off all tokens | Routed for non-urgent (no streaming requested, low priority intent) |

### OpenAI

| Feature | Mechanism | Discount |
|---------|-----------|----------|
| Automatic prompt caching | Prefix ≥1024 tokens auto-cached | 50% off cached prefix |
| Batch API | `/v1/batches` | 50% off |
| Structured outputs | `response_format: {type: "json_schema"}` | Fewer output tokens vs prose |
| Predicted outputs | `prediction` field for edit tasks | Faster + cheaper when much of output is known |

## The 7 optimization passes — detail

### 1. Intent extractor

Local SLM via Ollama (`qwen2.5-coder:1.5b`). Classifies request into one of:

```
explain | fix-error | refactor | generate-new | run-command | debug | answer-question
```

Each intent has a **context budget** (max tokens) and a **required-context spec** (what files / symbols matter). `explain a function` doesn't need the rest of the repo. `refactor across files` does.

Falls back to rule-based classifier if Ollama unavailable.

### 2. Context pruner

- **AST-slice**: tree-sitter grammars per language. If user cursor is on a function, include the function + signatures (not bodies) of called functions + types referenced. Drop the rest.
- **Diff-aware re-send**: hash each file. If unchanged since previous turn in this session, replace body with `[file:src/x.ts@a3f2 unchanged]`. Provider has it cached anyway.
- **Conversation pruning**: drop turns older than N where the resulting state is already in current files.
- **Import / comment stripping** (optional, intent-gated — skipped for `explain`).

### 3. Compressor

- **LLMLingua-2**: Microsoft's task-agnostic prompt compressor. ~2–5x compression at <5% quality loss. Runs as Python sidecar (`uvx llmlingua`) or skipped if unavailable.
- **Symbol table**: long repeated identifiers → short tokens with a legend. Model handles it; expand on output.
- **Log dedup**: collapse `(error repeated 47 times)` patterns.

### 4. Semantic cache

- Embed each prompt with `bge-m3` via Ollama (multilingual, 1024-dim, SOTA retrieval as of 2025).
- Store in **sqlite-vec** (no separate vector DB — same SQLite as the ledger).
- Exact text match → instant return.
- Cosine similarity ≥ 0.97 → return cached response.
- Cosine 0.85–0.97 → "delta prompt": send only the diff between cached prompt and new prompt, plus a system instruction to amend the cached answer.

### 5. Learning memory

The compounding-savings layer.

**Schema:**

```sql
CREATE TABLE memory_patterns (
  id INTEGER PRIMARY KEY,
  pattern_hash TEXT UNIQUE,         -- normalized question signature
  embedding BLOB,                   -- bge-m3 vector
  canonical_question TEXT,
  canonical_answer TEXT,
  hit_count INTEGER DEFAULT 1,
  last_seen INTEGER,
  promoted_to_faq INTEGER DEFAULT 0,
  user_confirmed INTEGER DEFAULT 0,
  tokens_saved_total INTEGER DEFAULT 0
);

CREATE TABLE memory_clusters (
  id INTEGER PRIMARY KEY,
  centroid BLOB,
  pattern_count INTEGER,
  topic_label TEXT                  -- auto-derived: "how to fix TS2345"
);
```

**Promotion rules:**

- A pattern with `hit_count ≥ 3` and stable answer (same pattern → same response twice) → auto-promoted to FAQ cache. Subsequent matches return canonical answer with 0 LLM tokens.
- User can confirm or reject in the dashboard. Confirmed patterns are permanent; rejected ones are blacklisted from auto-promotion but still tracked.
- Clusters form via online k-means on embeddings. A cluster reaching 10+ members surfaces a "you frequently ask about X" insight.

**Decay:** patterns not seen in 90 days lose `hit_count * 0.5` weekly. Keeps memory current.

### 6. Command output slimmer

Wraps `child_process.exec` (or via shell shim). Routes raw output through a preset extractor before it reaches the LLM.

**Preset format** (`presets/npm.yaml`):

```yaml
name: npm
match: ["npm install", "npm i", "npm ci"]
strategy: tail-and-errors
keep:
  - regex: "^npm (ERR!|WARN)"
  - regex: "^added \\d+ packages"
  - regex: "^\\d+ vulnerabilities"
drop:
  - regex: "^npm http"
  - regex: "^\\s*\\d+/\\d+ "        # progress
  - ansi: true
collapse:
  - pattern: "node_modules/.*deprecated"
    as: "(N deprecation warnings collapsed)"
```

Built-in presets at MVP: `npm`, `pnpm`, `yarn`, `pytest`, `jest`, `cargo`, `go-test`, `docker-build`, `git`, `tsc`. Users can drop their own YAML into `~/.lto/presets/`.

**Standalone CLI** (`npx lto-slim -- <command>`): pipes stdout/stderr through the matching preset and prints the slim version. Useful even outside the proxy.

### 7. Output slimmer

- System-prompt addendum forces:
  - Unified diff format for edits, not full file rewrites
  - No preamble ("Sure! Here's…") or postamble ("Let me know if…")
  - Code blocks only when adding/changing code
  - Plain prose for `explain` intent, capped by intent budget
- Post-process strips:
  - Restated user code (model sometimes echoes the input)
  - Markdown headers in single-question answers
  - Trailing "Hope this helps!" patterns

## Cost ledger

```sql
CREATE TABLE prompts (
  id TEXT PRIMARY KEY,                -- ulid
  ts INTEGER,
  client TEXT,                        -- "ghcp" / "cursor" / "claude-code"
  provider TEXT,                      -- "anthropic" / "openai"
  model TEXT,
  intent TEXT,
  tokens_in_raw INTEGER,
  tokens_in_sent INTEGER,             -- after pipeline
  tokens_in_cached INTEGER,           -- of sent, how many hit provider cache
  tokens_out_raw INTEGER,             -- model's first draft
  tokens_out_returned INTEGER,        -- after output slimmer
  cache_hit_type TEXT,                -- null / exact / semantic / memory
  latency_ms INTEGER,
  cost_usd_raw REAL,                  -- what it would have cost untouched
  cost_usd_actual REAL,
  cost_usd_saved REAL,
  techniques_json TEXT                -- which passes contributed how much
);

CREATE TABLE daily_rollup (
  date TEXT PRIMARY KEY,
  prompts INTEGER,
  tokens_saved INTEGER,
  cost_saved_usd REAL,
  cache_hit_rate REAL
);
```

Daily rollup runs at 00:05 local time. Old prompt rows older than 90 days are pruned.

## MCP server

Exposes introspection to any MCP client (Claude Code, Claude Desktop):

| Tool | Returns |
|------|---------|
| `get_savings` | Total tokens / $ saved, broken down by day / model / technique |
| `get_top_patterns` | Most-asked question patterns (from learning memory) |
| `get_cache_stats` | Hit rates: exact / semantic / memory / provider-native |
| `get_command_savings` | Per-command slimmer impact (npm vs pytest vs …) |
| `replay` | Replay a prompt with optimizations off to measure true delta |

## Why Hono + better-sqlite3 + Ollama

- **Hono**: fastest TS web framework as of 2025, edge-portable (Cloudflare Workers / Bun / Node), tiny footprint
- **better-sqlite3**: synchronous, faster than `sqlite3` for the access patterns here (lots of small writes), works perfectly with `sqlite-vec` extension
- **sqlite-vec**: official SQLite vector search extension (replaces FAISS / Qdrant for this scale)
- **Ollama**: local model runner. `qwen2.5-coder:1.5b` for intent (200ms p50), `bge-m3` for embeddings. Zero external dependency, zero per-call cost
- **No vector DB / no Redis / no Postgres**: one SQLite file. Backup = `cp lto.db ~/backup`.

## Privacy model

LTO has exactly one outbound call path by default: the proxied request → your chosen provider. That's the same call your IDE would have made without LTO. Every optimization pass runs locally:

- Rule-based intent classification (regex)
- Embeddings via local Ollama, with a deterministic hash-bag fallback when Ollama isn't available
- Semantic cache + learning memory in local SQLite
- Command slimmer is pure regex / preset rules
- Output slimmer is pure regex
- Provider-native cache markers and beta headers are injected client-side (no extra calls)

The **helper LLM tier** is opt-in. Modes range from `local-only` (default — zero outbound helper traffic) → `ollama` (local) → free-tier remotes (Groq, Cerebras) → cheap paid (DeepSeek / Haiku / gpt-4o-mini) → any custom OpenAI-compatible endpoint.

Helper spend is capped by `LTO_HELPER_DAILY_BUDGET_USD`. When the cap is reached LTO silently reverts to local-only for the rest of the day — the proxy keeps working, intent just falls back to rules.

Privacy-wise, the helper sees the same prompt the main provider would have seen. Net data exposure ≤ not running LTO at all.

## What's deliberately *not* included

- **No telemetry**. Everything runs local. Ledger never leaves the machine unless you export.
- **No model fine-tuning**. The learning memory is k-means + frequency, not gradient updates. Predictable, debuggable.
- **No request modification without logging**. Every pipeline pass writes its delta to the ledger so you can audit exactly what was sent vs typed.
