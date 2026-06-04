import crypto from "node:crypto";
import { getDb } from "../ledger/db.js";
import { config } from "../config.js";
import { bufToVec, cosineSim, embed, vecToBuf } from "./embeddings.js";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export interface SemanticHit {
  response: string;
  tokensIn: number;
  tokensOut: number;
  similarity: number;
}

export async function lookupSemantic(prompt: string): Promise<SemanticHit | null> {
  if (!prompt) return null;
  const db = getDb();
  const hash = sha(prompt);

  // Exact match — instant
  const exact = db.prepare(`SELECT response_text, tokens_in, tokens_out FROM semantic_cache WHERE prompt_hash = ?`).get(hash) as any;
  if (exact) {
    db.prepare(`UPDATE semantic_cache SET hits = hits + 1, last_hit = ? WHERE prompt_hash = ?`).run(Date.now(), hash);
    return { response: exact.response_text, tokensIn: exact.tokens_in, tokensOut: exact.tokens_out, similarity: 1 };
  }

  // Semantic match — scan recent rows (good enough up to ~10k entries; swap for sqlite-vec at scale)
  const vec = await embed(prompt);
  const rows = db.prepare(`SELECT id, response_text, tokens_in, tokens_out, embedding FROM semantic_cache ORDER BY last_hit DESC LIMIT 500`).all() as any[];

  let best: { row: any; sim: number } | null = null;
  for (const r of rows) {
    if (!r.embedding) continue;
    const sim = cosineSim(vec, bufToVec(r.embedding));
    if (!best || sim > best.sim) best = { row: r, sim };
  }

  if (best && best.sim >= config.cache.semanticThreshold) {
    db.prepare(`UPDATE semantic_cache SET hits = hits + 1, last_hit = ? WHERE id = ?`).run(Date.now(), best.row.id);
    return {
      response: best.row.response_text,
      tokensIn: best.row.tokens_in,
      tokensOut: best.row.tokens_out,
      similarity: best.sim,
    };
  }
  return null;
}

export async function storeSemantic(prompt: string, response: string, model: string, tokensIn: number, tokensOut: number) {
  if (!prompt || !response) return;
  const db = getDb();
  const hash = sha(prompt);
  const vec = await embed(prompt);
  const now = Date.now();
  db.prepare(`INSERT OR IGNORE INTO semantic_cache
    (prompt_hash, prompt_text, embedding, response_text, model, tokens_in, tokens_out, hits, created_at, last_hit)
    VALUES (?,?,?,?,?,?,?,0,?,?)`)
    .run(hash, prompt, vecToBuf(vec), response, model, tokensIn, tokensOut, now, now);
}
