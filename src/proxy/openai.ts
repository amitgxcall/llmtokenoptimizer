import { Hono } from "hono";
import { config } from "../config.js";
import { OUTPUT_SLIM_SYSTEM_ADDENDUM, slimOutputText } from "../optimizers/outputSlimmer.js";
import { estimateTokens } from "../utils/tokens.js";
import { record } from "../ledger/tracker.js";
import { lookupMemory, recordPattern } from "../optimizers/memory.js";
import { lookupSemantic, storeSemantic } from "../optimizers/semanticCache.js";

export const openai = new Hono();

openai.post("/v1/chat/completions", async (c) => {
  const started = Date.now();
  const raw = (await c.req.json()) as any;
  const messages = raw.messages as Array<{ role: string; content: string }>;

  const userQuestion = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
  const tokensInRaw = messages.reduce((t, m) => t + estimateTokens(m.content) + 4, 0);

  const memHit = await lookupMemory(userQuestion);
  if (memHit) {
    record({
      provider: "openai", model: raw.model ?? config.openai.defaultModel, intent: "memory-hit",
      tokensInRaw, tokensInSent: 0, tokensOutRaw: estimateTokens(memHit.answer),
      tokensOutReturned: estimateTokens(memHit.answer),
      cacheHitType: "memory", latencyMs: Date.now() - started,
      techniques: { memory: { tokensSaved: tokensInRaw } },
    });
    return c.json(synthOpenAIResponse(raw.model ?? config.openai.defaultModel, memHit.answer));
  }

  const semHit = await lookupSemantic(userQuestion);
  if (semHit) {
    record({
      provider: "openai", model: raw.model ?? config.openai.defaultModel, intent: "semantic-hit",
      tokensInRaw, tokensInSent: 0, tokensOutRaw: semHit.tokensOut, tokensOutReturned: semHit.tokensOut,
      cacheHitType: "semantic", latencyMs: Date.now() - started,
      techniques: { semanticCache: { tokensSaved: tokensInRaw } },
    });
    return c.json(synthOpenAIResponse(raw.model ?? config.openai.defaultModel, semHit.response));
  }

  // Prepend output-slim addendum to system message (preserves prefix for OpenAI auto-cache)
  const sysIdx = messages.findIndex(m => m.role === "system");
  if (sysIdx >= 0) messages[sysIdx]!.content = messages[sysIdx]!.content + "\n\n" + OUTPUT_SLIM_SYSTEM_ADDENDUM;
  else messages.unshift({ role: "system", content: OUTPUT_SLIM_SYSTEM_ADDENDUM });

  const upstream = await fetch(`${config.openai.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${config.openai.apiKey}`,
    },
    body: JSON.stringify(raw),
  });
  const data = (await upstream.json()) as any;

  const choice = data?.choices?.[0]?.message;
  const rawOut = choice?.content ?? "";
  const { text: slim } = slimOutputText(rawOut);
  if (choice) choice.content = slim;

  const usage = data?.usage ?? {};
  const tokensInSent = usage.prompt_tokens ?? tokensInRaw;
  const tokensInCached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const tokensOutRaw = usage.completion_tokens ?? estimateTokens(rawOut);
  const tokensOutReturned = estimateTokens(slim);

  record({
    provider: "openai",
    model: raw.model ?? config.openai.defaultModel,
    tokensInRaw, tokensInSent, tokensInCached,
    tokensOutRaw, tokensOutReturned,
    cacheHitType: tokensInCached > 0 ? "exact" : null,
    latencyMs: Date.now() - started,
    techniques: {
      providerPromptCache: { tokensSaved: tokensInCached },
      outputSlim: { tokensSaved: tokensOutRaw - tokensOutReturned },
    },
  });

  storeSemantic(userQuestion, slim, raw.model, tokensInSent, tokensOutReturned).catch(() => {});
  recordPattern(userQuestion, slim, tokensInRaw + tokensOutRaw).catch(() => {});

  return c.json(data);
});

function synthOpenAIResponse(model: string, text: string) {
  return {
    id: "chatcmpl-lto-" + Math.random().toString(36).slice(2, 10),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    lto: { source: "cache" },
  };
}
