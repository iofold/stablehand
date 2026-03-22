import { mkdirSync, existsSync, renameSync, writeFileSync, readdirSync, chownSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Ensure agent workspace directory structure exists.
 * Handles migration from flat layout -> base/ layout.
 *
 * Old layout:  agents/{id}/workspace/, agents/{id}/skills/, agents/{id}/notes/
 * New layout:  agents/{id}/base/workspace/, agents/{id}/base/skills/, agents/{id}/base/notes/
 *              agents/{id}/sessions/
 *
 * Returns the base/workspace path (what workspaceDir stores in DB).
 */
export function ensureAgentWorkspace(dataDir: string, agentId: string): string {
  const agentDir = join(dataDir, 'agents', agentId);
  const baseDir = join(agentDir, 'base');
  const sessionsDir = join(agentDir, 'sessions');

  // Migration: if old flat layout exists, move into base/
  const oldWorkspace = join(agentDir, 'workspace');
  if (existsSync(oldWorkspace) && !existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
    renameSync(oldWorkspace, join(baseDir, 'workspace'));
    const oldSkills = join(agentDir, 'skills');
    const oldNotes = join(agentDir, 'notes');
    if (existsSync(oldSkills)) renameSync(oldSkills, join(baseDir, 'skills'));
    if (existsSync(oldNotes)) renameSync(oldNotes, join(baseDir, 'notes'));
  }

  // Ensure directories exist with ctxmill user ownership (UID 1000)
  for (const dir of [join(baseDir, 'workspace'), join(baseDir, 'skills'), join(baseDir, 'notes'), sessionsDir]) {
    mkdirSync(dir, { recursive: true });
    try { chownSync(dir, 1000, 1000); } catch { /* non-root orchestrator — skip chown */ }
  }

  return resolve(join(baseDir, 'workspace'));
}

/**
 * Seed an agent workspace with starter files if it is empty.
 * Idempotent — does nothing when files already exist.
 */
export function seedAgentWorkspace(workspaceDir: string): void {
  // Check if the workspace already contains any files (ignore directories)
  if (existsSync(workspaceDir)) {
    const entries = readdirSync(workspaceDir, { withFileTypes: true });
    const hasFiles = entries.some((e) => e.isFile());
    if (hasFiles) return;

    // Also check subdirectories for files
    const hasNestedFiles = entries
      .filter((e) => e.isDirectory())
      .some((dir) => {
        const children = readdirSync(join(workspaceDir, dir.name), { withFileTypes: true });
        return children.some((c) => c.isFile());
      });
    if (hasNestedFiles) return;
  }

  // Seed README
  const readmePath = join(workspaceDir, 'README.md');
  if (!existsSync(readmePath)) {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      readmePath,
      '# Agent Workspace\n\nThis is the agent workspace directory. Files created by the agent or uploaded by users are stored here.\n',
      'utf-8',
    );
  }

  // Seed sample portfolio data
  const dataDir = join(workspaceDir, 'data');
  const portfolioPath = join(dataDir, 'sample-portfolio.json');
  if (!existsSync(portfolioPath)) {
    mkdirSync(dataDir, { recursive: true });
    const portfolio = {
      portfolio: {
        name: 'Sample Portfolio',
        holdings: [
          { symbol: 'AAPL', shares: 100, avgCost: 150.0 },
          { symbol: 'GOOGL', shares: 50, avgCost: 2800.0 },
          { symbol: 'MSFT', shares: 75, avgCost: 300.0 },
        ],
        cash: 50000,
        lastUpdated: '2026-01-15',
      },
    };
    writeFileSync(portfolioPath, JSON.stringify(portfolio), 'utf-8');
  }

  chownRecursive(workspaceDir, 1000, 1000);
}

function chownRecursive(dir: string, uid: number, gid: number): void {
  try {
    chownSync(dir, uid, gid);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      chownSync(full, uid, gid);
      if (entry.isDirectory()) chownRecursive(full, uid, gid);
    }
  } catch { /* non-root process — skip chown */ }
}
