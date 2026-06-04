// Golden-file tests. Real captured tool output → assert the slimmer's output
// against an expected-shape snapshot.
//
// Update fixtures: edit tests/fixtures/<name>.in.txt then run
//   UPDATE_GOLDEN=1 npm run test:unit
// to regenerate the .out.txt snapshot. Otherwise mismatches fail the test.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { selectPreset, slim } from "../../src/slimmer/engine.js";
import { BUILTIN_PRESETS } from "../../src/slimmer/presets.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures");

const cases = [
  { name: "npm-install",  command: "npm install" },
  { name: "pytest",       command: "pytest tests/" },
  { name: "cargo-build",  command: "cargo build" },
];

for (const c of cases) {
  test(`golden: ${c.name}`, () => {
    const inPath  = path.join(FIXTURE_DIR, `${c.name}.in.txt`);
    const outPath = path.join(FIXTURE_DIR, `${c.name}.out.txt`);
    const raw = fs.readFileSync(inPath, "utf8");
    const preset = selectPreset(c.command, BUILTIN_PRESETS);
    assert.ok(preset, `preset selected for ${c.command}`);
    const { slimmed, bytesIn, bytesOut } = slim(raw, preset!);

    if (process.env.UPDATE_GOLDEN === "1") {
      fs.writeFileSync(outPath, slimmed);
      console.log(`  [updated] ${outPath}  (${bytesIn} → ${bytesOut} bytes)`);
      return;
    }

    if (!fs.existsSync(outPath)) {
      fs.writeFileSync(outPath, slimmed);
      console.log(`  [created] ${outPath}`);
      return;
    }

    const expected = fs.readFileSync(outPath, "utf8");
    assert.equal(slimmed, expected, `slimmer output drifted for ${c.name}. Run UPDATE_GOLDEN=1 to refresh if intended.`);
  });

  test(`golden: ${c.name} actually reduces bytes`, () => {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, `${c.name}.in.txt`), "utf8");
    const preset = selectPreset(c.command, BUILTIN_PRESETS)!;
    const r = slim(raw, preset);
    const reduction = 1 - r.bytesOut / r.bytesIn;
    assert.ok(reduction > 0.10, `${c.name} should drop >10% of bytes, got ${(reduction*100).toFixed(1)}%`);
  });
}

test("golden: errors and summary survive every preset", () => {
  // Smoke check across all fixtures — must-keep substrings
  const musts: Record<string, string[]> = {
    "npm-install": ["ERESOLVE", "3 vulnerabilities"],
    "pytest":      ["FAILED tests/test_api.py::test_login_400", "1 failed, 11 passed"],
    "cargo-build": ["E0599", "no method named", "aborting due to"],
  };
  for (const [name, needles] of Object.entries(musts)) {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.in.txt`), "utf8");
    const cmd = name === "pytest" ? "pytest" : name === "cargo-build" ? "cargo build" : "npm install";
    const { slimmed } = slim(raw, selectPreset(cmd, BUILTIN_PRESETS)!);
    for (const n of needles) assert.ok(slimmed.includes(n), `${name} dropped required substring: "${n}"`);
  }
});
