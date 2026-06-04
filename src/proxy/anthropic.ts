import { Hono } from "hono";
import { config } from "../config.js";
import { anthropicBetaHeaders, injectAnthropicCaching, type AnthropicRequest } from "../optimizers/providerCache.js";
import { OUTPUT_SLIM_SYSTEM_ADDENDUM, slimOutputText } from "../optimizers/outputSlimmer.js";
import { estimateMessagesTokens, estimateTokens } from "../utils/tokens.js";
import { record } from "../ledger/tracker.js";
import { lookupMemory, recordPattern } from "../optimizers/memory.js";
import { lookupSemantic, storeSemantic } from "../optimizers/semanticCache.js";

export const anthropic = new Hono();

anthropic.post("/v1/messages", async (c) => {
  const started = Date.now();
  const raw = (await c.req.json()) as AnthropicRequest;
  const tokensInRaw = estimateMessagesTokens(raw.messages) + estimateTokens(raw.system);

  const userQuestion = lastUserText(raw);

  // 1. Learning memory lookup
  const memHit = await lookupMemory(userQuestion);
  if (memHit) {
    record({
      provider: "anthropic",
      model: raw.model ?? config.anthropic.defaultModel,
      intent: "memory-hit",
      tokensInRaw, tokensInSent: 0, tokensInCached: 0,
      tokensOutRaw: estimateTokens(memHit.answer), tokensOutReturned: estimateTokens(memHit.answer),
      cacheHitType: "memory",
      latencyMs: Date.now() - started,
      techniques: { memory: { tokensSaved: tokensInRaw, notes: `hit_count=${memHit.hitCount}` } },
    });
    return c.json(synthAnthropicResponse(raw.model ?? config.anthropic.defaultModel, memHit.answer));
  }

  // 2. Semantic cache lookup
  const semHit = await lookupSemantic(userQuestion);
  if (semHit) {
    record({
      provider: "anthropic",
      model: raw.model ?? config.anthropic.defaultModel,
      intent: "semantic-hit",
      tokensInRaw, tokensInSent: 0, tokensInCached: 0,
      tokensOutRaw: semHit.tokensOut, tokensOutReturned: semHit.tokensOut,
      cacheHitType: "semantic",
      latencyMs: Date.now() - started,
      techniques: { semanticCache: { tokensSaved: tokensInRaw } },
    });
    return c.json(synthAnthropicResponse(raw.model ?? config.anthropic.defaultModel, semHit.response));
  }

  // 3. Inject output-slim system addendum + provider-native cache markers
  const withSlim = addSystemAddendum(raw, OUTPUT_SLIM_SYSTEM_ADDENDUM);
  const { req: cached, markers } = injectAnthropicCaching(withSlim);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": config.anthropic.apiKey,
    "anthropic-version": "2023-06-01",
  };
  const betas = anthropicBetaHeaders(cached);
  if (betas.length) headers["anthropic-beta"] = betas.join(",");

  const upstream = await fetch(`${config.anthropic.baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(cached),
  });
  const data = (await upstream.json()) as any;

  // 4. Slim output
  const rawOutText = extractAnthropicText(data);
  const { text: slimText, saved: charsSaved } = slimOutputText(rawOutText);
  if (charsSaved > 0) overwriteAnthropicText(data, slimText);

  const usage = data?.usage ?? {};
  const tokensInSent = usage.input_tokens ?? estimateMessagesTokens(cached.messages);
  const tokensInCached = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const tokensOutRaw = (usage.output_tokens ?? estimateTokens(rawOutText));
  const tokensOutReturned = estimateTokens(slimText);

  const tokensInSavedByPipeline = Math.max(0, tokensInRaw - tokensInSent);

  record({
    provider: "anthropic",
    model: raw.model ?? config.anthropic.defaultModel,
    tokensInRaw, tokensInSent, tokensInCached,
    tokensOutRaw, tokensOutReturned,
    cacheHitType: tokensInCached > 0 ? "exact" : null,
    latencyMs: Date.now() - started,
    techniques: {
      providerPromptCache: { tokensSaved: tokensInCached, notes: `${markers} markers` },
      outputSlim: { tokensSaved: tokensOutRaw - tokensOutReturned },
      pipeline: { tokensSaved: tokensInSavedByPipeline },
    },
  });

  // Store for future semantic + memory lookup (fire and forget)
  storeSemantic(userQuestion, slimText, raw.model ?? config.anthropic.defaultModel, tokensInSent, tokensOutReturned).catch(() => {});
  recordPattern(userQuestion, slimText, tokensInRaw + tokensOutRaw).catch(() => {});

  return c.json(data);
});

function lastUserText(req: AnthropicRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const t = (m.content as any[]).map(b => b.text ?? "").join("\n");
      if (t) return t;
    }
  }
  return "";
}

function addSystemAddendum(req: AnthropicRequest, addendum: string): AnthropicRequest {
  const r = { ...req };
  if (!r.system) r.system = addendum;
  else if (typeof r.system === "string") r.system = r.system + "\n\n" + addendum;
  else if (Array.isArray(r.system)) r.system = [...r.system, { type: "text", text: addendum }];
  return r;
}

function extractAnthropicText(resp: any): string {
  if (!resp?.content) return "";
  return (resp.content as any[]).filter(b => b.type === "text").map(b => b.text).join("");
}

function overwriteAnthropicText(resp: any, text: string) {
  if (!resp?.content) return;
  let written = false;
  for (const b of resp.content as any[]) {
    if (b.type === "text" && !written) { b.text = text; written = true; }
    else if (b.type === "text") b.text = "";
  }
}

function synthAnthropicResponse(model: string, text: string) {
  return {
    id: "msg_lto_" + Math.random().toString(36).slice(2, 10),
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    lto: { source: "cache" },
  };
}
