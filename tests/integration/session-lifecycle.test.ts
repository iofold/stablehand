import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getSessionDir,
  getSessionWorkspacePath,
  copyBaseToSession,
  cleanupSession,
} from '../../packages/ctxmill/src/workspace/session-workspace.js';

describe('Session lifecycle', () => {
  let tempDir: string;
  let dataDir: string;
  let baseWorkspaceDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'ctxmill-session-lifecycle-'));
    dataDir = join(tempDir, '.ctxmill');
    baseWorkspaceDir = join(tempDir, 'agent-base');
    await fs.mkdir(baseWorkspaceDir, { recursive: true });
    await fs.writeFile(join(baseWorkspaceDir, 'shared.txt'), 'base');
    await fs.mkdir(join(baseWorkspaceDir, 'nested'), { recursive: true });
    await fs.writeFile(join(baseWorkspaceDir, 'nested', 'note.txt'), 'original');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('copies the base workspace into an isolated session workspace', async () => {
    const sessionDir = getSessionDir(dataDir, 'agent-1', 'session-1');

    await copyBaseToSession(baseWorkspaceDir, sessionDir);

    const sessionWorkspaceDir = getSessionWorkspacePath(dataDir, 'agent-1', 'session-1');
    await fs.writeFile(join(sessionWorkspaceDir, 'shared.txt'), 'session');
    await fs.writeFile(join(sessionWorkspaceDir, 'session-only.txt'), 'new');
    await fs.unlink(join(sessionWorkspaceDir, 'nested', 'note.txt'));

    await expect(fs.readFile(join(baseWorkspaceDir, 'shared.txt'), 'utf8')).resolves.toBe('base');
    await expect(fs.readFile(join(baseWorkspaceDir, 'nested', 'note.txt'), 'utf8')).resolves.toBe('original');
    await expect(fs.access(join(baseWorkspaceDir, 'session-only.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans up the session directory', async () => {
    const sessionDir = getSessionDir(dataDir, 'agent-1', 'session-2');

    await copyBaseToSession(baseWorkspaceDir, sessionDir);
    await cleanupSession(sessionDir);

    await expect(fs.access(sessionDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
