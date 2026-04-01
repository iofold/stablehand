import { createGzip, createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
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

    // 1. Extract the workspace tar from the container
    const tarBuffer = await this.containerManager.extractContainerDiff(containerId);

    // 2. If buffer is empty or null → return 'none'
    if (!tarBuffer || tarBuffer.length === 0) {
      console.debug(`${TAG} no workspace changes for turn ${turnId}`);
      return 'none';
    }

    // 3. Check size BEFORE writing to storage (REQ-029)
    const maxSizeBytes = this.settingsService
      ? (await this.settingsService.getAll()).maxWorkspaceTarBytes
      : DEFAULT_MAX_WORKSPACE_TAR_BYTES;
    const warnSizeBytes = Math.floor(maxSizeBytes * 0.5);

    if (tarBuffer.length > maxSizeBytes) {
      const sizeMb = (tarBuffer.length / (1024 * 1024)).toFixed(1);
      const limitMb = (maxSizeBytes / (1024 * 1024)).toFixed(0);
      throw Object.assign(
        new Error(`Workspace diff too large (${sizeMb} MB, limit is ${limitMb} MB)`),
        { code: 'workspace_diff_too_large', sizeBytes: tarBuffer.length },
      );
    }

    if (tarBuffer.length > warnSizeBytes) {
      const sizeMb = (tarBuffer.length / (1024 * 1024)).toFixed(1);
      console.warn(`${TAG} workspace diff for turn ${turnId} is large: ${sizeMb} MB`);
    }

    // 4. Compress with gzip
    const gzipBuffer = await this.gzipCompress(tarBuffer);

    // 5. Write to checkpoint directory
    const turnDir = path.join(this.checkpointDir, turnId);
    await fs.mkdir(turnDir, { recursive: true });

    const outputPath = path.join(turnDir, 'workspace.tar.gz');
    await fs.writeFile(outputPath, gzipBuffer);

    console.debug(`${TAG} workspace diff saved for turn ${turnId}: ${outputPath} (${gzipBuffer.length} bytes compressed)`);
    return outputPath;
  }

  /**
   * Restore workspace diff to a new container before starting it.
   * Reads the tar.gz, decompresses, and injects into the container's /workspace.
   */
  async restore(turnId: string, containerId: string): Promise<void> {
    const archivePath = path.join(this.checkpointDir, turnId, 'workspace.tar.gz');

    console.debug(`${TAG} restoring workspace diff for turn ${turnId} into container ${containerId}`);

    let gzipBuffer: Buffer;
    try {
      gzipBuffer = await fs.readFile(archivePath);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        console.debug(`${TAG} no workspace diff found for turn ${turnId} — skipping restore`);
        return;
      }
      throw err;
    }

    // Decompress gzip → tar buffer
    const tarBuffer = await this.gzipDecompress(gzipBuffer);

    // Inject tar into the container's /workspace via putArchive
    const container = (this.containerManager as any).docker.getContainer(containerId);
    const stream = Readable.from(tarBuffer);
    await container.putArchive(stream, { path: '/' });

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
    const archivePath = path.join(this.checkpointDir, turnId, 'workspace.tar.gz');

    try {
      const stat = await fs.stat(archivePath);
      return stat.size;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return 0;
      }
      throw err;
    }
  }

  // ── Private helpers ─────────────────────────────────────────

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
