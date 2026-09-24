import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareWorkspace } from '../../packages/stablehand/src/sandbox/workspace-preparation.js';

describe('prepareWorkspace', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'wps-test-'));
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

      await prepareWorkspace({
        workspaceDir,
        projectDir,
        workspaceContent: { files: [{ src: 'data/config.json', dest: 'config.json' }] },
      }, { debug: () => {} });

      const content = await fs.readFile(join(workspaceDir, 'config.json'), 'utf-8');
      expect(content).toBe('{"key":"val"}');
    });

    it('creates nested destination directories', async () => {
      const projectDir = join(tempDir, 'project');
      const workspaceDir = join(tempDir, 'workspace');
      await fs.mkdir(projectDir, { recursive: true });
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(join(projectDir, 'f.txt'), 'hello');

      await prepareWorkspace({
        workspaceDir,
        projectDir,
        workspaceContent: { files: [{ src: 'f.txt', dest: 'deep/nested/f.txt' }] },
      }, { debug: () => {} });

      const content = await fs.readFile(join(workspaceDir, 'deep', 'nested', 'f.txt'), 'utf-8');
      expect(content).toBe('hello');
    });

    it('does nothing when no files declared', async () => {
      const workspaceDir = join(tempDir, 'workspace');
      await fs.mkdir(workspaceDir, { recursive: true });

      await prepareWorkspace({ workspaceDir, workspaceContent: {} }, { debug: () => {} });

      const entries = await fs.readdir(workspaceDir);
      expect(entries).toHaveLength(0);
    });

    it('does nothing when workspaceContent is undefined', async () => {
      const workspaceDir = join(tempDir, 'workspace');
      await fs.mkdir(workspaceDir, { recursive: true });

      await prepareWorkspace({ workspaceDir }, { debug: () => {} });

      const entries = await fs.readdir(workspaceDir);
      expect(entries).toHaveLength(0);
    });
  });
});
