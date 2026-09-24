import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

async function chownRecursive(targetPath: string): Promise<void> {
  try {
    await fs.chown(targetPath, 1000, 1000);
  } catch { /* non-root process — skip chown */ }

  let names: string[];

  try {
    names = await fs.readdir(targetPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return;
    }

    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }

  for (const name of names) {
    await chownRecursive(join(targetPath, name));
  }
}

export function getConversationDir(dataDir: string, agentId: string, conversationId: string): string {
  return resolve(join(dataDir, 'agents', agentId, 'conversations', conversationId));
}

export function getConversationWorkspacePath(dataDir: string, agentId: string, conversationId: string): string {
  return resolve(join(dataDir, 'agents', agentId, 'conversations', conversationId, 'workspace'));
}

async function copyBaseIntoWorkspace(baseWorkspaceDir: string, workspaceDir: string): Promise<void> {
  await fs.mkdir(workspaceDir, { recursive: true });

  try {
    const entries = await fs.readdir(baseWorkspaceDir, { withFileTypes: true });

    for (const entry of entries) {
      await fs.cp(join(baseWorkspaceDir, entry.name), join(workspaceDir, entry.name), { recursive: true });
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await chownRecursive(workspaceDir);
}

export async function ensureConversationWorkspace(
  baseWorkspaceDir: string,
  conversationDir: string,
): Promise<{ workspaceDir: string; created: boolean }> {
  const workspaceDir = join(conversationDir, 'workspace');

  try {
    const existing = await fs.stat(workspaceDir);
    if (!existing.isDirectory()) {
      throw new Error(`Conversation workspace exists but is not a directory: ${workspaceDir}`);
    }
    return { workspaceDir, created: false };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await copyBaseIntoWorkspace(baseWorkspaceDir, workspaceDir);
  return { workspaceDir, created: true };
}

export async function cleanupSession(sessionDir: string): Promise<void> {
  await fs.rm(sessionDir, { recursive: true, force: true });
}
