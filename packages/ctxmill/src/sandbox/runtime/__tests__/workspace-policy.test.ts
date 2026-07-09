import { describe, expect, it } from 'vitest';
import * as tar from 'tar-stream';
import {
  assertSafeWorkspaceArchiveEntry,
  isSafeWorkspaceRelativePath,
  shouldIncludeWorkspacePath,
  shouldIncludeWorkspaceRelativePath,
  uniqueWorkspacePaths,
  validateWorkspaceArchive,
  validateWorkspaceDeletedPaths,
  workspaceRelativePath,
  WORKSPACE_ROOT,
} from '../workspace-policy.js';

async function createArchive(entries: Array<{
  name: string;
  type?: 'file' | 'directory' | 'symlink' | 'link';
  data?: string;
  linkname?: string;
}>): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    pack.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);
  });

  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    pack.entry({
      name: entry.name,
      type: entry.type ?? 'file',
      size: entry.type === 'directory' ? 0 : data.length,
      linkname: entry.linkname,
    }, entry.type === 'directory' ? undefined : data);
  }

  pack.finalize();
  return done;
}

describe('workspace runtime policy', () => {
  it('maps absolute container paths to safe workspace-relative paths', () => {
    expect(WORKSPACE_ROOT).toBe('/workspace');
    expect(workspaceRelativePath('/workspace/file.txt')).toBe('file.txt');
    expect(workspaceRelativePath('/workspace/dir/file.txt')).toBe('dir/file.txt');
    expect(workspaceRelativePath('/workspace')).toBeNull();
    expect(workspaceRelativePath('/tmp/file.txt')).toBeNull();
    expect(workspaceRelativePath('/workspace/../outside.txt')).toBeNull();
    expect(workspaceRelativePath('/workspace/dir/./file.txt')).toBeNull();
  });

  it('applies one exclusion policy to absolute and relative workspace paths', () => {
    expect(shouldIncludeWorkspacePath('/workspace/src/index.ts')).toBe(true);
    expect(shouldIncludeWorkspacePath('/workspace/node_modules/pkg/index.js')).toBe(false);
    expect(shouldIncludeWorkspacePath('/workspace/subdir/.cache/result.json')).toBe(false);
    expect(shouldIncludeWorkspacePath('/etc/hosts')).toBe(false);

    expect(shouldIncludeWorkspaceRelativePath('src/index.ts')).toBe(true);
    expect(shouldIncludeWorkspaceRelativePath('src/.npm/cache.json')).toBe(false);
    expect(shouldIncludeWorkspaceRelativePath('../outside.txt')).toBe(false);
  });

  it('validates safe relative paths and preserves first-seen uniqueness', () => {
    expect(isSafeWorkspaceRelativePath('dir/file.txt')).toBe(true);
    expect(isSafeWorkspaceRelativePath('')).toBe(false);
    expect(isSafeWorkspaceRelativePath('/absolute.txt')).toBe(false);
    expect(isSafeWorkspaceRelativePath('dir//file.txt')).toBe(false);
    expect(isSafeWorkspaceRelativePath('dir/../file.txt')).toBe(false);
    expect(isSafeWorkspaceRelativePath('nul\0byte.txt')).toBe(false);
    expect(uniqueWorkspacePaths(['a.txt', 'b.txt', 'a.txt'])).toEqual(['a.txt', 'b.txt']);
  });

  it('accepts only safe archive entries for restore', async () => {
    const safeArchive = await createArchive([
      { name: './dir/', type: 'directory' },
      { name: './dir/file.txt', data: 'ok' },
    ]);
    await expect(validateWorkspaceArchive(safeArchive)).resolves.toBeUndefined();
    expect(assertSafeWorkspaceArchiveEntry({ name: './dir/file.txt', type: 'file' })).toBe('dir/file.txt');

    const escapeArchive = await createArchive([{ name: '../outside.txt', data: 'escape' }]);
    await expect(validateWorkspaceArchive(escapeArchive)).rejects.toThrow(/unsafe path/);

    const symlinkArchive = await createArchive([
      { name: 'link', type: 'symlink', linkname: 'target' },
    ]);
    await expect(validateWorkspaceArchive(symlinkArchive)).rejects.toThrow(/symlink entry/);
  });

  it('rejects unsafe deletion tombstones before restore', () => {
    expect(() => validateWorkspaceDeletedPaths(['deleted.txt', 'dir/removed.txt'])).not.toThrow();
    expect(() => validateWorkspaceDeletedPaths(['../outside.txt'])).toThrow(/unsafe deleted path/);
  });
});
