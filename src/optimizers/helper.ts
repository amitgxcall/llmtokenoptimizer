// Helper LLM router.
//
// LTO never *needs* an external LLM — every optimization pass has a local
// fallback (regex, embeddings, sqlite). The helper tier is purely additive:
// if the user opts in to a small/cheap/free model, intent classification and
// (later) compression get a quality bump.
//
// Endpoints assumed OpenAI-compatible (works for OpenAI, Groq, Cerebras,
// DeepSeek, Together, Mistral, Ollama, vLLM, custom).
// Anthropic gets its own native shape.

import { config } from "../config.js";

interface HelperProfile {
  baseUrl: string;
  apiKey: string;
  model: string;
  shape: "openai" | "anthropic";
  // Approx price per 1M tokens (in,out). 0 = free tier.
  pricing: { in: number; out: number };
}

function resolveProfile(): HelperProfile | null {
  const h = config.helper;
  const override = (m: string) => h.model || m;

  switch (h.mode) {
    case "local-only":
      return null;

    case "ollama":
      return {
        baseUrl: config.ollama.baseUrl + "/v1",
        apiKey: "ollama",
        model: override(config.ollama.intentModel),
        shape: "openai",
        pricing: { in: 0, out: 0 },
      };

    case "groq": // free tier as of 2026: llama-3.3-70b-versatile
      return {
        baseUrl: h.baseUrl || "https://api.groq.com/openai/v1",
        apiKey: h.apiKey,
        model: override("llama-3.3-70b-versatile"),
        shape: "openai",
        pricing: { in: 0, out: 0 },
      };

    case "cerebras": // free tier: llama-3.3-70b
      return {
        baseUrl: h.baseUrl || "https://api.cerebras.ai/v1",
        apiKey: h.apiKey,
        model: override("llama-3.3-70b"),
        shape: "openai",
        pricing: { in: 0, out: 0 },
      };

    case "deepseek":
      return {
        baseUrl: h.baseUrl || "https://api.deepseek.com/v1",
        apiKey: h.apiKey,
        model: override("deepseek-chat"),
        shape: "openai",
        pricing: { in: 0.27, out: 1.10 },
      };

    case "anthropic":
      return {
        baseUrl: h.baseUrl || config.anthropic.baseUrl,
        apiKey: h.apiKey || config.anthropic.apiKey,
        model: override(config.anthropic.cheapModel),
        shape: "anthropic",
        pricing: { in: 0.80, out: 4.00 },
      };

    case "openai":
      return {
        baseUrl: h.baseUrl || config.openai.baseUrl + "/v1",
        apiKey: h.apiKey || config.openai.apiKey,
        model: override(config.openai.cheapModel),
        shape: "openai",
        pricing: { in: 0.15, out: 0.60 },
      };

    case "custom":
      if (!h.baseUrl || !h.model) return null;
      return {
        baseUrl: h.baseUrl,
        apiKey: h.apiKey,
        model: h.model,
        shape: "openai",
        pricing: { in: 0, out: 0 },
      };
  }
}

let spentToday = 0;
let spentDay = new Date().toISOString().slice(0, 10);
function trackSpend(p: HelperProfile, inTok: number, outTok: number) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== spentDay) { spentDay = today; spentToday = 0; }
  spentToday += (inTok * p.pricing.in + outTok * p.pricing.out) / 1_000_000;
}

export function helperAvailable(): boolean {
  const p = resolveProfile();
  if (!p) return false;
  if (p.pricing.in > 0 && spentToday >= config.helper.dailyBudgetUsd) return false;
  return true;
}

export async function helperChat(prompt: string, opts: { maxTokens?: number; system?: string } = {}): Promise<string | null> {
  const p = resolveProfile();
  if (!p) return null;
  if (p.pricing.in > 0 && spentToday >= config.helper.dailyBudgetUsd) return null;

  try {
    if (p.shape === "openai") {
      const r = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}) },
        body: JSON.stringify({
          model: p.model,
          messages: [
            ...(opts.system ? [{ role: "system", content: opts.system }] : []),
            { role: "user", content: prompt },
          ],
          max_tokens: opts.maxTokens ?? 64,
          temperature: 0,
        }),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as any;
      const u = j.usage ?? {};
      trackSpend(p, u.prompt_tokens ?? 0, u.completion_tokens ?? 0);
      return j.choices?.[0]?.message?.content ?? null;
    }
    // anthropic shape
    const r = await fetch(`${p.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: p.model,
        max_tokens: opts.maxTokens ?? 64,
        temperature: 0,
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    const u = j.usage ?? {};
    trackSpend(p, u.input_tokens ?? 0, u.output_tokens ?? 0);
    return (j.content?.[0]?.text) ?? null;
  } catch {
    return null;
  }
}
