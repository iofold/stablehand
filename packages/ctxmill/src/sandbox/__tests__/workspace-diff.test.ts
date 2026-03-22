import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createGzip, createGunzip } from 'node:zlib';
import { WorkspaceDiffService } from '../workspace-diff.js';
import type { WorkspaceDiffOptions } from '../workspace-diff.js';

// ── Mock helpers ─────────────────────────────────────────────

function createMockContainer(overrides: Record<string, unknown> = {}) {
  return {
    putArchive: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockContainerManager(overrides: Record<string, unknown> = {}) {
  const mockContainer = createMockContainer();

  return {
    extractWorkspaceDiff: vi.fn().mockResolvedValue(Buffer.from('fake-tar-data')),
    docker: {
      getContainer: vi.fn().mockReturnValue(mockContainer),
    },
    _mockContainer: mockContainer,
    ...overrides,
  };
}

function gzipDecompress(input: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const gunzip = createGunzip();

  return new Promise<Buffer>((resolve, reject) => {
    gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gunzip.on('end', () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', reject);
    gunzip.end(input);
  });
}

function gzipCompress(input: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const gzip = createGzip();

  return new Promise<Buffer>((resolve, reject) => {
    gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gzip.on('end', () => resolve(Buffer.concat(chunks)));
    gzip.on('error', reject);
    gzip.end(input);
  });
}

// ── Tests ────────────────────────────────────────────────────

describe('WorkspaceDiffService', () => {
  let tmpDir: string;
  let cm: ReturnType<typeof createMockContainerManager>;
  let service: WorkspaceDiffService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-diff-test-'));
    cm = createMockContainerManager();
    service = new WorkspaceDiffService({
      containerManager: cm as any,
      checkpointDir: tmpDir,
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── capture ──────────────────────────────────────────────

  describe('capture', () => {
    it('creates tar.gz file and returns path when container has changes', async () => {
      const tarData = Buffer.from('fake-tar-data-for-capture');
      cm.extractWorkspaceDiff.mockResolvedValue(tarData);

      const result = await service.capture('run-001', 'container-abc');

      // Should call extractWorkspaceDiff with the container ID
      expect(cm.extractWorkspaceDiff).toHaveBeenCalledWith('container-abc');

      // Should return the correct path
      const expectedPath = path.join(tmpDir, 'run-001', 'workspace.tar.gz');
      expect(result).toBe(expectedPath);

      // File should exist
      const stat = await fs.stat(expectedPath);
      expect(stat.size).toBeGreaterThan(0);

      // File should be valid gzip that decompresses back to original
      const compressed = await fs.readFile(expectedPath);
      const decompressed = await gzipDecompress(compressed);
      expect(decompressed.toString()).toBe('fake-tar-data-for-capture');
    });

    it('returns "none" when extractWorkspaceDiff returns empty buffer', async () => {
      cm.extractWorkspaceDiff.mockResolvedValue(Buffer.alloc(0));

      const result = await service.capture('run-002', 'container-def');

      expect(result).toBe('none');

      // No file should be created
      await expect(
        fs.stat(path.join(tmpDir, 'run-002', 'workspace.tar.gz')),
      ).rejects.toThrow();
    });

    it('returns "none" when extractWorkspaceDiff returns null', async () => {
      cm.extractWorkspaceDiff.mockResolvedValue(null);

      const result = await service.capture('run-003', 'container-ghi');

      expect(result).toBe('none');
    });

    it('is idempotent — overwrites existing checkpoint', async () => {
      const tarData1 = Buffer.from('first-capture');
      const tarData2 = Buffer.from('second-capture');

      cm.extractWorkspaceDiff.mockResolvedValue(tarData1);
      const path1 = await service.capture('run-idem', 'c1');

      cm.extractWorkspaceDiff.mockResolvedValue(tarData2);
      const path2 = await service.capture('run-idem', 'c2');

      expect(path1).toBe(path2);

      // Should contain the second capture's data
      const compressed = await fs.readFile(path2);
      const decompressed = await gzipDecompress(compressed);
      expect(decompressed.toString()).toBe('second-capture');
    });

    it('rejects workspace > 100 MB with workspace_diff_too_large error', async () => {
      // Create a buffer larger than 100 MB
      const largeBuffer = Buffer.alloc(101 * 1024 * 1024, 'x');
      cm.extractWorkspaceDiff.mockResolvedValue(largeBuffer);

      await expect(service.capture('run-large', 'container-large')).rejects.toMatchObject({
        code: 'workspace_diff_too_large',
        message: expect.stringContaining('100 MB'),
      });

      // No file should be created
      await expect(
        fs.stat(path.join(tmpDir, 'run-large', 'workspace.tar.gz')),
      ).rejects.toThrow();
    });

    it('warns at > 50 MB but still succeeds', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Create a buffer larger than 50 MB but under 100 MB
      const mediumBuffer = Buffer.alloc(51 * 1024 * 1024, 'y');
      cm.extractWorkspaceDiff.mockResolvedValue(mediumBuffer);

      const result = await service.capture('run-medium', 'container-medium');

      expect(result).not.toBe('none');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('large'),
      );

      warnSpy.mockRestore();
    });
  });

  // ── restore ──────────────────────────────────────────────

  describe('restore', () => {
    it('extracts tar into container at /workspace', async () => {
      // First capture a workspace diff
      const tarData = Buffer.from('restore-test-tar-data');
      cm.extractWorkspaceDiff.mockResolvedValue(tarData);
      await service.capture('run-restore', 'container-src');

      // Now restore into a different container
      await service.restore('run-restore', 'container-dst');

      // Should have called getContainer and putArchive
      expect(cm.docker.getContainer).toHaveBeenCalledWith('container-dst');
      expect(cm._mockContainer.putArchive).toHaveBeenCalledTimes(1);

      const [stream, opts] = cm._mockContainer.putArchive.mock.calls[0];
      expect(opts).toEqual({ path: '/' });

      // The injected data should be readable and match the original tar
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const injectedData = Buffer.concat(chunks);
      expect(injectedData.toString()).toBe('restore-test-tar-data');
    });

    it('silently skips restore when no checkpoint exists', async () => {
      // No capture was done for this run
      await expect(service.restore('run-nonexistent', 'container-x')).resolves.toBeUndefined();

      // putArchive should not have been called
      expect(cm._mockContainer.putArchive).not.toHaveBeenCalled();
    });
  });

  // ── cleanup ──────────────────────────────────────────────

  describe('cleanup', () => {
    it('deletes the checkpoint directory', async () => {
      // Create a checkpoint first
      const tarData = Buffer.from('cleanup-test-data');
      cm.extractWorkspaceDiff.mockResolvedValue(tarData);
      await service.capture('run-cleanup', 'container-z');

      const runDir = path.join(tmpDir, 'run-cleanup');
      // Verify directory exists
      const beforeStat = await fs.stat(runDir);
      expect(beforeStat.isDirectory()).toBe(true);

      // Cleanup
      await service.cleanup('run-cleanup');

      // Verify directory is gone
      await expect(fs.stat(runDir)).rejects.toThrow();
    });

    it('is idempotent — does not throw if directory does not exist', async () => {
      await expect(service.cleanup('run-does-not-exist')).resolves.toBeUndefined();
    });
  });

  // ── getSize ──────────────────────────────────────────────

  describe('getSize', () => {
    it('returns correct byte count for stored diff', async () => {
      const tarData = Buffer.from('size-test-data-for-measurement');
      cm.extractWorkspaceDiff.mockResolvedValue(tarData);
      const archivePath = await service.capture('run-size', 'container-s');

      const size = await service.getSize('run-size');

      // Size should match the actual file size
      const actualStat = await fs.stat(archivePath);
      expect(size).toBe(actualStat.size);
      expect(size).toBeGreaterThan(0);
    });

    it('returns 0 for non-existent diff', async () => {
      const size = await service.getSize('run-no-diff');
      expect(size).toBe(0);
    });
  });
});
