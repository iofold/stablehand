import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolContext } from '../../packages/ctxmill/src/tool/types.js';

import readFileTool from '../../packages/examples/finance-dashboard/tools/read-file.js';
import listDirectoryTool from '../../packages/examples/finance-dashboard/tools/list-directory.js';
import searchFilesTool from '../../packages/examples/finance-dashboard/tools/search-files.js';
import writeNoteTool from '../../packages/examples/finance-dashboard/tools/write-note.js';
import writeFileTool from '../../packages/examples/finance-dashboard/tools/write-file.js';

let workspaceDir: string;
let mockCtx: ToolContext;

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'file-tools-test-'));

  // Create workspace structure
  writeFileSync(join(workspaceDir, 'README.md'), '# Test Agent\nSome content here for searching.');
  mkdirSync(join(workspaceDir, 'data', 'nested'), { recursive: true });
  writeFileSync(
    join(workspaceDir, 'data', 'portfolio.json'),
    '{"holdings":[{"symbol":"AAPL"}]}',
  );
  writeFileSync(join(workspaceDir, 'data', 'nested', 'deep.txt'), 'deep content for search testing');
  mkdirSync(join(workspaceDir, 'notes'), { recursive: true });
  mkdirSync(join(workspaceDir, 'empty-dir'), { recursive: true });
  writeFileSync(join(workspaceDir, 'big-file.txt'), 'x'.repeat(15000));

  mockCtx = {
    agentId: 'test-agent-id',
    conversationId: 'test-run-id',
    workspaceDir,
    knowledge: {
      query: async () => ({ items: [] }),
    },
  };
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// read-file
// ---------------------------------------------------------------------------
describe('read-file', () => {
  it('reads an existing file', async () => {
    const result = await readFileTool.handler({ path: 'README.md' }, mockCtx);
    expect(result).toContain('Test Agent');
  });

  it('truncates files exceeding 10 000 chars', async () => {
    const result = await readFileTool.handler({ path: 'big-file.txt' }, mockCtx);
    expect(result).toContain('truncated');
    expect(result.length).toBeLessThan(15000);
  });

  it('rejects path traversal', async () => {
    const result = await readFileTool.handler({ path: '../../etc/passwd' }, mockCtx);
    expect(result.toLowerCase()).toMatch(/error|denied|outside/);
  });

  it('returns error for nonexistent file', async () => {
    const result = await readFileTool.handler({ path: 'nonexistent.txt' }, mockCtx);
    expect(result.toLowerCase()).toContain('error');
  });
});

// ---------------------------------------------------------------------------
// list-directory
// ---------------------------------------------------------------------------
describe('list-directory', () => {
  it('lists root directory entries', async () => {
    const result = await listDirectoryTool.handler({ path: '.' }, mockCtx);
    expect(result).toContain('README.md');
    expect(result).toContain('data');
    expect(result).toContain('notes');
  });

  it('lists nested data directory', async () => {
    const result = await listDirectoryTool.handler({ path: 'data' }, mockCtx);
    expect(result).toContain('portfolio.json');
    expect(result).toContain('nested');
  });

  it('filters dot-files', async () => {
    writeFileSync(join(workspaceDir, '.hidden'), 'secret');
    const result = await listDirectoryTool.handler({ path: '.' }, mockCtx);
    expect(result).not.toContain('.hidden');
  });

  it('returns empty message for an empty directory', async () => {
    const result = await listDirectoryTool.handler({ path: 'empty-dir' }, mockCtx);
    expect(result.toLowerCase()).toMatch(/empty/);
  });

  it('rejects path traversal', async () => {
    const result = await listDirectoryTool.handler({ path: '../../' }, mockCtx);
    expect(result.toLowerCase()).toMatch(/error|denied|outside/);
  });
});

