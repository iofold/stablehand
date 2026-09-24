import { afterEach, describe, expect, it, vi } from 'vitest';

describe('fire-and-forget .catch() handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs error when fire-and-forget promise rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const rejectingFn = () => Promise.reject(new Error('executeRun exploded'));

    void rejectingFn().catch((err) => {
      console.error(`[agents] executeRun failed for agent test-agent, run test-run:`, err);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[agents] executeRun failed'),
      expect.any(Error),
    );
  });

  it('does not throw to caller when fire-and-forget rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    let callerCaughtError = false;
    try {
      const rejectingFn = () => Promise.reject(new Error('boom'));
      void rejectingFn().catch((err) => {
        console.error('[test] caught:', err);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } catch {
      callerCaughtError = true;
    }

    expect(callerCaughtError).toBe(false);
  });
});
