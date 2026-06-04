// Heuristic token counter. Good enough for ledger / cache decisions.
// For exact counts the provider response.usage is authoritative.
export function estimateTokens(text: string | unknown): number {
  if (text == null) return 0;
  const s = typeof text === "string" ? text : JSON.stringify(text);
  // ~4 chars/token average for English + code. Good ±15% heuristic.
  return Math.ceil(s.length / 4);
}

export function estimateMessagesTokens(messages: Array<{ content: unknown }>): number {
  let t = 0;
  for (const m of messages) {
    if (typeof m.content === "string") t += estimateTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        const text = (block as any)?.text ?? (block as any)?.content ?? "";
        t += estimateTokens(text);
      }
    } else t += estimateTokens(m.content);
    t += 4; // role overhead
  }
  return t;
}
