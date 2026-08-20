// Run one campaign cell (harness x model) over the pinned GDPval-CTX slice.
//
//   node runner/run-campaign.mjs <cell> [--limit N] [--tasks id1,id2] [--keep-agents]
//
// Per task: create an ephemeral agent (parallel-safe: base-workspace seeding
// is per-agent), seed reference files via the workspace tar API, run ONE
// background turn, poll to terminal, collect deliverable artifacts, run T0
// validation, write results/<cell>/<taskId>/. Agents are deleted afterwards
// unless --keep-agents.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DIR, CONFIG, api, loadSlice, loadRows, mapLimit, sleep } from './lib.mjs';

const [cellName, ...rest] = process.argv.slice(2);
const cell = CONFIG.cells[cellName];
if (!cell) { console.error(`unknown cell '${cellName}'; cells: ${Object.keys(CONFIG.cells).join(', ')}`); process.exit(1); }
const args = new Map();
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) args.set(rest[i].slice(2), rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i]);
}

const slice = loadSlice();
const rows = loadRows();
let tasks = slice.tasks;
if (args.has('tasks')) {
  const wanted = new Set(String(args.get('tasks')).split(','));
  tasks = tasks.filter((t) => wanted.has(t.taskId) || wanted.has(t.taskId.slice(0, 8)));
}
if (args.has('limit')) tasks = tasks.slice(0, Number(args.get('limit')));

const resultsDir = join(EXT_DIR, 'results', cellName);
mkdirSync(resultsDir, { recursive: true });

const SYSTEM_PROMPT = [
  'You are an experienced professional producing a real work deliverable for a client.',
  'Reference files for the assignment are in the reference/ directory of your workspace.',
  'Work carefully and produce complete, polished, professional-quality output — the deliverable will be reviewed by a domain expert.',
  'Name each deliverable file exactly as the assignment requests. Build documents with the available python libraries (python-docx, openpyxl, python-pptx) and LibreOffice (soffice) for conversions.',
  'When a deliverable file is final, upload it with the artifact_upload tool. Every requested deliverable must be uploaded as an artifact before you finish.',
  'Do not search for, download, or consult any existing solution to this assignment (including the gdpval dataset on huggingface); produce the work yourself from the reference materials.',
].join(' ');

function deliverableInstruction(row) {
  const names = row.deliverable_files.map((f) => f.split('/').pop());
  return `\n\n---\nProduce the following deliverable file(s): ${names.join(', ')}. When each is final, upload it with the artifact_upload tool (path relative to your workspace).`;
}