// ---------------------------------------------------------------------------
// search-files
// ---------------------------------------------------------------------------
describe('search-files', () => {
  it('finds text matches across files', async () => {
    const result = await searchFilesTool.handler(
      { pattern: 'content', directory: '.', fileExtensions: undefined },
      mockCtx,
    );
    expect(result).toContain('matches');
    // Should match in README.md and deep.txt at minimum
    expect(result).toContain('README.md');
  });

  it('respects file extension filter', async () => {
    const result = await searchFilesTool.handler(
      { pattern: 'holdings', directory: '.', fileExtensions: ['.json'] },
      mockCtx,
    );
    expect(result).toContain('portfolio.json');
    expect(result).not.toContain('README.md');
  });

  it('returns no-matches message for unmatched pattern', async () => {
    const result = await searchFilesTool.handler(
      { pattern: 'zzzznotfound', directory: '.', fileExtensions: undefined },
      mockCtx,
    );
    expect(result).toContain('No matches found');
  });

  it('rejects path traversal in directory param', async () => {
    const result = await searchFilesTool.handler(
      { pattern: 'test', directory: '../../', fileExtensions: undefined },
      mockCtx,
    );
    expect(result.toLowerCase()).toMatch(/error|denied|outside/);
  });

  it('handles regex patterns', async () => {
    const result = await searchFilesTool.handler(
      { pattern: 'hold.*AAPL', directory: '.', fileExtensions: undefined },
      mockCtx,
    );
    expect(result).toContain('portfolio.json');
  });
});

// ---------------------------------------------------------------------------
// write-note
// ---------------------------------------------------------------------------
describe('write-note', () => {
  it('creates a file in notes/ directory', async () => {
    const result = await writeNoteTool.handler(
      { filename: 'test-note.md', content: 'Hello note' },
      mockCtx,
    );
    expect(result).toContain('Saved');
    expect(existsSync(join(workspaceDir, 'notes', 'test-note.md'))).toBe(true);
    expect(readFileSync(join(workspaceDir, 'notes', 'test-note.md'), 'utf-8')).toBe('Hello note');
  });

  it('creates notes/ directory if missing', async () => {
    // Remove and recreate workspace without notes/
    rmSync(join(workspaceDir, 'notes'), { recursive: true, force: true });
    expect(existsSync(join(workspaceDir, 'notes'))).toBe(false);

    const result = await writeNoteTool.handler(
      { filename: 'auto-created.md', content: 'auto' },
      mockCtx,
    );
    expect(result).toContain('Saved');
    expect(existsSync(join(workspaceDir, 'notes', 'auto-created.md'))).toBe(true);
  });

  it('rejects path traversal in filename', async () => {
    const result = await writeNoteTool.handler(
      { filename: '../../evil.txt', content: 'bad' },
      mockCtx,
    );
    expect(result.toLowerCase()).toMatch(/error|denied|outside|only/);
  });

  it('returns confirmation with char count', async () => {
    const content = 'a'.repeat(42);
    const result = await writeNoteTool.handler(
      { filename: 'counted.md', content },
      mockCtx,
    );
    expect(result).toContain('42');
  });
});

// ---------------------------------------------------------------------------
// write-file
// ---------------------------------------------------------------------------
describe('write-file', () => {
  it('creates a file in workspace root', async () => {
    const result = await writeFileTool.handler(
      { path: 'output.txt', content: 'hello world' },
      mockCtx,
    );
    expect(result).toContain('Wrote');
    expect(readFileSync(join(workspaceDir, 'output.txt'), 'utf-8')).toBe('hello world');
  });

  it('creates nested directories automatically', async () => {
    const result = await writeFileTool.handler(
      { path: 'new-dir/sub/file.txt', content: 'nested content' },
      mockCtx,
    );
    expect(result).toContain('Wrote');
    expect(readFileSync(join(workspaceDir, 'new-dir', 'sub', 'file.txt'), 'utf-8')).toBe(
      'nested content',
    );
  });

  it('rejects path traversal', async () => {
    const result = await writeFileTool.handler(
      { path: '../../etc/evil', content: 'bad' },
      mockCtx,
    );
    expect(result.toLowerCase()).toMatch(/error|traversal|outside/);
  });

  it('rejects blocked patterns', async () => {
    const cases = ['.env', 'credentials.json', 'server.key'];
    for (const p of cases) {
      const result = await writeFileTool.handler({ path: p, content: 'x' }, mockCtx);
      expect(result.toLowerCase()).toContain('not allowed');
    }
  });
});
