import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPreset, slim } from "../../src/slimmer/engine.js";
import { BUILTIN_PRESETS } from "../../src/slimmer/presets.js";

test("selectPreset matches npm install", () => {
  const p = selectPreset("npm install", BUILTIN_PRESETS);
  assert.equal(p?.name, "npm");
});

test("selectPreset matches pytest tests/", () => {
  const p = selectPreset("pytest tests/", BUILTIN_PRESETS);
  assert.equal(p?.name, "pytest");
});

test("selectPreset returns null for unknown command", () => {
  const p = selectPreset("randomthing", BUILTIN_PRESETS);
  assert.equal(p, null);
});

test("npm preset drops http + progress lines, keeps errors + summary", () => {
  const raw = [
    "npm http GET https://registry.npmjs.org/foo",
    "npm http 200 https://registry.npmjs.org/foo",
    "1/120 fetched",
    "2/120 fetched",
    "npm WARN deprecated bar@1.0.0",
    "npm ERR! code ENOENT",
    "npm ERR! syscall open",
    "added 42 packages in 5s",
    "3 vulnerabilities (1 moderate, 2 high)",
  ].join("\n");
  const preset = selectPreset("npm install", BUILTIN_PRESETS)!;
  const r = slim(raw, preset);
  assert.ok(!r.slimmed.includes("npm http"), "should drop npm http lines");
  assert.ok(!r.slimmed.includes("1/120"),    "should drop progress");
  assert.ok(r.slimmed.includes("npm ERR! code ENOENT"), "should keep ERR lines");
  assert.ok(r.slimmed.includes("added 42 packages"),    "should keep added summary");
  assert.ok(r.slimmed.includes("3 vulnerabilities"),    "should keep vuln summary");
  assert.ok(r.bytesOut < r.bytesIn, "should reduce bytes");
});

test("pytest preset keeps FAILED + tracebacks, drops dots", () => {
  const raw = [
    "platform linux -- Python 3.11",
    "collecting ...",
    "tests/test_foo.py ....F..",
    "_________ test_bar _________",
    "E   AssertionError: expected 1 got 2",
    ">       assert x == 1",
    "FAILED tests/test_foo.py::test_bar",
    "1 failed, 6 passed in 0.42s",
  ].join("\n");
  const preset = selectPreset("pytest", BUILTIN_PRESETS)!;
  const r = slim(raw, preset);
  assert.ok(r.slimmed.includes("FAILED tests/test_foo.py::test_bar"));
  assert.ok(r.slimmed.includes("E   AssertionError"));
  assert.ok(r.slimmed.includes("1 failed, 6 passed"));
  assert.ok(!r.slimmed.includes("platform linux"));
  assert.ok(!r.slimmed.includes("collecting"));
});

test("ANSI escape codes are stripped", () => {
  const raw = "\x1b[31mERROR\x1b[0m something happened";
  const preset = selectPreset("cargo build", BUILTIN_PRESETS)!;
  const r = slim(raw, preset);
  assert.ok(!r.slimmed.includes("\x1b"), "no ANSI bytes remain");
});

test("collapse rule rolls up repeated patterns", () => {
  const raw = Array.from({ length: 5 }, (_, i) => `npm WARN deprecated pkg${i}`).concat([
    "added 100 packages",
  ]).join("\n");
  const preset = selectPreset("npm install", BUILTIN_PRESETS)!;
  const r = slim(raw, preset);
  // collapse rule replaces all "deprecated" lines with single summary
  assert.ok(/deprecation warnings collapsed/.test(r.slimmed), "collapse summary present");
});

test("passthrough strategy is a no-op", () => {
  const r = slim("anything\nat all\n", { name: "x", match: [], strategy: "passthrough" });
  assert.equal(r.bytesIn, r.bytesOut);
});

test("tokensSavedEstimate is positive when bytes drop", () => {
  const raw = "noise\n".repeat(200) + "npm ERR! real error\n";
  const preset = selectPreset("npm install", BUILTIN_PRESETS)!;
  const r = slim(raw, preset);
  assert.ok(r.tokensSavedEstimate > 0);
});
