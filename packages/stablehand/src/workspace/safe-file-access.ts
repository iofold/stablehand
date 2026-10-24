import { constants, type Stats } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_NOFOLLOW | constants.O_NONBLOCK;

function childPath(directory: FileHandle, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error('Invalid workspace path component');
  }
  return `/proc/self/fd/${directory.fd}/${name}`;
}

/**
 * Linux runtime only: each component is opened relative to a pinned directory
 * descriptor, with O_NOFOLLOW. Renaming an ancestor or replacing it with a
 * symlink cannot redirect a later operation. /proc/self/fd is required; there
 * is deliberately no path-based fallback on unsupported systems.
 */
export async function withWorkspaceDirectory<T>(
  baseDir: string,
  targetDir: string,
  create: boolean,
  action: (directory: FileHandle) => Promise<T>,
): Promise<T> {
  if (process.platform !== 'linux' || !constants.O_DIRECTORY || !constants.O_NOFOLLOW) {
    throw new Error('Safe workspace file access requires Linux with /proc/self/fd');
  }
  const base = resolve(baseDir);
  const nested = relative(base, resolve(targetDir));
  if (isAbsolute(nested) || nested === '..' || nested.startsWith('../')) {
    throw new Error('Path outside agent workspace');
  }
  const handles: FileHandle[] = [];
  try {
    let directory = await open('/', DIRECTORY_FLAGS);
    handles.push(directory);
    // Pin the configured root too, rather than following a replaced root or
    // any symlink in its absolute ancestry.
    for (const segment of base.split('/').filter(Boolean)) {
      const path = childPath(directory, segment);
      if (create) {
        await mkdir(path).catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        });
      }
      directory = await open(path, DIRECTORY_FLAGS);
      handles.push(directory);
    }
    for (const segment of nested.split('/').filter(Boolean)) {
      const path = childPath(directory, segment);
      if (create) {
        await mkdir(path).catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        });
      }
      directory = await open(path, DIRECTORY_FLAGS);
      handles.push(directory);
    }
    return await action(directory);
  } finally {
    // Close every descriptor on both success and failure.
    await Promise.all(handles.reverse().map((handle) => handle.close()));
  }
}

export interface WorkspaceFileOptions {
  writable?: boolean;
  create?: boolean;
  createParents?: boolean;
}

/** Open one child without following its final component; never truncate here. */
export async function withDirectoryFile<T>(
  directory: FileHandle,
  name: string,
  options: WorkspaceFileOptions,
  action: (file: FileHandle, metadata: Stats, path: string) => Promise<T>,
): Promise<T> {
  const path = childPath(directory, name);
  const flags = FILE_FLAGS
    | (options.writable ? constants.O_WRONLY : constants.O_RDONLY)
    | (options.create ? constants.O_CREAT : 0);
  const file = await open(path, flags);
  try {
    const metadata = await file.stat();
    if (metadata.isDirectory()) {
      throw Object.assign(new Error('Path is a directory, not a file'), { code: 'EISDIR' });
    }
    if (!metadata.isFile()) {
      throw new Error('Path is not a regular file');
    }
    return await action(file, metadata, path);
  } finally {
    await file.close();
  }
}

export async function withWorkspaceFile<T>(
  baseDir: string,
  targetFile: string,
  options: WorkspaceFileOptions,
  action: (file: FileHandle, metadata: Stats, path: string) => Promise<T>,
): Promise<T> {
  if (resolve(targetFile) === resolve(baseDir)) {
    throw Object.assign(new Error('Path is a directory, not a file'), { code: 'EISDIR' });
  }
  return withWorkspaceDirectory(baseDir, dirname(targetFile), options.createParents ?? false, (directory) =>
    withDirectoryFile(directory, basename(targetFile), options, action));
}

/** The descriptor path stays anchored when the original directory name moves. */
export function workspaceDirectoryPath(directory: FileHandle): string {
  return `/proc/self/fd/${directory.fd}`;
}

/** List only regular files and directories, without following entry symlinks. */
export async function workspaceEntryMetadata(directory: FileHandle, name: string): Promise<Stats | null> {
  let entry: FileHandle | undefined;
  try {
    entry = await open(childPath(directory, name), constants.O_RDONLY | FILE_FLAGS);
    const metadata = await entry.stat();
    return metadata.isFile() || metadata.isDirectory() ? metadata : null;
  } catch (err) {
    if (['ELOOP', 'ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return null;
    throw err;
  } finally {
    await entry?.close();
  }
}
