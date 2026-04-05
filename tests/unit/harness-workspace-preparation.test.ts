import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePreparationService } from '../../packages/ctxmill/src/sandbox/workspace-preparation.js';

describe('WorkspacePreparationService', () => {
  let rootDir: string;
  let projectDir: string;
  let workspaceDir: string;
  const logger = { debug: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    rootDir = await mkdtemp(join(tmpdir(), 'ctxmill-workspace-'));
    projectDir = join(rootDir, 'project');
    workspaceDir = join(rootDir, 'workspace');
    await mkdir(projectDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('copies explicit files and directories into the workspace', async () => {
    const service = new WorkspacePreparationService({ logger });
    await writeFile(join(projectDir, 'config.json'), '{"ok":true}', 'utf-8');
    await mkdir(join(projectDir, 'data'), { recursive: true });
    await writeFile(join(projectDir, 'data', 'notes.txt'), 'hello', 'utf-8');

    await service.prepare({
      workspaceDir,
      projectDir,
      workspaceContent: {
        files: [
          { src: 'config.json', dest: 'config.json' },
          { src: 'data', dest: 'copied-data' },
        ],
      },
    });

    await expect(readFile(join(workspaceDir, 'config.json'), 'utf-8')).resolves.toBe('{"ok":true}');
    await expect(readFile(join(workspaceDir, 'copied-data', 'notes.txt'), 'utf-8')).resolves.toBe('hello');
    expect(logger.debug).toHaveBeenCalledWith('Copied workspace content', { src: 'config.json', dest: 'config.json' });
    expect(logger.debug).toHaveBeenCalledWith('Copied workspace content', { src: 'data', dest: 'copied-data' });
  });
});
