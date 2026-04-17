import { createGzip, createGunzip } from 'node:zlib';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SystemSettingsService } from '../settings/service.js';
import { DEFAULT_MAX_WORKSPACE_TAR_BYTES } from '../settings/service.js';
import type { ContainerManager } from './container-manager.js';

// ── Public interfaces ─────────────────────────────────────────

export interface WorkspaceDiffOptions {
  containerManager: ContainerManager;
  /** Directory for storing checkpoint data. Default: 'data/checkpoints' */
  checkpointDir?: string;
  settingsService?: SystemSettingsService;
}

// ── WorkspaceDiffService ──────────────────────────────────────

const TAG = '[WorkspaceDiff]';
const WORKSPACE_TOMBSTONES_FILE = 'workspace-tombstones.json';

export class WorkspaceDiffService {
  private readonly containerManager: ContainerManager;
  private readonly checkpointDir: string;
  private readonly settingsService: SystemSettingsService | undefined;

  constructor(options: WorkspaceDiffOptions) {
    this.containerManager = options.containerManager;
    this.checkpointDir = options.checkpointDir ?? 'data/checkpoints';
    this.settingsService = options.settingsService;
  }

  /**
   * Capture workspace changes from a running/stopped container.
   * Uses ContainerManager.extractContainerDiff() to get the workspace tar.
   * Compresses and stores at: {checkpointDir}/{turnId}/workspace.tar.gz
   * Returns the path to the stored file, or 'none' if no changes.
   */
  async capture(turnId: string, containerId: string): Promise<string> {
    console.debug(`${TAG} capturing workspace diff for turn ${turnId} from container ${containerId}`);

    const turnDir = path.join(this.checkpointDir, turnId);

    // 1. Extract the workspace tar and deletion tombstones from the container
    const snapshot = await this.containerManager.extractWorkspaceDiff(containerId);

    // 2. If there are no changes or tombstones → return 'none'
    if (
      !snapshot
      || ((!snapshot.archive || snapshot.archive.length === 0) && snapshot.deletedPaths.length === 0)
    ) {
      console.debug(`${TAG} no workspace changes for turn ${turnId}`);
      await fs.rm(turnDir, { recursive: true, force: true });
      return 'none';
    }

    const tarBuffer = snapshot.archive ?? Buffer.alloc(0);
    const tombstonesJson = JSON.stringify({
      version: 1,
      deletedPaths: snapshot.deletedPaths,
    }, null, 2);
    const tombstonesBuffer = Buffer.from(tombstonesJson);

    // 3. Check size BEFORE writing to storage (REQ-029)
    const maxSizeBytes = this.settingsService
      ? (await this.settingsService.getAll()).maxWorkspaceTarBytes
      : DEFAULT_MAX_WORKSPACE_TAR_BYTES;
    const warnSizeBytes = Math.floor(maxSizeBytes * 0.5);
    const totalSizeBytes = tarBuffer.length + tombstonesBuffer.length;

    if (totalSizeBytes > maxSizeBytes) {
      const sizeMb = (totalSizeBytes / (1024 * 1024)).toFixed(1);
      const limitMb = (maxSizeBytes / (1024 * 1024)).toFixed(0);
      throw Object.assign(
        new Error(`Workspace diff too large (${sizeMb} MB, limit is ${limitMb} MB)`),
        { code: 'workspace_diff_too_large', sizeBytes: totalSizeBytes },
      );
    }

    if (totalSizeBytes > warnSizeBytes) {
      const sizeMb = (totalSizeBytes / (1024 * 1024)).toFixed(1);
      console.warn(`${TAG} workspace diff for turn ${turnId} is large: ${sizeMb} MB`);
    }

    // 4. Compress with gzip
    const gzipBuffer = await this.gzipCompress(tarBuffer);

    // 5. Write to checkpoint directory
    await fs.mkdir(turnDir, { recursive: true });

    const outputPath = path.join(turnDir, 'workspace.tar.gz');
    await fs.writeFile(outputPath, gzipBuffer);
    await fs.writeFile(path.join(turnDir, WORKSPACE_TOMBSTONES_FILE), tombstonesJson);

    console.debug(`${TAG} workspace diff saved for turn ${turnId}: ${outputPath} (${gzipBuffer.length} bytes compressed)`);
    return outputPath;
  }

