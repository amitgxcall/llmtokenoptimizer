import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, estimateMessagesTokens } from "../../src/utils/tokens.js";

test("empty string -> 0 tokens", () => {
  assert.equal(estimateTokens(""), 0);
});

test("null / undefined -> 0 tokens", () => {
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test("~4 chars/token heuristic", () => {
  const s = "x".repeat(400);
  const t = estimateTokens(s);
  assert.ok(t >= 95 && t <= 105, `got ${t}`);
});

test("estimateMessagesTokens handles string content", () => {
  const t = estimateMessagesTokens([
    { content: "hello world" },
    { content: "another message" },
  ]);
  assert.ok(t > 0);
});

test("estimateMessagesTokens handles array content blocks", () => {
  const t = estimateMessagesTokens([
    { content: [{ type: "text", text: "block one" }, { type: "text", text: "block two" }] },
  ]);
  assert.ok(t > 0);
});

test("longer input -> more tokens (monotonic)", () => {
  const a = estimateMessagesTokens([{ content: "short" }]);
  const b = estimateMessagesTokens([{ content: "a much longer message that should clearly produce more tokens" }]);
  assert.ok(b > a);
});
