import { test } from "node:test";
import assert from "node:assert/strict";
import { embed, cosineSim, vecToBuf, bufToVec } from "../../src/optimizers/embeddings.js";

// These tests exercise the fallback hash-bag path (Ollama unlikely to run in CI).

test("embed returns Float32Array", async () => {
  const v = await embed("hello world");
  assert.ok(v instanceof Float32Array);
  assert.ok(v.length > 0);
});

test("identical text -> cosine 1", async () => {
  const a = await embed("npm install fails with ENOENT");
  const b = await embed("npm install fails with ENOENT");
  assert.ok(Math.abs(cosineSim(a, b) - 1) < 1e-6);
});

test("different text -> cosine < 1", async () => {
  const a = await embed("how do I fix the build");
  const b = await embed("explain quantum mechanics to me");
  const sim = cosineSim(a, b);
  assert.ok(sim < 1);
});

test("vecToBuf / bufToVec round-trip preserves values", async () => {
  const v = await embed("round trip test");
  const buf = vecToBuf(v);
  const back = bufToVec(buf);
  assert.equal(back.length, v.length);
  for (let i = 0; i < v.length; i++) {
    assert.ok(Math.abs(back[i]! - v[i]!) < 1e-9);
  }
});

test("cosineSim of orthogonal vectors is 0", () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0, 1, 0]);
  assert.equal(cosineSim(a, b), 0);
});

test("cosineSim of mismatched lengths is 0", () => {
  assert.equal(cosineSim(new Float32Array([1,2]), new Float32Array([1,2,3])), 0);
});
