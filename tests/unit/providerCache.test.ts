import { test } from "node:test";
import assert from "node:assert/strict";
import { injectAnthropicCaching, anthropicBetaHeaders } from "../../src/optimizers/providerCache.js";

const bigText = "x".repeat(5000); // ≥1024 token estimate

test("injects cache_control on large string system prompt", () => {
  const { req, markers } = injectAnthropicCaching({
    system: bigText,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.ok(markers >= 1);
  assert.ok(Array.isArray(req.system));
  const first = (req.system as any)[0];
  assert.equal(first.type, "text");
  assert.deepEqual(first.cache_control, { type: "ephemeral" });
});

test("does NOT cache short system prompt (under minimum)", () => {
  const { req, markers } = injectAnthropicCaching({
    system: "be helpful",
    messages: [{ role: "user", content: "hi" }],
  });
  // short string should remain a string (no caching block added)
  assert.equal(typeof req.system, "string");
  assert.equal(markers, 0);
});

test("adds cache_control to last tool definition", () => {
  const { req, markers } = injectAnthropicCaching({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "search", description: "search" }, { name: "fetch", description: "fetch" }],
  });
  assert.ok(markers >= 1);
  const lastTool = (req.tools as any)[1];
  assert.deepEqual(lastTool.cache_control, { type: "ephemeral" });
});

test("caches second-to-last message when it's large", () => {
  const { req, markers } = injectAnthropicCaching({
    messages: [
      { role: "user", content: "first turn" },
      { role: "assistant", content: bigText },
      { role: "user", content: "follow up" },
    ],
  });
  assert.ok(markers >= 1, "should mark large second-to-last message");
  const stable = req.messages[1]!;
  assert.ok(Array.isArray(stable.content), "large content gets wrapped into block array");
  const block = (stable.content as any[])[0];
  assert.deepEqual(block.cache_control, { type: "ephemeral" });
});

test("anthropicBetaHeaders includes token-efficient-tools when tools present", () => {
  const betas = anthropicBetaHeaders({
    messages: [],
    tools: [{ name: "foo", description: "bar" }],
  } as any);
  assert.ok(betas.includes("token-efficient-tools-2025-02-19"));
});

test("anthropicBetaHeaders is empty when no tools", () => {
  const betas = anthropicBetaHeaders({ messages: [] } as any);
  assert.deepEqual(betas, []);
});
