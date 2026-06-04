import { summary } from "./tracker.js";
import { getDb } from "./db.js";

const days = Number(process.argv[2] ?? 7);
const s = summary(days);

const fmt$ = (n: number) => `$${n.toFixed(4)}`;
const fmtN = (n: number) => n.toLocaleString();

console.log(`\nLLM Token Optimizer — last ${days} day(s)\n`);
console.log(`  prompts processed   : ${fmtN(s.prompts)}`);
console.log(`  input  tokens saved : ${fmtN(s.tokensSavedIn)}`);
console.log(`  output tokens saved : ${fmtN(s.tokensSavedOut)}`);
console.log(`  cost would-have-been: ${fmt$(s.costRawUsd)}`);
console.log(`  cost saved          : ${fmt$(s.costSavedUsd)}  (${s.savingsPct.toFixed(1)}%)`);
console.log(`  cache hit rate      : ${(s.cacheHitRate * 100).toFixed(1)}%\n`);

const byModel = getDb().prepare(`
  SELECT model,
         COUNT(*) AS n,
         SUM(cost_usd_saved) AS saved
  FROM prompts
  WHERE ts >= ?
  GROUP BY model
  ORDER BY saved DESC`).all(Date.now() - days * 86_400_000) as any[];

if (byModel.length) {
  console.log("  by model:");
  for (const r of byModel) {
    console.log(`    ${r.model.padEnd(32)} ${String(r.n).padStart(6)}  saved ${fmt$(r.saved ?? 0)}`);
  }
  console.log();
}
