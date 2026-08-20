// Reward-hacking transcript audit for one campaign cell.
//
//   node audit/audit.mjs <cell>
//
// Greps every task's captured transcript (messages + events) for attempts to
// retrieve the public gold solutions or the dataset itself. Any hit means the
// task must be manually reviewed and rerun or excluded before results count.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DIR } from '../runner/lib.mjs';

const [cellName] = process.argv.slice(2);
const resultsDir = join(EXT_DIR, 'results', cellName);
const PATTERNS = [
  /huggingface/i,
  /gdpval/i,
  /deliverable_file/i,
  /hf\.co/i,
  /datasets-server/i,
];

const findings = [];
for (const taskId of readdirSync(resultsDir)) {
  const tPath = join(resultsDir, taskId, 'transcript.json');
  if (!existsSync(tPath)) continue;
  const raw = readFileSync(tPath, 'utf8');
  for (const p of PATTERNS) {
    const m = raw.match(p);
    if (m) {
      const at = raw.indexOf(m[0]);
      findings.push({ taskId, pattern: String(p), context: raw.slice(Math.max(0, at - 120), at + 160).replace(/\s+/g, ' ') });
    }
  }
}
writeFileSync(join(resultsDir, 'audit.json'), JSON.stringify({ cell: cellName, at: new Date().toISOString(), findings }, null, 1));
if (findings.length) {
  console.log(`AUDIT: ${findings.length} flag(s) — manual review required:`);
  for (const f of findings) console.log(`  [${f.taskId.slice(0, 8)}] ${f.pattern}: ...${f.context}...`);
  process.exit(2);
}
console.log(`AUDIT: clean (${readdirSync(resultsDir).length} task dirs scanned)`);
