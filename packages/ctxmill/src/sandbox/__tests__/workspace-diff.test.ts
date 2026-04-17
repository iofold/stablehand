import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createGunzip } from 'node:zlib';
import type { ContainerManager } from '../container-manager.js';
import { WorkspaceDiffService } from '../workspace-diff.js';

function createMockContainerManager(overrides: Record<string, unknown> = {}) {
  return {
    extractContainerDiff: vi.fn().mockResolvedValue(Buffer.from('fake-tar-data')),
    extractWorkspaceDiff: vi.fn().mockResolvedValue({ archive: Buffer.from('fake-tar-data'), deletedPaths: [] }),
    restoreArchive: vi.fn().mockResolvedValue(undefined),
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

// ── Tests ────────────────────────────────────────────────────

describe('WorkspaceDiffService', () => {
  let tmpDir: string;
  let cm: ReturnType<typeof createMockContainerManager>;
  let service: WorkspaceDiffService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-diff-test-'));
    cm = createMockContainerManager();
    service = new WorkspaceDiffService({
      containerManager: cm as unknown as ContainerManager,
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
      cm.extractWorkspaceDiff.mockResolvedValue({ archive: tarData, deletedPaths: [] });

      const result = await service.capture('run-001', 'container-abc');

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

      const tombstones = JSON.parse(
        await fs.readFile(path.join(tmpDir, 'run-001', 'workspace-tombstones.json'), 'utf-8'),
      ) as { deletedPaths: string[] };
      expect(tombstones.deletedPaths).toEqual([]);
    });

    it('returns "none" when extractWorkspaceDiff returns empty archive and no tombstones', async () => {
      cm.extractWorkspaceDiff.mockResolvedValue({ archive: Buffer.alloc(0), deletedPaths: [] });

      const result = await service.capture('run-002', 'container-def');

      expect(result).toBe('none');

      // No file should be created
      await expect(
        fs.stat(path.join(tmpDir, 'run-002', 'workspace.tar.gz')),
      ).rejects.toThrow(/ENOENT/);
    });

    it('returns "none" when extractWorkspaceDiff returns null', async () => {
      cm.extractWorkspaceDiff.mockResolvedValue(null);

      const result = await service.capture('run-003', 'container-ghi');

      expect(result).toBe('none');
    });

    it('is idempotent — overwrites existing checkpoint', async () => {
      const tarData1 = Buffer.from('first-capture');
      const tarData2 = Buffer.from('second-capture');

      cm.extractWorkspaceDiff.mockResolvedValue({ archive: tarData1, deletedPaths: [] });
      const path1 = await service.capture('run-idem', 'c1');

      cm.extractWorkspaceDiff.mockResolvedValue({ archive: tarData2, deletedPaths: [] });
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
      cm.extractWorkspaceDiff.mockResolvedValue({ archive: largeBuffer, deletedPaths: [] });

      await expect(service.capture('run-large', 'container-large')).rejects.toMatchObject({
        code: 'workspace_diff_too_large',
        message: expect.stringContaining('100 MB'),
      });

      // No file should be created
      await expect(
        fs.stat(path.join(tmpDir, 'run-large', 'workspace.tar.gz')),
      ).rejects.toThrow(/ENOENT/);
    });

    it('warns at > 50 MB but still succeeds', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Create a buffer larger than 50 MB but under 100 MB
      const mediumBuffer = Buffer.alloc(51 * 1024 * 1024, 'y');
      cm.extractWorkspaceDiff.mockResolvedValue({ archive: mediumBuffer, deletedPaths: [] });

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
    it('delegates tar restore to ContainerManager', async () => {
      // First capture a workspace diff
      const tarData = Buffer.from('restore-test-tar-data');
      cm.extractWorkspaceDiff.mockResolvedValue({ archive: tarData, deletedPaths: [] });
      await service.capture('run-restore', 'container-src');

      // Now restore into a different container
      await service.restore('run-restore', 'container-dst');

      expect(cm.restoreArchive).toHaveBeenCalledTimes(1);
      expect(cm.restoreArchive).toHaveBeenCalledWith(
        'container-dst',
        Buffer.from('restore-test-tar-data'),
        { deletedPaths: [] },
      );
    });

    it('persists and restores deleted file tombstones', async () => {
      cm.extractWorkspaceDiff.mockResolvedValue({
        archive: Buffer.alloc(0),
        deletedPaths: ['deleted.txt', 'nested/removed.md'],
      });

      const result = await service.capture('run-tombstones', 'container-src');

      expect(result).toBe(path.join(tmpDir, 'run-tombstones', 'workspace.tar.gz'));

      const tombstones = JSON.parse(
        await fs.readFile(path.join(tmpDir, 'run-tombstones', 'workspace-tombstones.json'), 'utf-8'),
      ) as { deletedPaths: string[] };
      expect(tombstones.deletedPaths).toEqual(['deleted.txt', 'nested/removed.md']);

      await service.restore('run-tombstones', 'container-dst');

      expect(cm.restoreArchive).toHaveBeenCalledWith(
        'container-dst',
        Buffer.alloc(0),
        { deletedPaths: ['deleted.txt', 'nested/removed.md'] },
      );
    });

    it('fails closed when tombstone metadata is corrupt', async () => {
      const runDir = path.join(tmpDir, 'run-corrupt');
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, 'workspace-tombstones.json'), '{not-json');

      await expect(service.restore('run-corrupt', 'container-dst')).rejects.toThrow();
      expect(cm.restoreArchive).not.toHaveBeenCalled();
    });

    it('fails closed when an archive exists without tombstone metadata', async () => {
      const runDir = path.join(tmpDir, 'run-missing-tombstones');
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, 'workspace.tar.gz'), Buffer.from('not-used'));

      await expect(
        service.restore('run-missing-tombstones', 'container-dst'),
      ).rejects.toThrow(/Missing workspace tombstones file/);
      expect(cm.restoreArchive).not.toHaveBeenCalled();
    });

    it('silently skips restore when no checkpoint exists', async () => {
      // No capture was done for this run
      await expect(service.restore('run-nonexistent', 'container-x')).resolves.toBeUndefined();

      expect(cm.restoreArchive).not.toHaveBeenCalled();
    });
  });

  // ── cleanup ──────────────────────────────────────────────

  describe('cleanup', () => {
    it('deletes the checkpoint directory', async () => {
      // Create a checkpoint first
      const tarData = Buffer.from('cleanup-test-data');
      cm.extractWorkspaceDiff.mockResolvedValue({ archive: tarData, deletedPaths: [] });
      await service.capture('run-cleanup', 'container-z');

      const runDir = path.join(tmpDir, 'run-cleanup');
      // Verify directory exists
      const beforeStat = await fs.stat(runDir);
      expect(beforeStat.isDirectory()).toBe(true);

      // Cleanup
      await service.cleanup('run-cleanup');

      // Verify directory is gone
      await expect(fs.stat(runDir)).rejects.toThrow(/ENOENT/);
    });

    it('is idempotent — does not throw if directory does not exist', async () => {
      await expect(service.cleanup('run-does-not-exist')).resolves.toBeUndefined();
    });
  });

  // ── getSize ──────────────────────────────────────────────

  describe('getSize', () => {
    it('returns correct byte count for stored diff', async () => {
      const tarData = Buffer.from('size-test-data-for-measurement');
      cm.extractWorkspaceDiff.mockResolvedValue({ archive: tarData, deletedPaths: [] });
      const archivePath = await service.capture('run-size', 'container-s');

      const size = await service.getSize('run-size');

      const actualStat = await fs.stat(archivePath);
      const tombstonesStat = await fs.stat(path.join(tmpDir, 'run-size', 'workspace-tombstones.json'));
      expect(size).toBe(actualStat.size + tombstonesStat.size);
      expect(size).toBeGreaterThan(0);
    });

    it('returns 0 for non-existent diff', async () => {
      const size = await service.getSize('run-no-diff');
      expect(size).toBe(0);
    });
  });
});
