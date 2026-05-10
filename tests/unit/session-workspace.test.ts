import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getSessionDir,
  getSessionWorkspacePath,
  getConversationDir,
  getConversationWorkspacePath,
  copyBaseToSession,
  ensureConversationWorkspace,
  cleanupSession,
} from '../../packages/ctxmill/src/workspace/session-workspace.js';

async function writeTestFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

describe('session-workspace', () => {
  let tempDir: string;
  let dataDir: string;
  let baseWorkspaceDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'session-ws-test-'));
    dataDir = join(tempDir, '.ctxmill');
    baseWorkspaceDir = join(tempDir, 'base', 'workspace');
    await fs.mkdir(baseWorkspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('getSessionDir() returns correct path', () => {
    expect(getSessionDir(dataDir, 'agent-1', 'session-1')).toBe(
      resolve(join(dataDir, 'agents', 'agent-1', 'sessions', 'session-1')),
    );
  });

  it('getSessionWorkspacePath() returns correct path', () => {
    expect(getSessionWorkspacePath(dataDir, 'agent-1', 'session-1')).toBe(
      resolve(join(dataDir, 'agents', 'agent-1', 'sessions', 'session-1', 'workspace')),
    );
  });

  it('getConversationDir() returns correct path', () => {
    expect(getConversationDir(dataDir, 'agent-1', 'conversation-1')).toBe(
      resolve(join(dataDir, 'agents', 'agent-1', 'conversations', 'conversation-1')),
    );
  });

  it('getConversationWorkspacePath() returns correct path', () => {
    expect(getConversationWorkspacePath(dataDir, 'agent-1', 'conversation-1')).toBe(
      resolve(join(dataDir, 'agents', 'agent-1', 'conversations', 'conversation-1', 'workspace')),
    );
  });

  it('copyBaseToSession() copies all files recursively', async () => {
    await writeTestFile(join(baseWorkspaceDir, 'root.txt'), 'root');
    await writeTestFile(join(baseWorkspaceDir, 'nested', 'child.txt'), 'child');
    const sessionDir = getSessionDir(dataDir, 'agent-1', 'session-1');

    await copyBaseToSession(baseWorkspaceDir, sessionDir);

    await expect(readText(join(sessionDir, 'workspace', 'root.txt'))).resolves.toBe('root');
    await expect(readText(join(sessionDir, 'workspace', 'nested', 'child.txt'))).resolves.toBe('child');
  });

  it('copyBaseToSession() creates target directories', async () => {
    const sessionDir = getSessionDir(dataDir, 'agent-1', 'session-1');

    await copyBaseToSession(baseWorkspaceDir, sessionDir);

    await expect(fs.stat(join(sessionDir, 'workspace'))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it('copyBaseToSession() preserves nested directory structure', async () => {
    await writeTestFile(join(baseWorkspaceDir, 'a', 'b', 'c', 'deep.txt'), 'deep');
    const sessionDir = getSessionDir(dataDir, 'agent-1', 'session-1');

    await copyBaseToSession(baseWorkspaceDir, sessionDir);

    await expect(readText(join(sessionDir, 'workspace', 'a', 'b', 'c', 'deep.txt'))).resolves.toBe('deep');
  });

  it('copyBaseToSession() handles empty base workspace', async () => {
    const sessionDir = getSessionDir(dataDir, 'agent-1', 'session-1');

    await copyBaseToSession(baseWorkspaceDir, sessionDir);

    await expect(fs.readdir(join(sessionDir, 'workspace'))).resolves.toEqual([]);
  });

  it('ensureConversationWorkspace() initializes a new conversation workspace from base', async () => {
    await writeTestFile(join(baseWorkspaceDir, 'root.txt'), 'root');
    const conversationDir = getConversationDir(dataDir, 'agent-1', 'conversation-1');

    const result = await ensureConversationWorkspace(baseWorkspaceDir, conversationDir);

    expect(result).toEqual({
      workspaceDir: join(conversationDir, 'workspace'),
      created: true,
    });
    await expect(readText(join(result.workspaceDir, 'root.txt'))).resolves.toBe('root');
  });

  it('ensureConversationWorkspace() reuses existing conversation workspace without recopying base', async () => {
    await writeTestFile(join(baseWorkspaceDir, 'root.txt'), 'base');
    const conversationDir = getConversationDir(dataDir, 'agent-1', 'conversation-1');
    const first = await ensureConversationWorkspace(baseWorkspaceDir, conversationDir);
    await writeTestFile(join(first.workspaceDir, 'root.txt'), 'runtime edit');
    await writeTestFile(join(first.workspaceDir, 'runtime-only.txt'), 'kept');
    await writeTestFile(join(baseWorkspaceDir, 'new-base.txt'), 'new base file');

    const second = await ensureConversationWorkspace(baseWorkspaceDir, conversationDir);

    expect(second).toEqual({
      workspaceDir: first.workspaceDir,
      created: false,
    });
    await expect(readText(join(second.workspaceDir, 'root.txt'))).resolves.toBe('runtime edit');
    await expect(readText(join(second.workspaceDir, 'runtime-only.txt'))).resolves.toBe('kept');
    await expect(fs.access(join(second.workspaceDir, 'new-base.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleanupSession() removes session directory', async () => {
    const sessionDir = getSessionDir(dataDir, 'agent-1', 'session-1');
    await fs.mkdir(join(sessionDir, 'workspace'), { recursive: true });
    await writeTestFile(join(sessionDir, 'workspace', 'file.txt'), 'value');

    await cleanupSession(sessionDir);

    await expect(fs.access(sessionDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleanupSession() is idempotent (no error if missing)', async () => {
    const sessionDir = getSessionDir(dataDir, 'agent-1', 'session-1');

    await expect(cleanupSession(sessionDir)).resolves.toBeUndefined();
    await expect(cleanupSession(sessionDir)).resolves.toBeUndefined();
  });
});
