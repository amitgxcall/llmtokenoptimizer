#!/usr/bin/env node
// lto-slim — standalone CLI. Runs a command, captures stdout/stderr, prints
// the slimmed version. Exit code mirrors the wrapped command.
//
// Usage:
//   lto-slim -- npm install
//   lto-slim --preset pytest -- pytest tests/
//   lto-slim --raw -- npm install   # disable slimming (for A/B compare)

import { spawn } from "node:child_process";
import { BUILTIN_PRESETS } from "./presets.js";
import { selectPreset, slim } from "./engine.js";
import { getDb } from "../ledger/db.js";

function parseArgs(argv: string[]) {
  const out = { preset: null as string | null, raw: false, cmd: [] as string[] };
  let i = 2;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--") { out.cmd = argv.slice(i + 1); break; }
    if (a === "--raw") { out.raw = true; i++; continue; }
    if (a === "--preset") { out.preset = argv[++i] ?? null; i++; continue; }
    if (a === "-h" || a === "--help") {
      console.log("usage: lto-slim [--preset NAME] [--raw] -- <command> [args…]");
      process.exit(0);
    }
    i++;
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.cmd.length === 0) {
  console.error("lto-slim: no command. Usage: lto-slim -- <command> [args…]");
  process.exit(2);
}

const cmdStr = args.cmd.join(" ");
const preset = args.preset
  ? BUILTIN_PRESETS.find(p => p.name === args.preset) ?? null
  : selectPreset(cmdStr, BUILTIN_PRESETS);

let buf = "";
const child = spawn(args.cmd[0]!, args.cmd.slice(1), { shell: true, stdio: ["inherit", "pipe", "pipe"] });
child.stdout.on("data", d => { buf += d.toString(); });
child.stderr.on("data", d => { buf += d.toString(); });

child.on("close", code => {
  if (args.raw || !preset) {
    process.stdout.write(buf);
    process.exit(code ?? 0);
  }
  const r = slim(buf, preset);
  process.stdout.write(r.slimmed + "\n");

  try {
    getDb().prepare(`INSERT INTO command_runs (ts, command, preset, bytes_in, bytes_out, tokens_saved_estimate) VALUES (?,?,?,?,?,?)`)
      .run(Date.now(), cmdStr, r.preset, r.bytesIn, r.bytesOut, r.tokensSavedEstimate);
  } catch { /* ledger optional for standalone use */ }

  process.stderr.write(
    `\n[lto-slim] preset=${r.preset}  ${r.bytesIn}B → ${r.bytesOut}B  ~${r.tokensSavedEstimate} tokens saved\n`,
  );
  process.exit(code ?? 0);
});
