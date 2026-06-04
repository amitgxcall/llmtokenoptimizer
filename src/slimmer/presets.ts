// Bundled presets. Users can also drop YAMLs into ~/.lto/presets/ and they'll
// be merged at startup (see loader.ts).

import type { Preset } from "./engine.js";

export const BUILTIN_PRESETS: Preset[] = [
  {
    name: "npm",
    match: ["npm install", "npm i ", "npm i\n", "npm ci", "pnpm install", "pnpm i ", "yarn install", "yarn add"],
    strategy: "tail-and-errors",
    keep: [
      { regex: "^npm (ERR!|WARN)" },
      { regex: "^added \\d+ packages" },
      { regex: "^\\d+ vulnerabilities" },
      { regex: "^(error|Error|ERR)" },
    ],
    drop: [
      { regex: "^npm http" },
      { regex: "^\\s*\\d+/\\d+ " },
      { regex: "^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]" },
      { regex: "^\\s*$" },
    ],
    collapse: [
      { pattern: "deprecated", as: "({count} deprecation warnings collapsed)" },
    ],
    alwaysKeepLast: 5,
    maxKeptLines: 60,
  },
  {
    name: "pytest",
    match: ["pytest", "python -m pytest"],
    strategy: "errors-only",
    keep: [
      { regex: "^(FAILED|ERROR|PASSED \\(failed)" },
      { regex: "^E\\s" },                                    // pytest error lines
      { regex: "^>.*$" },                                    // assertion lines
      { regex: "^_+\\s.*\\s_+$" },                           // test name banners
      { regex: "^=+ (FAILURES|ERRORS|short test summary)" },
      { regex: "^\\d+ (passed|failed|error)" },
    ],
    drop: [
      { regex: "^collecting" },
      { regex: "^\\s*\\." },                                 // dots progress
      { regex: "^platform " },
    ],
    alwaysKeepLast: 3,
    maxKeptLines: 120,
  },
  {
    name: "jest",
    match: ["jest", "npm test", "npx jest", "yarn test"],
    strategy: "errors-only",
    keep: [
      { regex: "^(FAIL|PASS) " },
      { regex: "^\\s*✕ " },
      { regex: "^\\s*Expected:" },
      { regex: "^\\s*Received:" },
      { regex: "^\\s*at " },
      { regex: "^Tests?:\\s" },
      { regex: "^Snapshots:" },
    ],
    drop: [
      { regex: "^\\s*✓ " },
      { regex: "^\\s*PASS\\s" },
    ],
    alwaysKeepLast: 4,
    maxKeptLines: 120,
  },
  {
    name: "cargo",
    match: ["cargo build", "cargo check", "cargo test", "cargo run"],
    strategy: "errors-only",
    keep: [
      { regex: "^(warning|error)(\\[E\\d+\\])?:" },
      { regex: "^\\s*-->" },
      { regex: "^\\s*\\|" },
      { regex: "^error: aborting due to" },
      { regex: "^\\s*= help:" },
      { regex: "^\\s*\\d+ warnings? emitted" },
    ],
    drop: [
      { regex: "^\\s*Compiling " },
      { regex: "^\\s*Finished " },
      { regex: "^\\s*Downloaded " },
    ],
    alwaysKeepLast: 3,
    maxKeptLines: 150,
  },
  {
    name: "tsc",
    match: ["tsc", "npx tsc", "tsc --noemit"],
    strategy: "errors-only",
    keep: [
      { regex: ".*error TS\\d+" },
      { regex: ".*\\.tsx?:\\d+:\\d+" },
      { regex: "^Found \\d+ errors?" },
    ],
    drop: [],
    alwaysKeepLast: 2,
    maxKeptLines: 100,
  },
  {
    name: "docker-build",
    match: ["docker build", "docker buildx", "docker compose build"],
    strategy: "tail-and-errors",
    keep: [
      { regex: "^(ERROR|FAIL)" },
      { regex: "^Step \\d+/\\d+ : (RUN|COPY|ADD).*FAIL" },
      { regex: "^Successfully (built|tagged) " },
    ],
    drop: [
      { regex: "^\\s*Sending build context" },
      { regex: "^Step \\d+/\\d+ : " },
      { regex: "^\\s*--->" },
      { regex: "^\\d+:" },                                   // BuildKit step progress
    ],
    alwaysKeepLast: 8,
    maxKeptLines: 60,
  },
  {
    name: "git",
    match: ["git status", "git log", "git diff", "git pull", "git push", "git fetch", "git clone"],
    strategy: "tail-and-errors",
    keep: [
      { regex: "^(error|fatal|warning):" },
      { regex: "^(commit|Author|Date|Merge)" },
      { regex: "^[+-]" },                                    // diff lines
      { regex: "^(diff --git|@@)" },
    ],
    drop: [
      { regex: "^Receiving objects" },
      { regex: "^Resolving deltas" },
      { regex: "^Compressing objects" },
    ],
    alwaysKeepLast: 6,
    maxKeptLines: 200,
  },
  {
    name: "go-test",
    match: ["go test", "go build"],
    strategy: "errors-only",
    keep: [
      { regex: "^FAIL" },
      { regex: "^ok\\s" },
      { regex: "^---\\s+FAIL" },
      { regex: "\\.go:\\d+:" },
      { regex: "^panic:" },
    ],
    drop: [
      { regex: "^=== RUN" },
      { regex: "^--- PASS" },
    ],
    alwaysKeepLast: 4,
    maxKeptLines: 100,
  },
];
