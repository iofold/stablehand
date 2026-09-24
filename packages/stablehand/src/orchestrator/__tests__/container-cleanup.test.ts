import { describe, expect, it, vi } from 'vitest';

import { stopAndRemoveContainer } from '../container-cleanup.js';

function createHarness() {
  return {
    containerManager: {
      stopContainer: vi.fn().mockResolvedValue(undefined),
      removeContainer: vi.fn().mockResolvedValue(undefined),
    },
    logger: { warn: vi.fn() },
  };
}

describe('stopAndRemoveContainer', () => {
  it('stops with the requested timeout and force-removes the container', async () => {
    const harness = createHarness();

    await expect(stopAndRemoveContainer(
      harness.containerManager,
      'container-1',
      harness.logger,
      'cleanup context',
      5,
    )).resolves.toBe(true);

    expect(harness.containerManager.stopContainer).toHaveBeenCalledWith('container-1', 5);
    expect(harness.containerManager.removeContainer).toHaveBeenCalledWith('container-1', true);
  });

  it('attempts force removal after stop fails', async () => {
    const harness = createHarness();
    harness.containerManager.stopContainer.mockRejectedValue(new Error('stop failed'));

    await expect(stopAndRemoveContainer(
      harness.containerManager,
      'container-1',
      harness.logger,
      'cleanup context',
      10,
    )).resolves.toBe(true);

    expect(harness.containerManager.removeContainer).toHaveBeenCalledWith('container-1', true);
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/cleanup context.*container stop failed/),
      expect.any(Error),
    );
  });

  it('treats an already-removed container as successful cleanup', async () => {
    const harness = createHarness();
    harness.containerManager.removeContainer.mockRejectedValue({ statusCode: 404 });

    await expect(stopAndRemoveContainer(
      harness.containerManager,
      'container-1',
      harness.logger,
      'cleanup context',
      10,
    )).resolves.toBe(true);
  });

  it('reports a non-404 removal failure', async () => {
    const harness = createHarness();
    harness.containerManager.removeContainer.mockRejectedValue({ statusCode: 500 });

    await expect(stopAndRemoveContainer(
      harness.containerManager,
      'container-1',
      harness.logger,
      'cleanup context',
      10,
    )).resolves.toBe(false);
  });
});
