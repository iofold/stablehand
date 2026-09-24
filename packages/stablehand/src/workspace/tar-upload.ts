import { createWriteStream, promises as fs } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar-stream';

export interface TarUploadResult {
  files: number;
  totalBytes: number;
}

export interface TarUploadOptions {
  maxBytes?: number;
  reservedPaths?: string[];
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_RESERVED_PATHS = ['.git/', '.stablehand/'];

function normalizeEntryName(name: string): string {
  const strippedDotPrefix = name.replace(/^(\.\/)+/, '');
  return posix.normalize(strippedDotPrefix);
}

function isReservedPath(name: string, reservedPaths: string[]): boolean {
  return reservedPaths.some((reservedPath) => {
    const normalizedReserved = reservedPath.replace(/^\/+/, '').replace(/\/+$/, '');
    return name === normalizedReserved || name.startsWith(`${normalizedReserved}/`);
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function destroyReadableStream(stream: unknown): void {
  if (typeof stream !== 'object' || stream === null || !('destroy' in stream)) {
    return;
  }

  const destroy = stream.destroy;
  if (typeof destroy === 'function') {
    destroy.call(stream);
  }
}

export async function validateAndExtractTarball(
  stream: Readable,
  targetDir: string,
  opts?: TarUploadOptions,
): Promise<TarUploadResult> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const reservedPaths = opts?.reservedPaths ?? DEFAULT_RESERVED_PATHS;
  const resolvedTarget = resolve(targetDir);

  let files = 0;
  let totalBytes = 0;

  const extract = tar.extract();
  const gunzip = createGunzip();

  return new Promise<TarUploadResult>((resolvePromise, rejectPromise) => {
    let finished = false;

    const fail = (error: unknown): void => {
      const resolvedError = toError(error);
      if (finished) {
        return;
      }

      finished = true;
      rejectPromise(resolvedError);
      destroyReadableStream(stream);
      gunzip.destroy();
      extract.destroy();
    };

    extract.on('entry', (header, entryStream, next) => {
      void (async () => {
        const originalName = String(header.name ?? '');

        try {
          if (originalName.startsWith('/')) {
            throw new Error(`Absolute path rejected: ${originalName}`);
          }

          const normalizedName = normalizeEntryName(originalName);

          if (normalizedName.split('/').some((segment) => segment === '..')) {
            throw new Error(`Path traversal rejected: ${originalName}`);
          }

          if (header.type === 'symlink' || header.type === 'link') {
            throw new Error(`${header.type} entry rejected: ${originalName}`);
          }

          if (header.type !== 'file' && header.type !== 'directory') {
            throw new Error(`Special file type '${header.type}' rejected: ${originalName}`);
          }

          if (normalizedName === '' || normalizedName === '.') {
            if (header.type === 'directory') {
              entryStream.resume();
              next();
              return;
            }

            throw new Error(`Invalid entry path rejected: ${originalName}`);
          }

          if (isReservedPath(normalizedName, reservedPaths)) {
            throw new Error(`Reserved path rejected: ${originalName}`);
          }

          const fullPath = resolve(join(resolvedTarget, normalizedName));
          if (fullPath !== resolvedTarget && !fullPath.startsWith(`${resolvedTarget}/`)) {
            throw new Error(`Path escapes target directory: ${originalName}`);
          }

          if (header.type === 'directory') {
            await fs.mkdir(fullPath, { recursive: true });
            if (typeof header.mode === 'number') {
              // mkdir applies the process umask, which would make the same
              // canonical bundle hash differently across environments.
              await fs.chmod(fullPath, header.mode & 0o7777);
            }
            entryStream.resume();
            next();
            return;
          }

          const entrySize = typeof header.size === 'number' ? header.size : 0;
          totalBytes += entrySize;
          if (totalBytes > maxBytes) {
            throw new Error(`Extracted size exceeds ${maxBytes} bytes limit`);
          }

          await fs.mkdir(dirname(fullPath), { recursive: true });
          await pipeline(entryStream, createWriteStream(fullPath));

          if (typeof header.mode === 'number') {
            // Preserve POSIX permission bits from tar headers. Agent workspaces
            // ship executable CLIs/scripts (for example /workspace/bin/pilot);
            // createWriteStream() defaults to 0644 and would otherwise strip +x.
            await fs.chmod(fullPath, header.mode & 0o7777);
          }

          files += 1;
          next();
        } catch (error) {
          entryStream.resume();
          fail(error);
        }
      })();
    });

    extract.on('finish', () => {
      if (finished) {
        return;
      }

      finished = true;
      resolvePromise({ files, totalBytes });
    });

    extract.on('error', fail);
    gunzip.on('error', (error) => fail(new Error(`Gzip decompression error: ${toError(error).message}`)));
    stream.on('error', fail);

    void pipeline(stream, gunzip, extract).catch(fail);
  });
}
import { Readable } from 'node:stream';
