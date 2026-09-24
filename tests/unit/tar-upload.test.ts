import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { validateAndExtractTarball } from '../../packages/stablehand/src/workspace/tar-upload.js';

interface TarEntryInput {
  name: string;
  content?: string;
  type?: string;
  linkname?: string;
  mode?: number;
}

interface TarPackEntry {
  name: string;
  size?: number;
  type?: string;
  linkname?: string;
  mode?: number;
}

interface TarPack {
  entry(header: TarPackEntry, data?: string | Buffer): void;
  finalize(): void;
  pipe<T extends NodeJS.WritableStream>(destination: T): T;
}

interface TarModule {
  pack(): TarPack;
}

async function createTarGz(entries: TarEntryInput[]): Promise<Buffer> {
  const tarModulePath = new URL('../../packages/stablehand/node_modules/tar-stream/index.js', import.meta.url).href;
  const tar = await import(tarModulePath) as TarModule;
  const pack = tar.pack();

  for (const entry of entries) {
    if (entry.type === 'directory') {
      pack.entry({ name: entry.name, type: 'directory', mode: entry.mode });
      continue;
    }

    if (entry.type === 'symlink' || entry.type === 'link' || entry.type === 'fifo') {
      pack.entry({ name: entry.name, type: entry.type, linkname: entry.linkname ?? '', mode: entry.mode });
      continue;
    }

    const content = entry.content ?? '';
    pack.entry({ name: entry.name, size: Buffer.byteLength(content), type: entry.type ?? 'file', mode: entry.mode }, content);
  }

  pack.finalize();

  const gzip = createGzip();
  const chunks: Buffer[] = [];
  pack.pipe(gzip);

  for await (const chunk of gzip) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function bufferToStream(buffer: Buffer): Readable {
  return Readable.from(buffer);
}

describe('validateAndExtractTarball', () => {
  let targetDir: string;

  beforeEach(async () => {
    targetDir = await fs.mkdtemp(join(tmpdir(), 'tar-upload-test-'));
  });

  afterEach(async () => {
    await fs.rm(targetDir, { recursive: true, force: true });
  });

  it('extracts valid tar.gz with flat files', async () => {
    const archive = await createTarGz([
      { name: 'a.txt', content: 'alpha' },
      { name: 'b.txt', content: 'beta' },
    ]);

    const result = await validateAndExtractTarball(bufferToStream(archive), targetDir);

    expect(result).toEqual({ files: 2, totalBytes: 9 });
    await expect(fs.readFile(join(targetDir, 'a.txt'), 'utf8')).resolves.toBe('alpha');
    await expect(fs.readFile(join(targetDir, 'b.txt'), 'utf8')).resolves.toBe('beta');
  });

  it('preserves executable mode bits from tar headers', async () => {
    const archive = await createTarGz([
      { name: 'bin/pilot', content: '#!/bin/sh\necho ok\n', mode: 0o755 },
      { name: 'plain.txt', content: 'not executable', mode: 0o644 },
    ]);

    await validateAndExtractTarball(bufferToStream(archive), targetDir);

    const executableMode = (await fs.stat(join(targetDir, 'bin', 'pilot'))).mode & 0o777;
    const plainMode = (await fs.stat(join(targetDir, 'plain.txt'))).mode & 0o777;
    expect(executableMode).toBe(0o755);
    expect(plainMode).toBe(0o644);
  });

  it('extracts valid tar.gz with nested directories', async () => {
    const archive = await createTarGz([
      { name: 'nested', type: 'directory' },
      { name: './nested/deeper', type: 'directory' },
      { name: './nested/deeper/file.txt', content: 'hello world' },
    ]);

    const result = await validateAndExtractTarball(bufferToStream(archive), targetDir);

    expect(result.files).toBe(1);
    await expect(fs.readFile(join(targetDir, 'nested', 'deeper', 'file.txt'), 'utf8')).resolves.toBe('hello world');
  });

  it('returns correct file count and byte total', async () => {
    const archive = await createTarGz([
      { name: 'first.txt', content: 'ab' },
      { name: 'dir', type: 'directory' },
      { name: 'dir/second.txt', content: 'cdef' },
      { name: 'dir/third.txt', content: '' },
    ]);

    const result = await validateAndExtractTarball(bufferToStream(archive), targetDir);

    expect(result).toEqual({ files: 3, totalBytes: 6 });
  });

  it('rejects tar with absolute path entry', async () => {
    const archive = await createTarGz([{ name: '/etc/passwd', content: 'root:x:0:0' }]);

    await expect(validateAndExtractTarball(bufferToStream(archive), targetDir)).rejects.toThrow(/absolute path/i);
  });

  it('rejects tar with path traversal entry', async () => {
    const archive = await createTarGz([{ name: '../escape.txt', content: 'nope' }]);

    await expect(validateAndExtractTarball(bufferToStream(archive), targetDir)).rejects.toThrow(/traversal/i);
  });

  it('rejects tar with symlink entry', async () => {
    const archive = await createTarGz([{ name: 'bad-link', type: 'symlink', linkname: 'target.txt' }]);

    await expect(validateAndExtractTarball(bufferToStream(archive), targetDir)).rejects.toThrow(/symlink/i);
  });

  it('rejects tar with hardlink entry', async () => {
    const archive = await createTarGz([{ name: 'bad-hardlink', type: 'link', linkname: 'target.txt' }]);

    await expect(validateAndExtractTarball(bufferToStream(archive), targetDir)).rejects.toThrow(/link entry rejected/i);
  });

  it('rejects tar with special file type', async () => {
    const archive = await createTarGz([{ name: 'named-pipe', type: 'fifo' }]);

    await expect(validateAndExtractTarball(bufferToStream(archive), targetDir)).rejects.toThrow(/special file type/i);
  });

  it('rejects tar under .git reserved path', async () => {
    const archive = await createTarGz([{ name: '.git/config', content: 'forbidden' }]);

    await expect(validateAndExtractTarball(bufferToStream(archive), targetDir)).rejects.toThrow(/reserved path/i);
  });

  it('rejects tar under .stablehand reserved path', async () => {
    const archive = await createTarGz([{ name: '.stablehand/secrets.json', content: 'forbidden' }]);

    await expect(validateAndExtractTarball(bufferToStream(archive), targetDir)).rejects.toThrow(/reserved path/i);
  });

  it('enforces size limit', async () => {
    const archive = await createTarGz([{ name: 'big.txt', content: '01234567890' }]);

    await expect(
      validateAndExtractTarball(bufferToStream(archive), targetDir, { maxBytes: 10 }),
    ).rejects.toThrow(/exceeds 10 bytes limit/i);
  });

  it('handles empty tar.gz', async () => {
    const archive = await createTarGz([]);

    await expect(validateAndExtractTarball(bufferToStream(archive), targetDir)).resolves.toEqual({ files: 0, totalBytes: 0 });
  });

  it('handles corrupt gzip data', async () => {
    const archive = Buffer.from('not-a-gzip-stream');

    await expect(validateAndExtractTarball(bufferToStream(archive), targetDir)).rejects.toThrow(/decompression|gzip/i);
  });

  it('custom reserved paths override defaults', async () => {
    const archive = await createTarGz([
      { name: '.git/config', content: 'allowed now' },
      { name: 'private/secret.txt', content: 'blocked' },
    ]);

    await expect(
      validateAndExtractTarball(bufferToStream(archive), targetDir, { reservedPaths: ['private/'] }),
    ).rejects.toThrow(/reserved path rejected: private\/secret.txt/i);

    await expect(fs.readFile(join(targetDir, '.git', 'config'), 'utf8')).resolves.toBe('allowed now');
  });
});
