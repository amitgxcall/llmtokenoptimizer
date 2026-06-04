// Command output slimmer engine.
// Takes raw stdout/stderr + a preset, returns a compact version suitable for
// dropping into an LLM context.

export interface Preset {
  name: string;
  match: string[];                              // command prefixes that activate this preset
  strategy: "tail-and-errors" | "errors-only" | "summary-only" | "passthrough";
  keep?: Array<{ regex?: string; flags?: string }>;
  drop?: Array<{ regex?: string; flags?: string; ansi?: boolean }>;
  collapse?: Array<{ pattern: string; as: string; flags?: string }>;
  maxKeptLines?: number;
  alwaysKeepLast?: number;                       // always include last N lines (status/summary)
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function selectPreset(command: string, presets: Preset[]): Preset | null {
  const c = command.trim().toLowerCase();
  for (const p of presets) {
    for (const m of p.match) if (c.startsWith(m.toLowerCase())) return p;
  }
  return null;
}

export interface SlimResult {
  slimmed: string;
  bytesIn: number;
  bytesOut: number;
  tokensSavedEstimate: number;
  preset: string | "none";
}

export function slim(raw: string, preset: Preset | null): SlimResult {
  const bytesIn = Buffer.byteLength(raw);
  if (!preset || preset.strategy === "passthrough") {
    return { slimmed: raw, bytesIn, bytesOut: bytesIn, tokensSavedEstimate: 0, preset: preset?.name ?? "none" };
  }

  // ANSI strip first if any drop rule asks for it (default: yes — bytes always wasted)
  let lines = raw.replace(ANSI_RE, "").split(/\r?\n/);

  // Apply collapse rules. Note: avoid `g` flag with `.test()` — it mutates
  // `lastIndex` and causes every other check to return false.
  for (const c of preset.collapse ?? []) {
    const flags = (c.flags ?? "").replace("g", "");
    const re = new RegExp(c.pattern, flags);
    let count = 0;
    lines = lines.filter(line => {
      if (re.test(line)) { count++; return false; }
      return true;
    });
    if (count > 0) lines.push(c.as.replace("{count}", String(count)));
  }

  // Drop rules
  const dropRules = (preset.drop ?? []).map(d => d.regex ? new RegExp(d.regex, d.flags ?? "") : null).filter(Boolean) as RegExp[];
  lines = lines.filter(line => !dropRules.some(r => r.test(line)));

  // Keep rules (only used if strategy is errors-only / tail-and-errors)
  if (preset.strategy === "errors-only" || preset.strategy === "tail-and-errors") {
    const keepRules = (preset.keep ?? []).map(k => k.regex ? new RegExp(k.regex, k.flags ?? "") : null).filter(Boolean) as RegExp[];

    const kept: string[] = [];
    const tailN = preset.alwaysKeepLast ?? (preset.strategy === "tail-and-errors" ? 8 : 0);
    const tail = tailN > 0 ? lines.slice(-tailN) : [];

    for (const line of lines) {
      if (keepRules.length === 0 || keepRules.some(r => r.test(line))) kept.push(line);
    }
    // de-dupe with tail
    const tailSet = new Set(tail);
    const body = kept.filter(l => !tailSet.has(l));
    lines = [...body, ...(tail.length && body.length ? ["…"] : []), ...tail];
  }

  if (preset.maxKeptLines && lines.length > preset.maxKeptLines) {
    const head = lines.slice(0, Math.floor(preset.maxKeptLines * 0.7));
    const tail = lines.slice(-Math.ceil(preset.maxKeptLines * 0.3));
    lines = [...head, `… (${lines.length - preset.maxKeptLines} lines dropped) …`, ...tail];
  }

  const slimmed = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const bytesOut = Buffer.byteLength(slimmed);
  return {
    slimmed,
    bytesIn,
    bytesOut,
    tokensSavedEstimate: Math.ceil((bytesIn - bytesOut) / 4),
    preset: preset.name,
  };
}
