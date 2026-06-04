import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRules, INTENT_BUDGETS } from "../../src/optimizers/intent.js";

test("classifies fix-error from 'TypeError'", () => {
  assert.equal(classifyRules("TypeError: undefined is not a function"), "fix-error");
});

test("classifies fix-error from 'fix the bug'", () => {
  assert.equal(classifyRules("fix the failing test"), "fix-error");
});

test("classifies refactor from 'rename'", () => {
  assert.equal(classifyRules("rename this function"), "refactor");
});

test("classifies explain from 'explain how'", () => {
  assert.equal(classifyRules("explain how this works"), "explain");
});

test("classifies generate-new from 'write a function'", () => {
  assert.equal(classifyRules("write a function that adds two numbers"), "generate-new");
});

test("classifies run-command from 'npm install'", () => {
  assert.equal(classifyRules("npm install lodash"), "run-command");
});

test("classifies debug from 'why isn't'", () => {
  assert.equal(classifyRules("why isn't this working"), "debug");
});

test("classifies answer-question from trailing '?'", () => {
  assert.equal(classifyRules("what's the time complexity here?"), "answer-question");
});

test("returns 'unknown' for ambiguous input", () => {
  assert.equal(classifyRules("xyz"), "unknown");
});

test("every intent has a budget defined", () => {
  for (const k of ["explain","fix-error","refactor","generate-new","run-command","debug","answer-question","unknown"] as const) {
    assert.ok(INTENT_BUDGETS[k].maxContextTokens > 0, `budget for ${k}`);
  }
});

test("explain has smaller budget than refactor (cheaper context)", () => {
  assert.ok(INTENT_BUDGETS.explain.maxContextTokens < INTENT_BUDGETS.refactor.maxContextTokens);
});
