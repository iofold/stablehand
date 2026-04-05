import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspacePreparationService } from '../../packages/ctxmill/src/sandbox/workspace-preparation.js';

describe('WorkspacePreparationService', () => {
  let tempDir: string;
  let wps: WorkspacePreparationService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'wps-test-'));
    wps = new WorkspacePreparationService({ logger: { debug: () => {} } });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('copyExplicitFiles', () => {
    it('copies files from projectDir to workspaceDir', async () => {
      const projectDir = join(tempDir, 'project');
      const workspaceDir = join(tempDir, 'workspace');
      await fs.mkdir(join(projectDir, 'data'), { recursive: true });
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(join(projectDir, 'data', 'config.json'), '{"key":"val"}');

      await wps.prepare({
        workspaceDir,
        projectDir,
        workspaceContent: { files: [{ src: 'data/config.json', dest: 'config.json' }] },
      });

      const content = await fs.readFile(join(workspaceDir, 'config.json'), 'utf-8');
      expect(content).toBe('{"key":"val"}');
    });

    it('creates nested destination directories', async () => {
      const projectDir = join(tempDir, 'project');
      const workspaceDir = join(tempDir, 'workspace');
      await fs.mkdir(projectDir, { recursive: true });
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(join(projectDir, 'f.txt'), 'hello');

      await wps.prepare({
        workspaceDir,
        projectDir,
        workspaceContent: { files: [{ src: 'f.txt', dest: 'deep/nested/f.txt' }] },
      });

      const content = await fs.readFile(join(workspaceDir, 'deep', 'nested', 'f.txt'), 'utf-8');
      expect(content).toBe('hello');
    });

    it('does nothing when no files declared', async () => {
      const workspaceDir = join(tempDir, 'workspace');
      await fs.mkdir(workspaceDir, { recursive: true });

      await wps.prepare({ workspaceDir, workspaceContent: {} });

      const entries = await fs.readdir(workspaceDir);
      expect(entries).toHaveLength(0);
    });

    it('does nothing when workspaceContent is undefined', async () => {
      const workspaceDir = join(tempDir, 'workspace');
      await fs.mkdir(workspaceDir, { recursive: true });

      await wps.prepare({ workspaceDir });

      const entries = await fs.readdir(workspaceDir);
      expect(entries).toHaveLength(0);
    });
  });
});
