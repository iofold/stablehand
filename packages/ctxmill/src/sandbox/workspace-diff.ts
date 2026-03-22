import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable, PassThrough } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ContainerManager } from './container-manager.js';

// ── Public interfaces ─────────────────────────────────────────

export interface WorkspaceDiffOptions {
  containerManager: ContainerManager;
  /** Directory for storing checkpoint data. Default: 'data/checkpoints' */
  checkpointDir?: string;
}

// ── Size limits (REQ-029) ─────────────────────────────────────

const WARN_SIZE_BYTES = 50 * 1024 * 1024;   // 50 MB
const MAX_SIZE_BYTES = 100 * 1024 * 1024;    // 100 MB

// ── WorkspaceDiffService ──────────────────────────────────────

const TAG = '[WorkspaceDiff]';

export class WorkspaceDiffService {
  private readonly containerManager: ContainerManager;
  private readonly checkpointDir: string;

  constructor(options: WorkspaceDiffOptions) {
    this.containerManager = options.containerManager;
    this.checkpointDir = options.checkpointDir ?? 'data/checkpoints';
  }

  /**
   * Capture workspace changes from a running/stopped container.
   * Uses ContainerManager.extractWorkspaceDiff() to get the workspace tar.
   * Compresses and stores at: {checkpointDir}/{runId}/workspace.tar.gz
   * Returns the path to the stored file, or 'none' if no changes.
   */
  async capture(runId: string, containerId: string): Promise<string> {
    console.debug(`${TAG} capturing workspace diff for run ${runId} from container ${containerId}`);

    // 1. Extract the workspace tar from the container
    const tarBuffer = await this.containerManager.extractWorkspaceDiff(containerId);

    // 2. If buffer is empty or null → return 'none'
    if (!tarBuffer || tarBuffer.length === 0) {
      console.debug(`${TAG} no workspace changes for run ${runId}`);
      return 'none';
    }

    // 3. Check size BEFORE writing to storage (REQ-029)
    if (tarBuffer.length > MAX_SIZE_BYTES) {
      const sizeMb = (tarBuffer.length / (1024 * 1024)).toFixed(1);
      throw Object.assign(
        new Error(`Workspace diff too large (${sizeMb} MB, limit is 100 MB)`),
        { code: 'workspace_diff_too_large', sizeBytes: tarBuffer.length },
      );
    }

    if (tarBuffer.length > WARN_SIZE_BYTES) {
      const sizeMb = (tarBuffer.length / (1024 * 1024)).toFixed(1);
      console.warn(`${TAG} workspace diff for run ${runId} is large: ${sizeMb} MB`);
    }

    // 4. Compress with gzip
    const gzipBuffer = await this.gzipCompress(tarBuffer);

    // 5. Write to checkpoint directory
    const runDir = path.join(this.checkpointDir, runId);
    await fs.mkdir(runDir, { recursive: true });

    const outputPath = path.join(runDir, 'workspace.tar.gz');
    await fs.writeFile(outputPath, gzipBuffer);

    console.debug(`${TAG} workspace diff saved for run ${runId}: ${outputPath} (${gzipBuffer.length} bytes compressed)`);
    return outputPath;
  }

  /**
   * Restore workspace diff to a new container before starting it.
   * Reads the tar.gz, decompresses, and injects into the container's /workspace.
   */
  async restore(runId: string, containerId: string): Promise<void> {
    const archivePath = path.join(this.checkpointDir, runId, 'workspace.tar.gz');

    console.debug(`${TAG} restoring workspace diff for run ${runId} into container ${containerId}`);

    let gzipBuffer: Buffer;
    try {
      gzipBuffer = await fs.readFile(archivePath);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        console.debug(`${TAG} no workspace diff found for run ${runId} — skipping restore`);
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

    console.debug(`${TAG} workspace diff restored for run ${runId} into container ${containerId}`);
  }

  /**
   * Delete stored workspace diff for a run.
   */
  async cleanup(runId: string): Promise<void> {
    const runDir = path.join(this.checkpointDir, runId);
    console.debug(`${TAG} cleaning up workspace diff for run ${runId}`);

    try {
      await fs.rm(runDir, { recursive: true, force: true });
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
  async getSize(runId: string): Promise<number> {
    const archivePath = path.join(this.checkpointDir, runId, 'workspace.tar.gz');

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
    const passthrough = new PassThrough();

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
