// Generate the static review gallery: index.html + one page per task.
// Reads slice rows, grades, metas, and the pre-converted PDFs under gallery/pdf/.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const G = dirname(fileURLToPath(import.meta.url));
const EXT = join(G, '..');
const CELLS = ['lg-terra', 'lg-luna', 'pi-terra', 'pi-luna', 'claude-sonnet5'];
const CELL_LABEL = {
  'lg-terra': 'langgraph · terra', 'lg-luna': 'langgraph · luna',
  'pi-terra': 'pi-agent · terra', 'pi-luna': 'pi-agent · luna',
  'claude-sonnet5': 'claude-agents · sonnet-5',
};

const rows = new Map(JSON.parse(readFileSync(join(EXT, 'slice', 'all_rows.json'), 'utf8')).map(r => [r.task_id, r]));
const slice = JSON.parse(readFileSync(join(EXT, 'slice', 'slice.json'), 'utf8'));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
:root{--bg:#FAFAF7;--surface:#fff;--ink:#1A2321;--ink2:#5A6663;--line:#E3E7E3;--accent:#0F6B62;--accent-soft:#DDEBE8;--bad:#A03C32;--bad-bg:#F7E7E4;--good-bg:#E2F0EC}
@media (prefers-color-scheme: dark){:root:not([data-theme=light]){--bg:#101514;--surface:#171D1C;--ink:#E8ECEA;--ink2:#9FAAA6;--line:#28302E;--accent:#4FD1C0;--accent-soft:#1C3531;--bad:#E08A80;--bad-bg:#33211E;--good-bg:#1C3531}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
a{color:var(--accent)}.wrap{max-width:none;padding:20px 24px}
h1{font-size:1.5rem;margin:.2em 0}h2{font-size:1.05rem;margin:0 0 8px}
.mono{font-family:ui-monospace,monospace;font-size:.85em}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th{font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:var(--ink2);text-align:left;padding:7px 9px;border-bottom:1px solid var(--line)}
td{padding:8px 9px;border-bottom:1px solid var(--line)}
tr:hover td{background:var(--accent-soft)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:14px 16px;margin:12px 0}
.cols{display:flex;gap:12px;overflow-x:auto;align-items:flex-start}
.col{flex:0 0 460px;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:10px}
.col.gold{border-color:var(--accent)}
.col h3{margin:2px 0 6px;font-size:.95rem;display:flex;justify-content:space-between;align-items:baseline}
.score{font-family:ui-monospace,monospace;font-size:.85rem;color:var(--accent)}
object.pdf,iframe.pdf{width:100%;height:72vh;border:1px solid var(--line);border-radius:4px;background:#fff}
details{margin:8px 0}summary{cursor:pointer;color:var(--ink2)}
.fail{background:var(--bad-bg);border-radius:4px;padding:3px 7px;margin:3px 0;font-size:.82rem}
.pass-count{color:var(--ink2);font-size:.8rem}
.reason{font-size:.85rem;color:var(--ink2);border-left:3px solid var(--line);padding-left:9px;margin:8px 0}
.verdict{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.verdict button{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:4px;padding:5px 10px;cursor:pointer;font-size:.8rem}
.verdict button.sel{background:var(--accent);color:#fff;border-color:var(--accent)}
.spread-hi{color:var(--bad);font-weight:600}
.prompt{white-space:pre-wrap;max-height:260px;overflow-y:auto;font-size:.9rem;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:12px 14px}
.nav{display:flex;gap:14px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.dl{font-size:.8rem}
`;

function loadTask(taskId) {
  const per = {};
  for (const c of CELLS) {
    const gp = join(EXT, 'results', c, taskId, 'grades.json');
    const mp = join(EXT, 'results', c, taskId, 'meta.json');
    per[c] = {
      grade: existsSync(gp) ? JSON.parse(readFileSync(gp, 'utf8')) : null,
      meta: existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : null,
    };
  }
  return per;
}

function pdfsFor(taskId, sub) {
  const d = join(G, 'pdf', taskId, sub);
  return existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.pdf')) : [];
}
function origFiles(taskId, cell) {
  const d = cell === 'gold' ? join(EXT, 'cache', 'gold', taskId) : join(EXT, 'results', cell, taskId, 'deliverables');
  return existsSync(d) ? readdirSync(d) : [];
}

mkdirSync(join(G, 'site'), { recursive: true });
const tasks = [];
for (const t of slice.tasks) {
  const row = rows.get(t.taskId);
  const per = loadTask(t.taskId);
  const scores = CELLS.map(c => (per[c].grade?.rubricScore?.pct ?? 0));
  const spread = Math.max(...scores) - Math.min(...scores);
  tasks.push({ ...t, row, per, scores, spread });
}
tasks.sort((a, b) => b.spread - a.spread);

// ---- per-task pages ----
for (const t of tasks) {
  const rubricItems = JSON.parse(t.row.rubric_json);
  const critById = new Map(rubricItems.map(r => [r.rubric_item_id, r]));
  const cols = [];

  const goldPdfs = pdfsFor(t.taskId, 'gold');
  cols.push(`<div class="col gold"><h3>EXPERT GOLD <span class="score">reference</span></h3>
    ${goldPdfs.map(f => `<object class="pdf" data="../pdf/${t.taskId}/gold/${encodeURIComponent(f)}" type="application/pdf"><a href="../pdf/${t.taskId}/gold/${encodeURIComponent(f)}">${esc(f)}</a></object>`).join('')}
    <div class="dl">${origFiles(t.taskId, 'gold').map(f => `<a href="../orig/${t.taskId}/gold/${encodeURIComponent(f)}" download>${esc(f)}</a>`).join(' · ')}</div>
  </div>`);

  for (const c of CELLS) {
    const g = t.per[c].grade;
    const pct = g?.rubricScore?.pct;
    const pdfs = pdfsFor(t.taskId, c);
    const detail = g?.rubricDetail ?? {};
    const fails = Object.entries(detail).filter(([, v]) => !v.met && v.score > 0);
    const passes = Object.entries(detail).filter(([, v]) => v.met).length;
    const reason = (g?.pairwise?.votes ?? [])[0];
    cols.push(`<div class="col"><h3>${esc(CELL_LABEL[c])} <span class="score">${pct != null ? (pct * 100).toFixed(0) + '%' : 'n/a'}</span></h3>
      ${pdfs.map(f => `<object class="pdf" data="../pdf/${t.taskId}/${c}/${encodeURIComponent(f)}" type="application/pdf"><a href="../pdf/${t.taskId}/${c}/${encodeURIComponent(f)}">${esc(f)}</a></object>`).join('') || '<p class="mono">no deliverable</p>'}
      <div class="dl">${origFiles(t.taskId, c).map(f => `<a href="../orig/${t.taskId}/${c}/${encodeURIComponent(f)}" download>${esc(f)}</a>`).join(' · ')}</div>
      <details ${fails.length ? 'open' : ''}><summary>Rubric: <span class="pass-count">${passes}/${Object.keys(detail).length} met</span></summary>
        ${fails.map(([id, v]) => `<div class="fail">[-${v.score}] ${esc(critById.get(id)?.criterion ?? id)}</div>`).join('') || '<div class="pass-count">all positive items met</div>'}
      </details>
      ${reason ? `<div class="reason"><b>judge (${esc(reason.winner)})</b>: ${esc(reason.reason)}</div>` : ''}
      <div class="verdict" data-task="${t.taskId}" data-cell="${c}">
        <button data-v="better">better than gold</button><button data-v="par">on par</button><button data-v="worse">worse</button>
      </div>
    </div>`);
  }

  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.taskId.slice(0, 8)} · GDPval review</title><style>${CSS}</style>
<div class="wrap">
<div class="nav"><a href="../index.html">← index</a><span class="mono">${t.taskId}</span><span>${esc(t.sector)} · ${esc(t.occupation)}</span><span class="mono ${t.spread > .3 ? 'spread-hi' : ''}">spread ${(t.spread * 100).toFixed(0)}pts</span></div>
<details open><summary><b>Assignment</b></summary><div class="prompt">${esc(t.row.prompt)}</div></details>
<details><summary><b>Rubric</b> (${rubricItems.length} items)</summary><div class="prompt">${esc(t.row.rubric_pretty)}</div></details>
<div class="cols">${cols.join('')}</div>
</div>
<script>
document.querySelectorAll('.verdict button').forEach(b=>b.addEventListener('click',async()=>{
  const w=b.parentElement;const note=prompt('Optional note (Enter to skip):')||'';
  const r=await fetch('/verdict',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({taskId:w.dataset.task,cell:w.dataset.cell,verdict:b.dataset.v,note,at:new Date().toISOString()})});
  if(r.ok){w.querySelectorAll('button').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');}
  else alert('save failed');
}));
</script>`;
  writeFileSync(join(G, 'site', `${t.taskId}.html`), html);
}

// ---- index ----
const rowsHtml = tasks.map(t => `<tr onclick="location='site/${t.taskId}.html'" style="cursor:pointer">
  <td class="mono">${t.taskId.slice(0, 8)}</td><td>${esc(t.category)}</td><td>${esc(t.occupation)}</td>
  <td class="mono ${t.spread > .3 ? 'spread-hi' : ''}">${(t.spread * 100).toFixed(0)}</td>
  ${t.scores.map(s => `<td class="mono">${(s * 100).toFixed(0)}</td>`).join('')}
</tr>`).join('');
writeFileSync(join(G, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GDPval Review Gallery</title><style>${CSS}</style>
<div class="wrap"><h1>GDPval Review Gallery</h1>
<p>60 tasks · expert gold vs 5 harness cells, sorted by cross-cell score spread (most interesting first). Click a row. Your verdicts save to <span class="mono">gallery/verdicts.jsonl</span>.</p>
<div class="card"><table><tr><th>task</th><th>category</th><th>occupation</th><th>spread</th>${CELLS.map(c => `<th>${CELL_LABEL[c]}</th>`).join('')}</tr>${rowsHtml}</table></div></div>`);
console.log(`built index + ${tasks.length} task pages`);
