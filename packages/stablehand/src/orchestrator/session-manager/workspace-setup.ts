import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { posix, resolve } from 'node:path';

export type WorkspaceSetupErrorCode =
  | 'INVALID_CONFIG'
  | 'UNSAFE_WORKSPACE'
  | 'SOURCE_INVALID'
  | 'DESTINATION_CONFLICT';

export class WorkspaceSetupError extends Error {
  constructor(
    readonly code: WorkspaceSetupErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkspaceSetupError';
  }
}

interface WorkspaceSymlink {
  src: string;
  dest: string;
}

const DIRECTORY_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function errorCode(error: unknown): string | undefined {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
      ? error.code
      : undefined;
}

function validateRelativePath(
  value: unknown,
  field: 'src' | 'dest',
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || posix.isAbsolute(value)
    || posix.normalize(value) !== value
    || value === '.'
    || value === '..'
    || value.startsWith('../')
    || value.endsWith('/')
  ) {
    throw new WorkspaceSetupError(
      'INVALID_CONFIG',
      `Configured workspace symlink ${field} must be a normalized relative path`,
    );
  }
  return value;
}

function workspaceSymlinks(
  harnessConfig: Record<string, unknown>,
): WorkspaceSymlink[] {
  const setup = harnessConfig['setup'];
  if (
    setup === undefined
    || typeof setup !== 'object'
    || setup === null
    || !('symlinks' in setup)
    || setup.symlinks === undefined
  ) {
    return [];
  }
  if (!Array.isArray(setup.symlinks)) {
    throw new WorkspaceSetupError(
      'INVALID_CONFIG',
      'Configured workspace setup symlinks must be an array',
    );
  }

  return setup.symlinks.map((link) => {
    if (typeof link !== 'object' || link === null) {
      throw new WorkspaceSetupError(
        'INVALID_CONFIG',
        'Configured workspace symlink must be an object',
      );
    }
    const src = validateRelativePath(
      'src' in link ? link.src : undefined,
      'src',
    );
    const dest = validateRelativePath(
      'dest' in link ? link.dest : undefined,
      'dest',
    );
    if (src === dest) {
      throw new WorkspaceSetupError(
        'INVALID_CONFIG',
        `Configured workspace symlink source and destination are identical: ${src}`,
      );
    }
    return { src, dest };
  });
}

function fileDescriptorPath(handle: FileHandle, child?: string): string {
  const root = `/proc/self/fd/${handle.fd}`;
  return child === undefined ? root : `${root}/${child}`;
}

async function openWorkspaceRoot(workspaceDir: string): Promise<FileHandle> {
  try {
    return await fs.open(resolve(workspaceDir), DIRECTORY_OPEN_FLAGS);
  } catch (error: unknown) {
    throw new WorkspaceSetupError(
      'UNSAFE_WORKSPACE',
      `Configured workspace root is not a safe directory: ${workspaceDir}`,
      { cause: error },
    );
  }
}

async function openChildDirectory(
  parent: FileHandle,
  component: string,
  create: boolean,
  description: string,
): Promise<FileHandle> {
  const childPath = fileDescriptorPath(parent, component);
  if (create) {
    try {
      await fs.mkdir(childPath);
    } catch (error: unknown) {
      if (errorCode(error) !== 'EEXIST') {
        throw new WorkspaceSetupError(
          'UNSAFE_WORKSPACE',
          `Could not create workspace ${description}: ${component}`,
          { cause: error },
        );
      }
    }
  }

  let childStat;
  try {
    childStat = await fs.lstat(childPath);
  } catch (error: unknown) {
    throw new WorkspaceSetupError(
      'UNSAFE_WORKSPACE',
      `Workspace ${description} does not exist: ${component}`,
      { cause: error },
    );
  }
  if (childStat.isSymbolicLink() || !childStat.isDirectory()) {
    throw new WorkspaceSetupError(
      'UNSAFE_WORKSPACE',
      `Workspace ${description} contains an unsafe symlink or non-directory ancestor: ${component}`,
    );
  }

  try {
    return await fs.open(childPath, DIRECTORY_OPEN_FLAGS);
  } catch (error: unknown) {
    throw new WorkspaceSetupError(
      'UNSAFE_WORKSPACE',
      `Workspace ${description} changed while it was being verified: ${component}`,
      { cause: error },
    );
  }
}

async function verifySourcePath(
  workspaceDir: string,
  source: string,
): Promise<void> {
  const components = source.split('/');
  const leaf = components.pop()!;
  let directory = await openWorkspaceRoot(workspaceDir);
  try {
    for (const component of components) {
      const child = await openChildDirectory(
        directory,
        component,
        false,
        `symlink source ${source}`,
      );
      await directory.close();
      directory = child;
    }

    let sourceStat;
    try {
      sourceStat = await fs.lstat(fileDescriptorPath(directory, leaf));
    } catch (error: unknown) {
      throw new WorkspaceSetupError(
        'SOURCE_INVALID',
        `Workspace symlink source does not exist: ${source}`,
        { cause: error },
      );
    }
    if (
      sourceStat.isSymbolicLink()
      || (!sourceStat.isDirectory() && !sourceStat.isFile())
    ) {
      throw new WorkspaceSetupError(
        'SOURCE_INVALID',
        `Workspace symlink source is a symlink or unsupported entry: ${source}`,
      );
    }
  } finally {
    await directory.close();
  }
}

