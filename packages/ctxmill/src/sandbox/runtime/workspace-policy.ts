import { Readable } from 'node:stream';
import * as tar from 'tar-stream';

export const WORKSPACE_ROOT = '/workspace';

const WORKSPACE_EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  '.npm',
  '.cache',
  '.bun',
]);

export interface WorkspaceArchiveEntryHeader {
  name?: unknown;
  type?: unknown;
}

export function workspaceRelativePath(
  filePath: string,
  workspaceRoot: string = WORKSPACE_ROOT,
): string | null {
  if (filePath === workspaceRoot || !filePath.startsWith(`${workspaceRoot}/`)) {
    return null;
  }

  const relativePath = filePath.slice(workspaceRoot.length + 1);
  return isSafeWorkspaceRelativePath(relativePath) ? relativePath : null;
}

export function isSafeWorkspaceRelativePath(filePath: string): boolean {
  if (
    filePath === ''
    || filePath.startsWith('/')
    || filePath.includes('\0')
  ) {
    return false;
  }

  const segments = filePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }

  return true;
}

export function normalizeArchiveEntryName(entryName: string): string {
  return entryName
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
}

export function shouldIncludeWorkspacePath(
  filePath: string,
  workspaceRoot: string = WORKSPACE_ROOT,
): boolean {
  const relativePath = workspaceRelativePath(filePath, workspaceRoot);
  if (!relativePath) {
    return false;
  }

  return shouldIncludeWorkspaceRelativePath(relativePath);
}

export function shouldIncludeWorkspaceRelativePath(relativePath: string): boolean {
  return isSafeWorkspaceRelativePath(relativePath)
    && !relativePath
      .split('/')
      .some((segment) => WORKSPACE_EXCLUDED_SEGMENTS.has(segment));
}

export function uniqueWorkspacePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

export function assertSafeWorkspaceArchiveEntry(header: WorkspaceArchiveEntryHeader): string {
  const originalName = String(header.name ?? '');
  const normalizedName = normalizeArchiveEntryName(originalName);

  if (!isSafeWorkspaceRelativePath(normalizedName)) {
    throw new Error(`Workspace archive rejected unsafe path: ${originalName}`);
  }

  if (header.type === 'symlink' || header.type === 'link') {
    throw new Error(`Workspace archive rejected ${header.type} entry: ${originalName}`);
  }

  if (
    header.type !== undefined
    && header.type !== 'file'
    && header.type !== 'directory'
  ) {
    throw new Error(`Workspace archive rejected special entry '${String(header.type)}': ${originalName}`);
  }

  return normalizedName;
}

export function validateWorkspaceDeletedPaths(paths: string[]): void {
  if (paths.some((deletedPath) => !isSafeWorkspaceRelativePath(deletedPath))) {
    throw new Error('Workspace restore rejected unsafe deleted path');
  }
}

export async function validateWorkspaceArchive(archive: Buffer): Promise<void> {
  const extract = tar.extract();

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const fail = (err: unknown) => {
      if (finished) {
        return;
      }
      finished = true;
      extract.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    extract.on('entry', (header, entryStream, next) => {
      try {
        assertSafeWorkspaceArchiveEntry(header);
        entryStream.resume();
        next();
      } catch (err) {
        entryStream.resume();
        fail(err);
      }
    });

    extract.on('finish', () => {
      if (finished) {
        return;
      }
      finished = true;
      resolve();
    });
    extract.on('error', fail);
    Readable.from(archive).on('error', fail).pipe(extract);
  });
}
