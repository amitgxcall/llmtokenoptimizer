import { test } from "node:test";
import assert from "node:assert/strict";
import { slimOutputText, OUTPUT_SLIM_SYSTEM_ADDENDUM } from "../../src/optimizers/outputSlimmer.js";

test("strips 'Sure!' preamble", () => {
  const { text } = slimOutputText("Sure! Here's the function you asked for.\n\ncode here");
  assert.ok(!text.startsWith("Sure"));
  assert.ok(text.includes("code here"));
});

test("strips 'Hope this helps!' postamble", () => {
  const { text } = slimOutputText("Answer body.\n\nHope this helps! Let me know.");
  assert.ok(!/hope this helps/i.test(text));
  assert.ok(text.startsWith("Answer body"));
});

test("strips 'Let me know if' postamble", () => {
  const { text } = slimOutputText("foo bar\n\nLet me know if you need anything else.");
  assert.ok(!/let me know/i.test(text));
});

test("collapses 3+ blank lines to 2", () => {
  const { text } = slimOutputText("a\n\n\n\n\nb");
  assert.equal(text, "a\n\nb");
});

test("returns positive `saved` when text shrinks", () => {
  const original = "Sure! Here's the answer.\n\nbody\n\nHope this helps!";
  const { saved } = slimOutputText(original);
  assert.ok(saved > 0);
});

test("idempotent on already-clean text", () => {
  const clean = "function foo() {\n  return 42;\n}";
  const { text, saved } = slimOutputText(clean);
  assert.equal(text, clean);
  assert.equal(saved, 0);
});

test("system addendum contains diff instruction", () => {
  assert.match(OUTPUT_SLIM_SYSTEM_ADDENDUM, /diff/i);
  assert.match(OUTPUT_SLIM_SYSTEM_ADDENDUM, /no preamble/i);
});
