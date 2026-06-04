// Inject provider-native cost features.
// Anthropic: prompt caching via cache_control on the last stable content block.
// OpenAI: automatic caching kicks in for stable prefixes ≥1024 tokens — we just
// preserve prefix stability (no random reordering of system/tool blocks).

import { config } from "../config.js";
import { estimateTokens } from "../utils/tokens.js";

const MIN_CACHE_TOKENS = 1024; // Anthropic minimum for ephemeral cache

export interface AnthropicRequest {
  model?: string;
  system?: string | Array<{ type: string; text: string; cache_control?: unknown }>;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<unknown>;
  [k: string]: unknown;
}

export function injectAnthropicCaching(req: AnthropicRequest): { req: AnthropicRequest; markers: number } {
  if (!config.anthropic.enablePromptCaching) return { req, markers: 0 };
  let markers = 0;
  const r: AnthropicRequest = { ...req };

  // Cache system prompt if it's big enough
  if (typeof r.system === "string" && estimateTokens(r.system) >= MIN_CACHE_TOKENS) {
    r.system = [{ type: "text", text: r.system, cache_control: { type: "ephemeral" } }];
    markers++;
  } else if (Array.isArray(r.system)) {
    const last = r.system[r.system.length - 1];
    if (last && !("cache_control" in last)) {
      last.cache_control = { type: "ephemeral" };
      markers++;
    }
  }

  // Cache tools array (rarely changes)
  if (r.tools && r.tools.length > 0) {
    const lastTool = r.tools[r.tools.length - 1] as any;
    if (lastTool && typeof lastTool === "object" && !lastTool.cache_control) {
      lastTool.cache_control = { type: "ephemeral" };
      markers++;
    }
  }

  // Cache the most recent stable user message (everything but the last turn)
  if (r.messages.length >= 2) {
    const target = r.messages[r.messages.length - 2];
    if (target && typeof target.content === "string" && estimateTokens(target.content) >= MIN_CACHE_TOKENS) {
      target.content = [
        { type: "text", text: target.content, cache_control: { type: "ephemeral" } },
      ];
      markers++;
    } else if (target && Array.isArray(target.content)) {
      const lastBlock = (target.content as any[])[target.content.length - 1];
      if (lastBlock && typeof lastBlock === "object" && !lastBlock.cache_control) {
        lastBlock.cache_control = { type: "ephemeral" };
        markers++;
      }
    }
  }

  return { req: r, markers };
}

export function anthropicBetaHeaders(req: AnthropicRequest): string[] {
  const betas: string[] = [];
  if (config.anthropic.enableTokenEfficientTools && req.tools && req.tools.length > 0) {
    betas.push("token-efficient-tools-2025-02-19");
  }
  if (config.anthropic.enableMemoryTool) {
    betas.push("context-management-2025-06-27");
  }
  return betas;
}
