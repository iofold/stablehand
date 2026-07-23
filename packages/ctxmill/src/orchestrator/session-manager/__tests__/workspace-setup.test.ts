import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyWorkspaceSetup } from '../workspace-setup.js';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await fs.mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

const setupConfig = {
  setup: {
    symlinks: [{ src: 'skills', dest: '.claude/skills' }],
  },
};

describe('workspace setup symlinks', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((tempDir) =>
        fs.rm(tempDir, { recursive: true, force: true })
      ),
    );
  });

  it('rejects a symlink used as the workspace root without mutating its target', async () => {
    const tempDir = await createTempDir('ctxmill-workspace-setup-root-escape-');
    const workspaceTarget = join(tempDir, 'outside-workspace');
    const workspaceLink = join(tempDir, 'workspace');
    await fs.mkdir(join(workspaceTarget, 'skills'), { recursive: true });
    await fs.symlink(workspaceTarget, workspaceLink);

    await expect(
      applyWorkspaceSetup(workspaceLink, setupConfig),
    ).rejects.toThrow(/workspace root|safe directory|symlink/i);
    await expect(
      fs.lstat(join(workspaceTarget, '.claude')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlinked destination ancestor without mutating its host target', async () => {
    const tempDir = await createTempDir('ctxmill-workspace-setup-escape-');
    const workspaceDir = join(tempDir, 'workspace');
    const outsideDir = join(tempDir, 'outside');
    await fs.mkdir(join(workspaceDir, 'skills'), { recursive: true });
    await fs.mkdir(outsideDir);
    await fs.symlink(outsideDir, join(workspaceDir, '.claude'));

    await expect(
      applyWorkspaceSetup(workspaceDir, setupConfig),
    ).rejects.toThrow(/workspace|symlink|ancestor/i);
    await expect(
      fs.lstat(join(outsideDir, 'skills')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlinked source without creating an escaping destination', async () => {
    const tempDir = await createTempDir('ctxmill-workspace-setup-source-escape-');
    const workspaceDir = join(tempDir, 'workspace');
    const outsideDir = join(tempDir, 'outside');
    await fs.mkdir(workspaceDir);
    await fs.mkdir(join(outsideDir, 'skills'), { recursive: true });
    await fs.symlink(join(outsideDir, 'skills'), join(workspaceDir, 'skills'));

    await expect(
      applyWorkspaceSetup(workspaceDir, setupConfig),
    ).rejects.toThrow(/workspace|symlink|source/i);
    await expect(
      fs.lstat(join(workspaceDir, '.claude', 'skills')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('makes concurrent repairs idempotent', async () => {
    const tempDir = await createTempDir('ctxmill-workspace-setup-concurrent-');
    const workspaceDir = join(tempDir, 'workspace');
    const sourceDir = join(workspaceDir, 'skills');
    const destinationDir = join(workspaceDir, '.claude');
    const destinationPath = join(destinationDir, 'skills');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(destinationDir);
    await fs.symlink(sourceDir, destinationPath);

    await expect(
      Promise.all(
        Array.from({ length: 16 }, () =>
          applyWorkspaceSetup(workspaceDir, setupConfig)
        ),
      ),
    ).resolves.toEqual(Array.from({ length: 16 }, () => undefined));
    await expect(fs.readlink(destinationPath)).resolves.toBe('../skills');
  });

  it.each(['file', 'directory'] as const)(
    'preserves a user-owned destination %s',
    async (entryType) => {
      const tempDir = await createTempDir(
        `ctxmill-workspace-setup-${entryType}-conflict-`,
      );
      const workspaceDir = join(tempDir, 'workspace');
      const destinationPath = join(workspaceDir, '.claude', 'skills');
      await fs.mkdir(join(workspaceDir, 'skills'), { recursive: true });
      await fs.mkdir(join(workspaceDir, '.claude'));
      if (entryType === 'file') {
        await fs.writeFile(destinationPath, 'user-owned');
      } else {
        await fs.mkdir(destinationPath);
        await fs.writeFile(join(destinationPath, 'keep.txt'), 'user-owned');
      }

      await expect(
        applyWorkspaceSetup(workspaceDir, setupConfig),
      ).rejects.toThrow(/destination is not a symlink/i);
      if (entryType === 'file') {
        await expect(fs.readFile(destinationPath, 'utf8'))
          .resolves.toBe('user-owned');
      } else {
        await expect(fs.readFile(join(destinationPath, 'keep.txt'), 'utf8'))
          .resolves.toBe('user-owned');
      }
    },
  );

  it('rejects a missing source before creating the destination', async () => {
    const tempDir = await createTempDir('ctxmill-workspace-setup-missing-source-');
    const workspaceDir = join(tempDir, 'workspace');
    await fs.mkdir(workspaceDir);

    await expect(
      applyWorkspaceSetup(workspaceDir, setupConfig),
    ).rejects.toThrow(/source does not exist/i);
    await expect(
      fs.lstat(join(workspaceDir, '.claude')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal in a setup path', async () => {
    const tempDir = await createTempDir('ctxmill-workspace-setup-traversal-');
    const workspaceDir = join(tempDir, 'workspace');
    await fs.mkdir(workspaceDir);

    await expect(
      applyWorkspaceSetup(workspaceDir, {
        setup: {
          symlinks: [{ src: '../outside', dest: '.claude/skills' }],
        },
      }),
    ).rejects.toThrow(/normalized relative path/i);
  });

  it('does not overwrite a regular file raced into the destination leaf', async () => {
    const tempDir = await createTempDir('ctxmill-workspace-setup-leaf-race-');
    const workspaceDir = join(tempDir, 'workspace');
    const sourceDir = join(workspaceDir, 'skills');
    const destinationDir = join(workspaceDir, '.claude');
    const destinationPath = join(destinationDir, 'skills');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(destinationDir);
    await fs.symlink(sourceDir, destinationPath);

    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(
      async (oldPath, newPath) => {
        const racedPath = String(oldPath).endsWith('/skills')
          ? oldPath
          : newPath;
        if (String(racedPath).endsWith('/skills')) {
          await fs.unlink(racedPath);
          await fs.writeFile(racedPath, 'user-owned-race');
        }
        return rename(oldPath, newPath);
      },
    );
    try {
      await expect(
        applyWorkspaceSetup(workspaceDir, setupConfig),
      ).rejects.toThrow(/destination|conflict|regular|symlink/i);
      await expect(fs.readFile(destinationPath, 'utf8'))
        .resolves.toBe('user-owned-race');
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('keeps cleanup failures inside the typed workspace setup boundary', async () => {
    const tempDir = await createTempDir('ctxmill-workspace-setup-cleanup-');
    const workspaceDir = join(tempDir, 'workspace');
    const sourceDir = join(workspaceDir, 'skills');
    const destinationDir = join(workspaceDir, '.claude');
    const destinationPath = join(destinationDir, 'skills');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(destinationDir);
    await fs.symlink(sourceDir, destinationPath);

    const renameSpy = vi.spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('injected rename failure'));
    const rmSpy = vi.spyOn(fs, 'rm')
      .mockRejectedValueOnce(new Error('injected cleanup failure'));
    try {
      await expect(
        applyWorkspaceSetup(workspaceDir, setupConfig),
      ).rejects.toMatchObject({
        name: 'WorkspaceSetupError',
      });
    } finally {
      renameSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });
});
