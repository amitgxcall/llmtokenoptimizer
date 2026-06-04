import { ulid } from "ulid";
import { getDb } from "./db.js";

export interface PromptRecord {
  client?: string;
  provider: "anthropic" | "openai";
  model: string;
  intent?: string;
  tokensInRaw: number;
  tokensInSent: number;
  tokensInCached?: number;
  tokensOutRaw: number;
  tokensOutReturned: number;
  cacheHitType?: "exact" | "semantic" | "memory" | null;
  latencyMs: number;
  techniques?: Record<string, { tokensSaved: number; notes?: string }>;
}

// Pricing per 1M tokens (USD). Update as providers change pricing.
const PRICING: Record<string, { in: number; out: number; cachedIn?: number }> = {
  "claude-opus-4-7":      { in: 15.0,  out: 75.0,  cachedIn: 1.5 },
  "claude-opus-4-8":      { in: 15.0,  out: 75.0,  cachedIn: 1.5 },
  "claude-sonnet-4-6":    { in: 3.0,   out: 15.0,  cachedIn: 0.3 },
  "claude-haiku-4-5-20251001": { in: 0.8, out: 4.0, cachedIn: 0.08 },
  "gpt-4o":               { in: 2.5,   out: 10.0,  cachedIn: 1.25 },
  "gpt-4o-mini":          { in: 0.15,  out: 0.6,   cachedIn: 0.075 },
  "gpt-5":                { in: 5.0,   out: 20.0,  cachedIn: 2.5 },
};

function pricing(model: string) {
  return PRICING[model] ?? PRICING["claude-sonnet-4-6"]!;
}

export function costFor(model: string, inTokens: number, outTokens: number, cachedIn = 0): number {
  const p = pricing(model);
  const freshIn = Math.max(0, inTokens - cachedIn);
  return (freshIn * p.in + cachedIn * (p.cachedIn ?? p.in) + outTokens * p.out) / 1_000_000;
}

export function record(r: PromptRecord): string {
  const id = ulid();
  const costRaw    = costFor(r.model, r.tokensInRaw,  r.tokensOutRaw, 0);
  const costActual = costFor(r.model, r.tokensInSent, r.tokensOutReturned, r.tokensInCached ?? 0);
  const saved      = costRaw - costActual;

  getDb()
    .prepare(`INSERT INTO prompts
      (id, ts, client, provider, model, intent,
       tokens_in_raw, tokens_in_sent, tokens_in_cached,
       tokens_out_raw, tokens_out_returned,
       cache_hit_type, latency_ms,
       cost_usd_raw, cost_usd_actual, cost_usd_saved, techniques_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      id, Date.now(), r.client ?? null, r.provider, r.model, r.intent ?? null,
      r.tokensInRaw, r.tokensInSent, r.tokensInCached ?? 0,
      r.tokensOutRaw, r.tokensOutReturned,
      r.cacheHitType ?? null, r.latencyMs,
      costRaw, costActual, saved,
      JSON.stringify(r.techniques ?? {}),
    );
  return id;
}

export function summary(sinceDays = 7) {
  const since = Date.now() - sinceDays * 86_400_000;
  const row = getDb().prepare(`
    SELECT COUNT(*) AS prompts,
           SUM(tokens_in_raw - tokens_in_sent) AS tokens_saved_in,
           SUM(tokens_out_raw - tokens_out_returned) AS tokens_saved_out,
           SUM(cost_usd_saved) AS cost_saved,
           SUM(cost_usd_raw)   AS cost_raw,
           SUM(CASE WHEN cache_hit_type IS NOT NULL THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*),0) AS cache_hit_rate
    FROM prompts WHERE ts >= ?`).get(since) as any;
  return {
    prompts: row.prompts ?? 0,
    tokensSavedIn: row.tokens_saved_in ?? 0,
    tokensSavedOut: row.tokens_saved_out ?? 0,
    costSavedUsd: row.cost_saved ?? 0,
    costRawUsd: row.cost_raw ?? 0,
    cacheHitRate: row.cache_hit_rate ?? 0,
    savingsPct: row.cost_raw ? (row.cost_saved / row.cost_raw) * 100 : 0,
  };
}
