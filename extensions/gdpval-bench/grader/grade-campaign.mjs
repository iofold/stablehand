// Grade one campaign's collected deliverables.
//
//   node grader/grade-campaign.mjs <cell> [--limit N] [--tasks id1,id2]
//
// Channel 1: pairwise vs the published human gold deliverables (k=3,
// position-swapped) -> win-rate.  Channel 2: rubric scoring (judge majority
// per item; weighted score).  Also runs the injection sanitizer over
// extracted deliverable text. Writes grades.json per task and summary.json.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DIR, loadRows, mapLimit } from '../runner/lib.mjs';
import { pairwise, rubric, JUDGE_MODEL } from './judge.mjs';

const [cellName, ...rest] = process.argv.slice(2);
const resultsDir = join(EXT_DIR, 'results', cellName);
if (!existsSync(resultsDir)) { console.error(`no results for cell '${cellName}'`); process.exit(1); }
const args = new Map();
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) args.set(rest[i].slice(2), rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i]);
}

const rows = loadRows();
const PY = join(EXT_DIR, '.venv', 'bin', 'python');

const INJECTION_PATTERNS = [
  /ignore (all |any |the )?(previous|above|prior) (instructions|text)/i,
  /as (the|an|a) (grader|evaluator|judge|reviewer)/i,
  /(score|rate|grade) this (deliverable|document|work) (as|with|highly)/i,
  /this deliverable (is|should be considered) (excellent|superior|complete)/i,
  /\bsystem prompt\b/i,
];

function extract(file, maxChars = 40_000) {
  return execFileSync(PY, [join(EXT_DIR, 'grader', 'extract.py'), file, String(maxChars)], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
}

function extractDir(dir) {
  if (!existsSync(dir)) return { text: '', files: [] };
  const files = readdirSync(dir).filter((f) => !f.startsWith('.'));
  const parts = files.map((f) => `===== FILE: ${f} =====\n${extract(join(dir, f))}`);
  return { text: parts.join('\n\n'), files };
}

let taskIds = readdirSync(resultsDir).filter((d) => existsSync(join(resultsDir, d, 'meta.json')));
if (args.has('tasks')) {
  const wanted = new Set(String(args.get('tasks')).split(','));
  taskIds = taskIds.filter((t) => wanted.has(t) || wanted.has(t.slice(0, 8)));
}
if (args.has('limit')) taskIds = taskIds.slice(0, Number(args.get('limit')));

async function gradeTask(taskId) {
  const short = taskId.slice(0, 8);
  const outDir = join(resultsDir, taskId);
  const meta = JSON.parse(readFileSync(join(outDir, 'meta.json'), 'utf8'));
  const gradesPath = join(outDir, 'grades.json');
  if (existsSync(gradesPath) && !args.has('force')) { console.log(`[${short}] already graded`); return JSON.parse(readFileSync(gradesPath, 'utf8')); }
  const row = rows.get(taskId);
  const grade = { taskId, cell: cellName, judgeModel: JUDGE_MODEL, gradedAtIso: new Date().toISOString(), turnStatus: meta.status };

  if (meta.status !== 'COMPLETED' || !meta.artifacts?.length) {
    grade.outcome = 'no_deliverable';
    grade.pairwise = { winRate: 0, votes: [] };
    grade.rubricScore = { earned: 0, max: row ? JSON.parse(row.rubric_json).reduce((s, r) => s + Math.max(r.score, 0), 0) : 0 };
    writeFileSync(gradesPath, JSON.stringify(grade, null, 1));
    console.log(`[${short}] no deliverable -> auto-loss`);
    return grade;
  }

  const ours = extractDir(join(outDir, 'deliverables'));
  const gold = extractDir(join(EXT_DIR, 'cache', 'gold', taskId));

  // sanitizer: evaluator-directed injection scan over OUR agent's output
  grade.injectionFlags = INJECTION_PATTERNS.map((p) => ours.text.match(p)?.[0]).filter(Boolean);

  const votes = await pairwise(row.prompt, ours.text, gold.text);
  const wins = votes.filter((v) => v.winner === 'ours').length + votes.filter((v) => v.winner === 'tie').length * 0.5;
  grade.pairwise = { votes, winRate: wins / votes.length };

  const rubricItems = JSON.parse(row.rubric_json);
  const verdicts = await rubric(row.prompt, rubricItems, ours.text);
  let earned = 0, max = 0, requiredFailed = [];
  for (const [id, v] of verdicts) {
    if (v.score > 0) max += v.score;
    if (v.met) earned += v.score; // negative-score items subtract when met
    const item = rubricItems.find((r) => r.rubric_item_id === id);
    if (item?.required && !v.met) requiredFailed.push(id);
  }
  grade.rubricScore = { earned, max, pct: max ? Math.max(earned, 0) / max : 0, requiredFailed };
  grade.rubricDetail = Object.fromEntries([...verdicts].map(([id, v]) => [id, { met: v.met, score: v.score }]));
  grade.outcome = 'graded';

  writeFileSync(gradesPath, JSON.stringify(grade, null, 1));
  console.log(`[${short}] winRate=${grade.pairwise.winRate.toFixed(2)} rubric=${(grade.rubricScore.pct * 100).toFixed(0)}%${grade.injectionFlags.length ? ' INJECTION-FLAGS=' + grade.injectionFlags.length : ''}`);
  return grade;
}

const grades = await mapLimit(taskIds, 3, (t) =>
  gradeTask(t).catch((err) => { console.error(`[${t.slice(0, 8)}] GRADER ERROR: ${err.message}`); return { taskId: t, outcome: 'grader_error', error: err.message }; }));

const graded = grades.filter((g) => g.pairwise);
const winRate = graded.length ? graded.reduce((s, g) => s + g.pairwise.winRate, 0) / graded.length : 0;
const rubricAvg = graded.length ? graded.reduce((s, g) => s + (g.rubricScore.pct ?? 0), 0) / graded.length : 0;
const summary = {
  cell: cellName, judgeModel: JUDGE_MODEL, at: new Date().toISOString(),
  tasks: grades.length, graded: graded.length,
  winRateVsHuman: winRate, rubricAvg,
  injectionFlagged: grades.filter((g) => g.injectionFlags?.length).map((g) => g.taskId),
};
writeFileSync(join(resultsDir, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(`\n${cellName}: win-rate vs human ${(winRate * 100).toFixed(1)}%, rubric avg ${(rubricAvg * 100).toFixed(1)}% over ${graded.length} tasks`);