async function openDestinationParent(
  workspaceDir: string,
  destination: string,
): Promise<{ directory: FileHandle; leaf: string }> {
  const components = destination.split('/');
  const leaf = components.pop()!;
  let directory = await openWorkspaceRoot(workspaceDir);
  try {
    for (const component of components) {
      const child = await openChildDirectory(
        directory,
        component,
        true,
        `symlink destination ${destination}`,
      );
      await directory.close();
      directory = child;
    }
    return { directory, leaf };
  } catch (error) {
    await directory.close();
    throw error;
  }
}

async function readDestinationTarget(
  destinationPath: string,
  destination: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let destinationStat;
    try {
      destinationStat = await fs.lstat(destinationPath);
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw new WorkspaceSetupError(
        'DESTINATION_CONFLICT',
        `Could not inspect workspace symlink destination: ${destination}`,
        { cause: error },
      );
    }
    if (!destinationStat.isSymbolicLink()) {
      throw new WorkspaceSetupError(
        'DESTINATION_CONFLICT',
        `Configured workspace symlink destination is not a symlink: ${destination}`,
      );
    }
    try {
      return await fs.readlink(destinationPath);
    } catch (error: unknown) {
      if (
        errorCode(error) === 'ENOENT'
        || errorCode(error) === 'EINVAL'
      ) {
        continue;
      }
      throw new WorkspaceSetupError(
        'DESTINATION_CONFLICT',
        `Could not read workspace symlink destination: ${destination}`,
        { cause: error },
      );
    }
  }
  return undefined;
}

async function ensurePortableWorkspaceSymlink(
  workspaceDir: string,
  link: WorkspaceSymlink,
): Promise<void> {
  await verifySourcePath(workspaceDir, link.src);
  const { directory, leaf } = await openDestinationParent(
    workspaceDir,
    link.dest,
  );
  const destinationPath = fileDescriptorPath(directory, leaf);
  const target = posix.relative(posix.dirname(link.dest), link.src);
  const temporaryPath = fileDescriptorPath(
    directory,
    `.stablehand-symlink-${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  const displacedSetupSymlinks = new Set<string>();

  try {
    const currentTarget = await readDestinationTarget(
      destinationPath,
      link.dest,
    );
    if (currentTarget === target) return;

    await fs.symlink(target, temporaryPath);
    temporaryExists = true;

    for (let attempt = 0; attempt < 64; attempt += 1) {
      const displacedName = `.stablehand-displaced-${randomUUID()}.tmp`;
      const displacedPath = fileDescriptorPath(directory, displacedName);
      try {
        await fs.rename(destinationPath, displacedPath);
        const displacedStat = await fs.lstat(displacedPath);
        if (!displacedStat.isSymbolicLink()) {
          const parentPath = await fs.realpath(fileDescriptorPath(directory));
          const recoveryPath = `${parentPath}/${displacedName}`;
          if (displacedStat.isFile()) {
            try {
              await fs.link(displacedPath, destinationPath);
              await fs.unlink(displacedPath);
            } catch (restoreError: unknown) {
              throw new WorkspaceSetupError(
                'DESTINATION_CONFLICT',
                `A raced workspace destination was preserved at ${recoveryPath}`,
                { cause: restoreError },
              );
            }
            throw new WorkspaceSetupError(
              'DESTINATION_CONFLICT',
              `Workspace symlink destination raced with a regular file: ${link.dest}`,
            );
          }
          throw new WorkspaceSetupError(
            'DESTINATION_CONFLICT',
            `A raced workspace destination was preserved at ${recoveryPath}`,
          );
        }
        displacedSetupSymlinks.add(displacedPath);
        await fs.rm(displacedPath, { force: true });
        displacedSetupSymlinks.delete(displacedPath);
      } catch (error: unknown) {
        if (
          errorCode(error) !== 'ENOENT'
          || error instanceof WorkspaceSetupError
        ) {
          throw error;
        }
      }

      try {
        await fs.link(temporaryPath, destinationPath);
      } catch (error: unknown) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }

      const installedTarget = await readDestinationTarget(
        destinationPath,
        link.dest,
      );
      if (installedTarget === target) return;
    }
    throw new WorkspaceSetupError(
      'DESTINATION_CONFLICT',
      `Workspace symlink destination remained unstable during repair: ${link.dest}`,
    );
  } catch (error: unknown) {
    if (error instanceof WorkspaceSetupError) throw error;
    throw new WorkspaceSetupError(
      'DESTINATION_CONFLICT',
      `Could not install workspace symlink destination: ${link.dest}`,
      { cause: error },
    );
  } finally {
    if (temporaryExists) {
      await fs.rm(temporaryPath, { force: true });
    }
    for (const displacedPath of displacedSetupSymlinks) {
      await fs.rm(displacedPath, { force: true });
    }
    await directory.close();
  }
}

export async function applyWorkspaceSetup(
  workspaceDir: string | undefined,
  harnessConfig: Record<string, unknown>,
): Promise<void> {
  try {
    if (!workspaceDir) return;
    const symlinks = workspaceSymlinks(harnessConfig);
    for (const link of symlinks) {
      await ensurePortableWorkspaceSymlink(workspaceDir, link);
    }
  } catch (error: unknown) {
    if (error instanceof WorkspaceSetupError) throw error;
    throw new WorkspaceSetupError(
      'UNSAFE_WORKSPACE',
      `Workspace setup failed for ${workspaceDir ?? 'unknown workspace'}`,
      { cause: error },
    );
  }
}
