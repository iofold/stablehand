import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getConversationDir,
  getConversationWorkspacePath,
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

  it('cleanupSession() removes a workspace directory', async () => {
    const conversationDir = getConversationDir(dataDir, 'agent-1', 'conversation-1');
    await fs.mkdir(join(conversationDir, 'workspace'), { recursive: true });
    await writeTestFile(join(conversationDir, 'workspace', 'file.txt'), 'value');

    await cleanupSession(conversationDir);

    await expect(fs.access(conversationDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleanupSession() is idempotent (no error if missing)', async () => {
    const conversationDir = getConversationDir(dataDir, 'agent-1', 'conversation-1');

    await expect(cleanupSession(conversationDir)).resolves.toBeUndefined();
    await expect(cleanupSession(conversationDir)).resolves.toBeUndefined();
  });
});
