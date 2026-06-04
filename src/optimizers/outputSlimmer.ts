// Output slimmer — instructs model to be terse and strips known fluff patterns.

const PREAMBLE_PATTERNS = [
  /^(sure|certainly|absolutely|of course|great question)[!,.]?\s*/i,
  /^here['']s\s+(the|what|a|an)\s+/i,
  /^let me\s+/i,
  /^i['']ll\s+/i,
];

const POSTAMBLE_PATTERNS = [
  /\n+(let me know if|hope this helps|feel free to|happy to)[^\n]*\.?\s*$/i,
  /\n+(is there anything else|do you have any other)[^\n]*\?\s*$/i,
];

export function slimOutputText(text: string): { text: string; saved: number } {
  let out = text;
  for (const p of PREAMBLE_PATTERNS) out = out.replace(p, "");
  for (const p of POSTAMBLE_PATTERNS) out = out.replace(p, "");
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.trim();
  return { text: out, saved: text.length - out.length };
}

export const OUTPUT_SLIM_SYSTEM_ADDENDUM = `
[response-style]
- No preamble ("Sure!", "Here's…") or postamble ("Hope this helps!").
- For code edits, output a unified diff or just the changed block — never re-emit unchanged code.
- For explanations, lead with the answer in one sentence, then details if asked.
- Cite file:line for references; do not restate the user's code back to them.
`.trim();
