import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { discoverSkills, loadSkill } from '../skills/loader.js';

interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
}

interface WorkspacePreparationDeps {
  logger: Logger;
}

interface PrepareOptions {
  workspaceDir: string;
  projectDir?: string;
  workspaceContent?: {
    files?: Array<{ src: string; dest: string }>;
    skills?: boolean | string[];
  };
  skillsBaseDir?: string;
}

export class WorkspacePreparationService {
  constructor(private readonly deps: WorkspacePreparationDeps) {}

  async prepare(opts: PrepareOptions): Promise<void> {
    await this.copyExplicitFiles(opts);
    await this.seedSkills(opts);
  }

  async resolveSkillsPlaceholder(systemPrompt: string, workspaceDir: string): Promise<string> {
    if (!systemPrompt.includes('{{skills}}')) {
      return systemPrompt;
    }

    const skillsDir = join(workspaceDir, '.ctxmill', 'skills');
    let skillContent = '';
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      const sections: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const skillMdPath = join(skillsDir, entry.name, 'SKILL.md');
        try {
          const raw = await fs.readFile(skillMdPath, 'utf-8');
          const body = this.extractBodyAfterFrontmatter(raw);
          if (body.trim()) {
            sections.push(`## Skill: ${entry.name}\n${body.trim()}`);
          }
        } catch {
          // SKILL.md may be missing for a seeded skill directory; skip it.
        }
      }
      skillContent = sections.join('\n\n');
    } catch {
      // Skills may not have been seeded into the workspace; leave placeholder empty.
    }

    return systemPrompt.replace('{{skills}}', skillContent);
  }

  private extractBodyAfterFrontmatter(raw: string): string {
    if (!raw.startsWith('---')) {
      return raw;
    }

    const endIdx = raw.indexOf('---', 3);
    if (endIdx === -1) {
      return raw;
    }

    return raw.slice(endIdx + 3).trim();
  }

  private async copyExplicitFiles(opts: PrepareOptions): Promise<void> {
    const files = opts.workspaceContent?.files;
    if (!files?.length) {
      return;
    }

    const sourceRoot = opts.projectDir ?? opts.workspaceDir;
    for (const file of files) {
      const srcPath = join(sourceRoot, file.src);
      const destPath = join(opts.workspaceDir, file.dest);
      const srcStat = await fs.stat(srcPath);
      await fs.mkdir(dirname(destPath), { recursive: true });
      if (srcStat.isDirectory()) {
        await fs.cp(srcPath, destPath, { recursive: true });
      } else {
        await fs.copyFile(srcPath, destPath);
      }

      this.deps.logger.debug('Copied workspace content', { src: file.src, dest: file.dest });
    }
  }

  private async seedSkills(opts: PrepareOptions): Promise<void> {
    const skillsConfig = opts.workspaceContent?.skills;
    if (skillsConfig === undefined || skillsConfig === false) {
      return;
    }

    const sourceRoot = opts.projectDir ?? opts.workspaceDir;
    const baseDir = opts.skillsBaseDir ?? join(sourceRoot, 'skills');
    const discovered = await discoverSkills(baseDir);

    const toLoad = skillsConfig === true
      ? discovered
      : discovered.filter((skill) => skillsConfig.includes(skill.name));

    const destBase = join(opts.workspaceDir, '.ctxmill', 'skills');
    await fs.mkdir(destBase, { recursive: true });

    for (const entry of toLoad) {
      const skill = await loadSkill(entry.path);
      const skillDir = join(destBase, skill.name);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.copyFile(join(entry.path, 'SKILL.md'), join(skillDir, 'SKILL.md'));

      for (const subdir of ['scripts', 'references', 'assets']) {
        const srcSub = join(entry.path, subdir);
        if (await this.dirExists(srcSub)) {
          await fs.cp(srcSub, join(skillDir, subdir), { recursive: true });
        }
      }

      this.deps.logger.debug('Seeded skill', { name: skill.name });
    }
  }

  private async dirExists(path: string): Promise<boolean> {
    try {
      return (await fs.stat(path)).isDirectory();
    } catch {
      // Missing optional skill asset directories are treated as absent.
      return false;
    }
  }
}
