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

  it('seeds selected skills into the workspace', async () => {
    const service = new WorkspacePreparationService({ logger });
    const skillsBaseDir = join(projectDir, 'skills');
    await mkdir(join(skillsBaseDir, 'alpha', 'scripts'), { recursive: true });
    await mkdir(join(skillsBaseDir, 'beta'), { recursive: true });
    await writeFile(join(skillsBaseDir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha\n---\n# Alpha skill', 'utf-8');
    await writeFile(join(skillsBaseDir, 'alpha', 'scripts', 'run.sh'), 'echo alpha', 'utf-8');
    await writeFile(join(skillsBaseDir, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: Beta\n---\n# Beta skill', 'utf-8');

    await service.prepare({
      workspaceDir,
      projectDir,
      skillsBaseDir,
      workspaceContent: {
        skills: ['alpha'],
      },
    });

    await expect(readFile(join(workspaceDir, '.ctxmill', 'skills', 'alpha', 'SKILL.md'), 'utf-8')).resolves.toContain('# Alpha skill');
    await expect(readFile(join(workspaceDir, '.ctxmill', 'skills', 'alpha', 'scripts', 'run.sh'), 'utf-8')).resolves.toBe('echo alpha');
    await expect(readFile(join(workspaceDir, '.ctxmill', 'skills', 'beta', 'SKILL.md'), 'utf-8')).rejects.toThrow();
    expect(logger.debug).toHaveBeenCalledWith('Seeded skill', { name: 'alpha' });
  });

  it('resolves the {{skills}} placeholder from seeded SKILL.md bodies', async () => {
    const service = new WorkspacePreparationService({ logger });
    const skillDir = join(workspaceDir, '.ctxmill', 'skills', 'alpha');
    await mkdir(skillDir, { recursive: true });
    await writeFile(skillDir + '/SKILL.md', '---\nname: alpha\ndescription: Alpha\n---\n# Usage\nDo alpha.', 'utf-8');

    const resolved = await service.resolveSkillsPlaceholder('Skills:\n{{skills}}', workspaceDir);

    expect(resolved).toContain('## Skill: alpha');
    expect(resolved).toContain('# Usage\nDo alpha.');
    expect(resolved).not.toContain('description: Alpha');
  });

  it('leaves the skills placeholder empty when no skills were seeded', async () => {
    const service = new WorkspacePreparationService({ logger });

    const resolved = await service.resolveSkillsPlaceholder('Skills: {{skills}}', workspaceDir);

    expect(resolved).toBe('Skills: ');
  });
});