async function runTask(t, idx) {
  const row = rows.get(t.taskId);
  const short = t.taskId.slice(0, 8);
  const outDir = join(resultsDir, t.taskId);
  const metaPath = join(outDir, 'meta.json');
  if (existsSync(metaPath)) {
    const prev = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (prev.status === 'COMPLETED' && prev.t0?.pass) { console.log(`[${short}] cached, skipping`); return prev; }
  }
  mkdirSync(join(outDir, 'deliverables'), { recursive: true });

  const agentName = `gdp-${cellName}-${short}`;
  const meta = { taskId: t.taskId, cell: cellName, agentName, category: t.category, startedAtIso: new Date().toISOString() };

  // 1. agent (idempotent-ish: name conflict 409 -> look it up)
  let agent = await api('POST', '/agents', {
    name: agentName,
    harness: cell.harness,
    harnessConfig: cell.harnessConfig,
    systemPrompt: SYSTEM_PROMPT,
    tools: ['artifact_upload'],
    resourceLimits: CONFIG.resourceLimits,
    description: `gdpval-bench ${cellName} ${short}`,
  }, { allowError: true });
  if (agent.error) {
    const list = await api('GET', '/agents');
    agent = list.find((a) => a.name === agentName);
    if (!agent) throw new Error(`agent create failed and not found: ${agentName}`);
  }
  meta.agentId = agent.id;

  try {
    // 2. seed workspace: reference/ dir tarball
    const refDir = join(EXT_DIR, 'cache', 'tasks', t.taskId);
    const tarPath = join(outDir, 'seed.tar.gz');
    execFileSync('tar', ['-czf', tarPath, '-C', refDir, 'reference']);
    const tarBody = readFileSync(tarPath);
    await api('POST', `/agents/${agent.id}/workspace?force=true`, tarBody, {
      raw: true, headers: { 'Content-Type': 'application/gzip' },
    });
    rmSync(tarPath);

    // 3. run the turn
    const start = await api('POST', `/agents/${agent.id}/turns`, {
      task: row.prompt + deliverableInstruction(row),
      tags: { bench: 'gdpval', campaign: cellName, task: t.taskId },
    });
    meta.turnId = start.turnId;
    meta.conversationId = start.conversationId;
    console.log(`[${short}] turn ${start.turnId} started (${idx + 1}/${tasks.length})`);

    // 4. poll to terminal
    const deadline = Date.now() + (CONFIG.turnTimeoutSec + 300) * 1000;
    let turn;
    for (;;) {
      await sleep(20_000);
      const detail = await api('GET', `/agents/${agent.id}/turns/${start.turnId}`, undefined, { allowError: true });
      turn = detail.turn ?? detail;
      if (turn.status && turn.status !== 'QUEUED' && turn.status !== 'RUNNING') break;
      if (Date.now() > deadline) {
        await api('POST', `/agents/${agent.id}/turns/${start.turnId}/cancel`, {}, { allowError: true });
        turn = { ...turn, status: 'CANCELLED', error: 'runner deadline exceeded' };
        break;
      }
    }
    meta.status = turn.status;
    meta.error = turn.error ?? null;
    meta.usage = turn.usage ?? null;
    meta.durationMs = turn.completedAt && turn.startedAt ? turn.completedAt - turn.startedAt : null;

    // 5. collect deliverable artifacts
    const arts = await api('GET', `/artifacts?agentId=${agent.id}&limit=50`);
    meta.artifacts = [];
    for (const a of arts.artifacts ?? []) {
      const dl = await api('GET', `/artifacts/${a.id}/download-url?expiresInSec=600`, undefined, { allowError: true });
      if (!dl?.url) continue;
      const res = await fetch(dl.url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const dest = join(outDir, 'deliverables', a.name.replace(/[/\\]+/g, '_'));
      writeFileSync(dest, buf);
      meta.artifacts.push({ id: a.id, name: a.name, sizeBytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
    }

    // 5.5 capture transcript for the reward-hacking audit BEFORE the agent
    // (and its rows) can be deleted.
    const detail = await api('GET', `/agents/${agent.id}/turns/${start.turnId}`, undefined, { allowError: true });
    const events = await api('GET', `/events?agentId=${agent.id}&limit=500`, undefined, { allowError: true });
    writeFileSync(join(outDir, 'transcript.json'), JSON.stringify({
      messages: detail?.messages ?? [],
      events: events?.events ?? [],
    }, null, 1));

    // 6. T0 validation
    const expected = row.deliverable_files.map((f) => f.split('/').pop());
    const got = meta.artifacts.map((a) => a.name);
    const refHashes = new Set(readdirSync(join(refDir, 'reference')).map((f) =>
      createHash('sha256').update(readFileSync(join(refDir, 'reference', f))).digest('hex')));
    const regurgitated = meta.artifacts.filter((a) => refHashes.has(a.sha256)).map((a) => a.name);
    const missing = expected.filter((e) => {
      const base = e.replace(/\.[^.]+$/, '').toLowerCase();
      return !got.some((g) => g.replace(/\.[^.]+$/, '').toLowerCase() === base);
    });
    const empty = meta.artifacts.filter((a) => a.sizeBytes === 0).map((a) => a.name);
    meta.t0 = {
      expected, got, missing, empty, regurgitated,
      pass: meta.status === 'COMPLETED' && missing.length === 0 && empty.length === 0 && regurgitated.length === 0,
    };
    console.log(`[${short}] ${meta.status} t0=${meta.t0.pass ? 'PASS' : 'FAIL'} artifacts=${got.length} tokens=${meta.usage?.totalTokens ?? '?'}${missing.length ? ` missing=${missing.join(',')}` : ''}`);
  } finally {
    if (!args.has('keep-agents')) {
      await api('DELETE', `/agents/${meta.agentId}`, undefined, { allowError: true });
    }
    meta.finishedAtIso = new Date().toISOString();
    writeFileSync(metaPath, JSON.stringify(meta, null, 1));
  }
  return meta;
}

const results = await mapLimit(tasks, CONFIG.concurrency, async (t, i) => {
  try {
    let r = await runTask(t, i);
    if (r.status !== 'COMPLETED') {
      console.log(`[${t.taskId.slice(0, 8)}] retrying once (status ${r.status})`);
      r = await runTask(t, i);
    }
    return r;
  } catch (err) {
    console.error(`[${t.taskId.slice(0, 8)}] RUNNER ERROR: ${err.message}`);
    return { taskId: t.taskId, status: 'RUNNER_ERROR', error: err.message };
  }
});

const done = results.filter((r) => r.status === 'COMPLETED').length;
const t0pass = results.filter((r) => r.t0?.pass).length;
console.log(`\ncampaign ${cellName}: ${results.length} tasks, ${done} completed, ${t0pass} t0-pass`);
writeFileSync(join(resultsDir, 'campaign.json'), JSON.stringify({ cell: cellName, at: new Date().toISOString(), results }, null, 1));
