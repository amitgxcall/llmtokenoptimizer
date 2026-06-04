// Ollama embeddings client (bge-m3 by default).
// If Ollama isn't running, we fall back to a deterministic hash-bag vector
// — enough for exact-text matching but not true semantic similarity.

import { config } from "../config.js";

export async function embed(text: string): Promise<Float32Array> {
  if (!config.ollama.enabled) return fallbackVector(text);
  try {
    const r = await fetch(`${config.ollama.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.ollama.embedModel, prompt: text }),
    });
    if (!r.ok) return fallbackVector(text);
    const { embedding } = (await r.json()) as { embedding: number[] };
    return new Float32Array(embedding);
  } catch {
    return fallbackVector(text);
  }
}

export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na  += a[i]! * a[i]!;
    nb  += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function vecToBuf(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function bufToVec(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

// Deterministic 256-dim hash-bag — fallback only.
function fallbackVector(text: string): Float32Array {
  const v = new Float32Array(256);
  const toks = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const t of toks) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % 256;
    v[idx]! += 1;
  }
  // L2 normalize
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}
