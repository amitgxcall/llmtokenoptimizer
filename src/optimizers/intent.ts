// Intent classification. Two paths:
//   1. Rule-based (always works, zero deps, zero tokens).
//   2. Helper LLM (opt-in via config) — refines borderline cases.
//
// Each intent maps to a context budget so the pruner knows how aggressive to be.

import { helperAvailable, helperChat } from "./helper.js";

export type Intent =
  | "explain" | "fix-error" | "refactor" | "generate-new"
  | "run-command" | "debug" | "answer-question" | "unknown";

export const INTENT_BUDGETS: Record<Intent, { maxContextTokens: number; preferDiff: boolean }> = {
  "explain":         { maxContextTokens: 2_000, preferDiff: false },
  "fix-error":       { maxContextTokens: 4_000, preferDiff: true },
  "refactor":        { maxContextTokens: 8_000, preferDiff: true },
  "generate-new":    { maxContextTokens: 3_000, preferDiff: false },
  "run-command":     { maxContextTokens: 1_000, preferDiff: false },
  "debug":           { maxContextTokens: 6_000, preferDiff: true },
  "answer-question": { maxContextTokens: 1_500, preferDiff: false },
  "unknown":         { maxContextTokens: 4_000, preferDiff: false },
};

const RULES: Array<{ intent: Intent; re: RegExp }> = [
  { intent: "fix-error",       re: /\b(fix|resolve|TypeError|SyntaxError|undefined|cannot find|broke|broken|error[: ]|stack ?trace)\b/i },
  { intent: "refactor",        re: /\b(refactor|rename|extract|inline|move|reorganize|clean ?up|simplify)\b/i },
  { intent: "explain",         re: /\b(explain|what does|how does|walk me through|why is|what is this)\b/i },
  { intent: "generate-new",    re: /\b(write|create|add|implement|build|scaffold|generate|make a)\b/i },
  { intent: "run-command",     re: /\b(run|execute|npm |pytest|cargo |docker |git )\b/i },
  { intent: "debug",           re: /\b(debug|why isn't|why doesn't|not working|failing|trace|log)\b/i },
  { intent: "answer-question", re: /\?\s*$/ },
];

export function classifyRules(prompt: string): Intent {
  for (const { intent, re } of RULES) if (re.test(prompt)) return intent;
  return "unknown";
}

const HELPER_SYS = `Classify the user's intent into exactly one token from this set:
explain | fix-error | refactor | generate-new | run-command | debug | answer-question

Reply with only the single token. No prose, no punctuation.`;

export async function classify(prompt: string): Promise<Intent> {
  const ruleHit = classifyRules(prompt);
  if (ruleHit !== "unknown") return ruleHit;
  if (!helperAvailable()) return "unknown";

  const reply = await helperChat(prompt.slice(0, 1500), { system: HELPER_SYS, maxTokens: 8 });
  if (!reply) return "unknown";
  const tok = reply.trim().toLowerCase().split(/[^a-z-]/)[0] ?? "";
  const valid: Intent[] = ["explain","fix-error","refactor","generate-new","run-command","debug","answer-question"];
  return (valid as string[]).includes(tok) ? (tok as Intent) : "unknown";
}
