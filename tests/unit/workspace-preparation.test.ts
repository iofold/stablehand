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

  describe('resolveSkillsPlaceholder', () => {
    it('replaces {{skills}} with concatenated SKILL.md instruction bodies', async () => {
      const workspaceDir = join(tempDir, 'workspace');
      const skillDir = join(workspaceDir, '.ctxmill', 'skills', 'test-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(join(skillDir, 'SKILL.md'), '---\nname: test-skill\n---\nDo something useful.');

      const result = await wps.resolveSkillsPlaceholder('Before {{skills}} after', workspaceDir);
      expect(result).toContain('Do something useful.');
      expect(result).toContain('Before');
      expect(result).toContain('after');
      expect(result).not.toContain('{{skills}}');
    });

    it('returns prompt unchanged when no {{skills}} placeholder', async () => {
      const result = await wps.resolveSkillsPlaceholder('No placeholder here', tempDir);
      expect(result).toBe('No placeholder here');
    });

    it('returns prompt with empty replacement when no skills seeded', async () => {
      const workspaceDir = join(tempDir, 'workspace');
      await fs.mkdir(workspaceDir, { recursive: true });

      const result = await wps.resolveSkillsPlaceholder('Before {{skills}} after', workspaceDir);
      expect(result).toBe('Before  after');
    });

    it('handles multiple skills', async () => {
      const workspaceDir = join(tempDir, 'workspace');
      const skillA = join(workspaceDir, '.ctxmill', 'skills', 'skill-a');
      const skillB = join(workspaceDir, '.ctxmill', 'skills', 'skill-b');
      await fs.mkdir(skillA, { recursive: true });
      await fs.mkdir(skillB, { recursive: true });
      await fs.writeFile(join(skillA, 'SKILL.md'), '---\nname: skill-a\n---\nFirst skill.');
      await fs.writeFile(join(skillB, 'SKILL.md'), '---\nname: skill-b\n---\nSecond skill.');

      const result = await wps.resolveSkillsPlaceholder('{{skills}}', workspaceDir);
      expect(result).toContain('First skill.');
      expect(result).toContain('Second skill.');
    });
  });
});
