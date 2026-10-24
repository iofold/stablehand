import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withDirectoryFile, withWorkspaceDirectory, withWorkspaceFile, workspaceEntryMetadata } from '../safe-file-access.js';

describe.runIf(process.platform === 'linux')('pinned workspace file access', () => {
  let fixture: string;
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
    fixture = await mkdtemp(join(process.cwd(), '.tmp', 'safe-workspace-'));
    workspace = join(fixture, 'workspace');
    outside = join(fixture, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(outside, 'file.txt'), 'SYNTHETIC-HOST-SECRET');
  });

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  it('keeps an opened directory pinned when its pathname becomes an external symlink', async () => {
    const original = join(workspace, 'nested');
    const moved = join(workspace, 'moved');
    await mkdir(original);
    await writeFile(join(original, 'file.txt'), 'inside');
    await withWorkspaceDirectory(workspace, original, false, async (directory) => {
      await rename(original, moved);
      await symlink(outside, original);
      await withDirectoryFile(directory, 'file.txt', { writable: true }, async (file) => {
        await file.truncate(0);
        await file.writeFile('pinned');
      });
    });
    expect(await readFile(join(moved, 'file.txt'), 'utf8')).toBe('pinned');
    expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('SYNTHETIC-HOST-SECRET');
    await expect(withWorkspaceFile(workspace, join(original, 'file.txt'), {}, (file) => file.readFile('utf8'))).rejects.toThrow();
  });

  it('keeps the opened file pinned when an attacker swaps its leaf for a symlink', async () => {
    const original = join(workspace, 'file.txt');
    const moved = join(workspace, 'moved.txt');
    await writeFile(original, 'inside');
    await withWorkspaceFile(workspace, original, { writable: true }, async (file) => {
      await rename(original, moved);
      await symlink(join(outside, 'file.txt'), original);
      await file.truncate(0);
      await file.writeFile('pinned');
    });
    expect(await readFile(moved, 'utf8')).toBe('pinned');
    expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('SYNTHETIC-HOST-SECRET');
  });

  it('rejects a symlink used as the configured workspace root', async () => {
    const alias = join(fixture, 'alias');
    await symlink(outside, alias);
    await expect(withWorkspaceFile(alias, join(alias, 'file.txt'), {}, (file) => file.readFile('utf8'))).rejects.toThrow();
  });

  it('creates missing workspace and nested parents without following symlinks', async () => {
    const missing = join(fixture, 'new-workspace');
    const target = join(missing, 'one', 'two', 'file.txt');
    await withWorkspaceFile(missing, target, { writable: true, create: true, createParents: true }, (file) => file.writeFile('created'));
    expect(await readFile(target, 'utf8')).toBe('created');
  });

  it('rejects nonregular files without blocking on a FIFO', async () => {
    const fifo = join(workspace, 'pipe');
    await promisify(execFile)('mkfifo', [fifo]);
    await expect(withWorkspaceFile(workspace, fifo, {}, (file) => file.readFile('utf8'))).rejects.toThrow('regular file');
    await withWorkspaceDirectory(workspace, workspace, false, async (directory) => {
      expect(await workspaceEntryMetadata(directory, 'pipe')).toBeNull();
    });
  });

  it('closes directory and leaf handles when an operation fails', async () => {
    await writeFile(join(workspace, 'file.txt'), 'inside');
    let directoryHandle: FileHandle | undefined;
    let leafHandle: FileHandle | undefined;
    await expect(withWorkspaceDirectory(workspace, workspace, false, async (directory) => {
      directoryHandle = directory;
      return withDirectoryFile(directory, 'file.txt', {}, async (file) => {
        leafHandle = file;
        throw new Error('synthetic failure');
      });
    })).rejects.toThrow('synthetic failure');
    expect(directoryHandle?.fd).toBe(-1);
    expect(leafHandle?.fd).toBe(-1);
  });
});
