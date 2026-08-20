// Tiny static server + verdict recorder for the review gallery.
//   node gallery/serve.mjs [port]
// Serves gallery/ (index, site/, pdf/) plus originals mapped under /orig/,
// and appends POST /verdict bodies to gallery/verdicts.jsonl.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, appendFileSync } from 'node:fs';
import { join, normalize, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const G = dirname(fileURLToPath(import.meta.url));
const EXT = join(G, '..');
const PORT = Number(process.argv[2] ?? 8477);
const CELLS = new Set(['lg-terra', 'lg-luna', 'pi-terra', 'pi-luna', 'claude-sonnet5', 'gold']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf', '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function send(res, code, body, type = 'text/plain') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}
function serveFile(res, path) {
  if (!existsSync(path) || !statSync(path).isFile()) return send(res, 404, 'not found');
  res.writeHead(200, { 'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream' });
  createReadStream(path).pipe(res);
}

createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (req.method === 'POST' && url === '/verdict') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy(); });
    req.on('end', () => {
      try {
        const v = JSON.parse(body);
        if (!v.taskId || !CELLS.has(v.cell)) return send(res, 400, 'bad verdict');
        appendFileSync(join(G, 'verdicts.jsonl'), JSON.stringify(v) + '\n');
        send(res, 200, 'ok');
      } catch { send(res, 400, 'bad json'); }
    });
    return;
  }
  const clean = normalize(url).replace(/^(\.\.[/\\])+/, '');
  if (clean === '/' || clean === '/index.html') return serveFile(res, join(G, 'index.html'));
  if (clean.startsWith('/site/') || clean.startsWith('/pdf/')) return serveFile(res, join(G, clean));
  if (clean.startsWith('/orig/')) {
    const [, , taskId, cell, ...rest] = clean.split('/');
    if (!CELLS.has(cell) || !/^[0-9a-f-]{36}$/.test(taskId ?? '')) return send(res, 404, 'not found');
    const base = cell === 'gold' ? join(EXT, 'cache', 'gold', taskId) : join(EXT, 'results', cell, taskId, 'deliverables');
    return serveFile(res, join(base, rest.join('/')));
  }
  send(res, 404, 'not found');
}).listen(PORT, '0.0.0.0', () => console.log(`review gallery on http://0.0.0.0:${PORT}`));
