import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
}

interface WorkspacePreparationDeps {
  logger: Logger;
}

interface PrepareOptions {
  workspaceDir: string;
  projectDir?: string;
  harnessName?: string;
  workspaceContent?: {
    files?: Array<{ src: string; dest: string }>;
  };
}

export class WorkspacePreparationService {
  constructor(private readonly deps: WorkspacePreparationDeps) {}

  async prepare(opts: PrepareOptions): Promise<void> {
    await this.copyExplicitFiles(opts);
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
}
