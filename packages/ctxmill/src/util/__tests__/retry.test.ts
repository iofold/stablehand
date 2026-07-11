import { describe, it, expect, vi } from 'vitest';

import { retryWithBackoff } from '@ctxmill/sandbox-daemon';

describe('retryWithBackoff', () => {
  it('succeeds on first attempt without delay', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await retryWithBackoff(fn, { delays: [100, 200] });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on second attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');
    const onRetry = vi.fn();

    const result = await retryWithBackoff(fn, { delays: [10, 20], onRetry });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 0, 10);
  });

  it('exhausts all retries and throws last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(
      retryWithBackoff(fn, { delays: [1, 1, 1] }),
    ).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('stops retrying when shouldRetry returns false', async () => {
    const nonRetryableError = new Error('bad request');
    const fn = vi.fn().mockRejectedValue(nonRetryableError);

    await expect(
      retryWithBackoff(fn, {
        delays: [1, 1, 1],
        shouldRetry: () => false,
      }),
    ).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry with correct arguments', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('err1'))
      .mockRejectedValueOnce(new Error('err2'))
      .mockResolvedValue('ok');
    const onRetry = vi.fn();

    await retryWithBackoff(fn, { delays: [10, 20, 30], onRetry });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: 'err1' }),
      0,
      10,
    );
    expect(onRetry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: 'err2' }),
      1,
      20,
    );
  });

  it('works with empty delays array (single attempt)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fails'));

    await expect(
      retryWithBackoff(fn, { delays: [] }),
    ).rejects.toThrow('fails');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes through non-Error rejections', async () => {
    const fn = vi.fn().mockRejectedValue('string error');

    await expect(
      retryWithBackoff(fn, { delays: [] }),
    ).rejects.toBe('string error');
  });
});
