import type { SandboxContainerManager } from '../sandbox/container-manager.js';
import { hasStatusCode } from '../util/status-code-error.js';

interface ContainerCleanupLogger {
  warn(msg: string, ...args: unknown[]): void;
}

export async function stopAndRemoveContainer(
  containerManager: Pick<SandboxContainerManager, 'stopContainer' | 'removeContainer'>,
  containerId: string,
  logger: ContainerCleanupLogger,
  contextLabel: string,
  stopTimeoutSec: number,
): Promise<boolean> {
  let stopError: unknown;
  try {
    await containerManager.stopContainer(containerId, stopTimeoutSec);
  } catch (error) {
    stopError = error;
    logger.warn(`${contextLabel}: container stop failed; attempting force removal:`, error);
  }

  try {
    await containerManager.removeContainer(containerId, true);
    return true;
  } catch (error) {
    if (hasStatusCode(error, 404)) {
      return true;
    }
    logger.warn(
      `${contextLabel}: container removal failed:`,
      error,
      stopError ? { stopError } : undefined,
    );
    return false;
  }
}
