// Download reference files (agent inputs) and gold deliverables (grader-only)
// for every slice task into cache/. Gold files live under cache/gold/ and must
// NEVER be seeded into an agent workspace.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DIR, loadSlice, loadRows, mapLimit } from './lib.mjs';

const slice = loadSlice();
const rows = loadRows();
const cacheDir = join(EXT_DIR, 'cache');

async function download(url, dest) {
  if (existsSync(dest)) return 'cached';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return `${(buf.length / 1024).toFixed(0)}KB`;
}

let refCount = 0, goldCount = 0;
await mapLimit(slice.tasks, 6, async (t) => {
  const row = rows.get(t.taskId);
  if (!row) throw new Error(`row missing for ${t.taskId}`);
  const refDir = join(cacheDir, 'tasks', t.taskId, 'reference');
  const goldDir = join(cacheDir, 'gold', t.taskId);
  mkdirSync(refDir, { recursive: true });
  mkdirSync(goldDir, { recursive: true });
  for (let i = 0; i < (row.reference_file_urls ?? []).length; i++) {
    const name = row.reference_files[i].split('/').pop();
    await download(row.reference_file_urls[i], join(refDir, name));
    refCount++;
  }
  for (let i = 0; i < (row.deliverable_file_urls ?? []).length; i++) {
    const name = row.deliverable_files[i].split('/').pop();
    await download(row.deliverable_file_urls[i], join(goldDir, name));
    goldCount++;
  }
});
console.log(`done: ${slice.tasks.length} tasks, ${refCount} reference files, ${goldCount} gold files (gold is grader-only)`);
