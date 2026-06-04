// Learning memory — tracks recurring question patterns, auto-promotes hot
// ones into a permanent FAQ cache so repeat asks never hit the LLM.
//
// Pattern lifecycle:
//   1. First time: record with hit_count=1.
//   2. Subsequent near-matches (cosine >= deltaThreshold): increment hit_count.
//   3. At hit_count >= faqPromotionHits, mark promoted_to_faq=1 — future hits
//      return the canonical answer directly with 0 LLM tokens.
//   4. Decay weekly (50% over inactive periods) so memory stays current.

import crypto from "node:crypto";
import { getDb } from "../ledger/db.js";
import { config } from "../config.js";
import { bufToVec, cosineSim, embed, vecToBuf } from "./embeddings.js";

const normalize = (s: string) =>
  s.toLowerCase()
   .replace(/```[\s\S]*?```/g, " <code> ")  // strip code blocks — they vary, intent doesn't
   .replace(/\b[0-9a-f]{7,}\b/g, " <hash> ") // hashes / ids
   .replace(/\s+/g, " ")
   .trim();

const sigHash = (s: string) => crypto.createHash("sha256").update(normalize(s)).digest("hex");

export interface MemoryHit {
  question: string;
  answer: string;
  hitCount: number;
  similarity: number;
}

export async function lookupMemory(prompt: string): Promise<MemoryHit | null> {
  if (!prompt) return null;
  const db = getDb();
  const hash = sigHash(prompt);

  // 1. Exact normalized match against promoted FAQ
  const exact = db.prepare(`
    SELECT canonical_question, canonical_answer, hit_count
    FROM memory_patterns WHERE pattern_hash = ? AND promoted_to_faq = 1
  `).get(hash) as any;
  if (exact) {
    db.prepare(`UPDATE memory_patterns SET hit_count = hit_count + 1, last_seen = ?, tokens_saved_total = tokens_saved_total + ? WHERE pattern_hash = ?`)
      .run(Date.now(), Math.ceil(prompt.length / 4), hash);
    return { question: exact.canonical_question, answer: exact.canonical_answer, hitCount: exact.hit_count + 1, similarity: 1 };
  }

  // 2. Semantic match against promoted FAQ only (memory hits must be high-confidence)
  const vec = await embed(prompt);
  const promoted = db.prepare(`SELECT id, canonical_question, canonical_answer, hit_count, embedding FROM memory_patterns WHERE promoted_to_faq = 1 LIMIT 200`).all() as any[];
  let best: { row: any; sim: number } | null = null;
  for (const r of promoted) {
    if (!r.embedding) continue;
    const sim = cosineSim(vec, bufToVec(r.embedding));
    if (!best || sim > best.sim) best = { row: r, sim };
  }
  if (best && best.sim >= config.cache.semanticThreshold) {
    db.prepare(`UPDATE memory_patterns SET hit_count = hit_count + 1, last_seen = ? WHERE id = ?`)
      .run(Date.now(), best.row.id);
    return { question: best.row.canonical_question, answer: best.row.canonical_answer, hitCount: best.row.hit_count + 1, similarity: best.sim };
  }

  return null;
}

export async function recordPattern(question: string, answer: string, tokensSavedIfHit: number) {
  if (!question || !answer) return;
  const db = getDb();
  const hash = sigHash(question);
  const now = Date.now();

  const existing = db.prepare(`SELECT id, hit_count, promoted_to_faq FROM memory_patterns WHERE pattern_hash = ?`).get(hash) as any;

  if (existing) {
    const newHits = existing.hit_count + 1;
    const promote = !existing.promoted_to_faq && newHits >= config.memory.faqPromotionHits ? 1 : existing.promoted_to_faq;
    db.prepare(`UPDATE memory_patterns
      SET hit_count = ?, last_seen = ?, promoted_to_faq = ?,
          canonical_answer = CASE WHEN promoted_to_faq = 0 THEN ? ELSE canonical_answer END,
          tokens_saved_total = tokens_saved_total + ?
      WHERE id = ?`)
      .run(newHits, now, promote, answer, tokensSavedIfHit, existing.id);
    return;
  }

  // First sighting — store with embedding so similar future asks can promote
  const vec = await embed(question);
  db.prepare(`INSERT INTO memory_patterns
    (pattern_hash, embedding, canonical_question, canonical_answer, hit_count, last_seen, promoted_to_faq, tokens_saved_total)
    VALUES (?, ?, ?, ?, 1, ?, 0, 0)`)
    .run(hash, vecToBuf(vec), question, answer, now);
}

export function topPatterns(limit = 20) {
  return getDb().prepare(`
    SELECT canonical_question, hit_count, promoted_to_faq, tokens_saved_total, last_seen
    FROM memory_patterns
    ORDER BY hit_count DESC
    LIMIT ?`).all(limit);
}

export function decay() {
  // Halve hit counts for patterns not seen in `decayDays`. Drop zeros.
  const cutoff = Date.now() - config.memory.decayDays * 86_400_000;
  const db = getDb();
  db.prepare(`UPDATE memory_patterns SET hit_count = hit_count / 2 WHERE last_seen < ?`).run(cutoff);
  db.prepare(`DELETE FROM memory_patterns WHERE hit_count <= 0 AND user_confirmed = 0`).run();
}
