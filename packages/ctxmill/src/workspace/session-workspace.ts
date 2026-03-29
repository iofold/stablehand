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

export function getSessionDir(dataDir: string, agentId: string, sessionId: string): string {
  return resolve(join(dataDir, 'agents', agentId, 'sessions', sessionId));
}

export function getSessionWorkspacePath(dataDir: string, agentId: string, sessionId: string): string {
  return resolve(join(dataDir, 'agents', agentId, 'sessions', sessionId, 'workspace'));
}

export async function copyBaseToSession(baseWorkspaceDir: string, sessionDir: string): Promise<void> {
  const workspaceDir = join(sessionDir, 'workspace');
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

export async function cleanupSession(sessionDir: string): Promise<void> {
  await fs.rm(sessionDir, { recursive: true, force: true });
}