  /**
   * Restore workspace diff to a new container before starting it.
   * Reads the tar.gz, decompresses, and injects into the container's /workspace.
   */
  async restore(turnId: string, containerId: string): Promise<void> {
    const turnDir = path.join(this.checkpointDir, turnId);
    const archivePath = path.join(this.checkpointDir, turnId, 'workspace.tar.gz');

    console.debug(`${TAG} restoring workspace diff for turn ${turnId} into container ${containerId}`);

    let gzipBuffer: Buffer;
    try {
      gzipBuffer = await fs.readFile(archivePath);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        const deletedPaths = await this.readTombstones(turnDir);
        if (deletedPaths.length === 0) {
          console.debug(`${TAG} no workspace diff found for turn ${turnId} — skipping restore`);
          return;
        }
        await this.containerManager.restoreArchive(containerId, Buffer.alloc(0), { deletedPaths });
        console.debug(`${TAG} workspace diff restored for turn ${turnId} into container ${containerId}`);
        return;
      }
      throw err;
    }

    const deletedPaths = await this.readTombstones(turnDir, { required: true });

    // Decompress gzip → tar buffer
    const tarBuffer = await this.gzipDecompress(gzipBuffer);

    await this.containerManager.restoreArchive(containerId, tarBuffer, { deletedPaths });

    console.debug(`${TAG} workspace diff restored for turn ${turnId} into container ${containerId}`);
  }

  /**
   * Delete stored workspace diff for a run.
   */
  async cleanup(turnId: string): Promise<void> {
    const turnDir = path.join(this.checkpointDir, turnId);
    console.debug(`${TAG} cleaning up workspace diff for turn ${turnId}`);

    try {
      await fs.rm(turnDir, { recursive: true, force: true });
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        // Already cleaned up — idempotent
        return;
      }
      throw err;
    }
  }

  /**
   * Get the size of a stored workspace diff in bytes.
   * Returns 0 if no diff exists.
   */
  async getSize(turnId: string): Promise<number> {
    const turnDir = path.join(this.checkpointDir, turnId);
    const archivePath = path.join(turnDir, 'workspace.tar.gz');
    const tombstonesPath = path.join(turnDir, WORKSPACE_TOMBSTONES_FILE);
    let size = 0;

    try {
      const stat = await fs.stat(archivePath);
      size += stat.size;
    } catch (err: unknown) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw err;
      }
    }

    try {
      const stat = await fs.stat(tombstonesPath);
      size += stat.size;
    } catch (err: unknown) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw err;
      }
    }

    return size;
  }

  // ── Private helpers ─────────────────────────────────────────

  private async readTombstones(
    turnDir: string,
    options: { required?: boolean } = {},
  ): Promise<string[]> {
    const tombstonesPath = path.join(turnDir, WORKSPACE_TOMBSTONES_FILE);

    let tombstonesJson: string;
    try {
      tombstonesJson = await fs.readFile(tombstonesPath, 'utf-8');
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        if (options.required) {
          throw new Error(`Missing workspace tombstones file: ${tombstonesPath}`, { cause: err });
        }
        return [];
      }
      throw err;
    }

    const parsed = JSON.parse(tombstonesJson) as unknown;
    if (
      typeof parsed !== 'object'
      || parsed === null
      || !('deletedPaths' in parsed)
      || !Array.isArray((parsed as { deletedPaths: unknown }).deletedPaths)
    ) {
      throw new Error(`Invalid workspace tombstones file: ${tombstonesPath}`);
    }

    const deletedPaths = (parsed as { deletedPaths: unknown[] }).deletedPaths;
    if (!deletedPaths.every((entry): entry is string => typeof entry === 'string')) {
      throw new Error(`Invalid workspace tombstones file: ${tombstonesPath}`);
    }

    return deletedPaths;
  }

  private async gzipCompress(input: Buffer): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const gzip = createGzip();
    gzip.on('data', (chunk: Buffer) => chunks.push(chunk));

    const done = new Promise<Buffer>((resolve, reject) => {
      gzip.on('end', () => resolve(Buffer.concat(chunks)));
      gzip.on('error', reject);
    });

    gzip.end(input);
    return done;
  }

  private async gzipDecompress(input: Buffer): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const gunzip = createGunzip();

    const done = new Promise<Buffer>((resolve, reject) => {
      gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
      gunzip.on('end', () => resolve(Buffer.concat(chunks)));
      gunzip.on('error', reject);
    });

    gunzip.end(input);
    return done;
  }
}

// ── Error helpers ─────────────────────────────────────────────

interface NodeError {
  code: string;
}

function isNodeError(err: unknown): err is NodeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as NodeError).code === 'string'
  );
}
