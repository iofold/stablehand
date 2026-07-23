import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it, vi } from 'vitest';

import {
  RUNTIME_INSTANCE_TOKEN_ENV,
  RUNTIME_INSTANCE_TOKEN_HEADER,
  createRuntimeInstanceAuthInterceptor,
} from '../runtime-instance-auth.js';

describe('sandbox runtime instance authentication', () => {
  it('rejects a delayed request carrying a predecessor container token before dispatch', async () => {
    const interceptor = createRuntimeInstanceAuthInterceptor({
      [RUNTIME_INSTANCE_TOKEN_ENV]: 'successor-token',
    });
    const next = vi.fn(async () => ({ mutated: true }));
    const request = {
      header: new Headers({
        [RUNTIME_INSTANCE_TOKEN_HEADER]: 'predecessor-token',
      }),
    };

    const failure = await interceptor(next as never)(request as never).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ConnectError);
    expect((failure as ConnectError).code).toBe(Code.Unauthenticated);
    expect(next).not.toHaveBeenCalled();
  });

  it('dispatches a request carrying the token belonging to this container instance', async () => {
    const interceptor = createRuntimeInstanceAuthInterceptor({
      [RUNTIME_INSTANCE_TOKEN_ENV]: 'successor-token',
    });
    const next = vi.fn(async () => ({ mutated: true }));
    const request = {
      header: new Headers({
        [RUNTIME_INSTANCE_TOKEN_HEADER]: 'successor-token',
      }),
    };

    await expect(
      interceptor(next as never)(request as never),
    ).resolves.toEqual({ mutated: true });
    expect(next).toHaveBeenCalledOnce();
  });

  it('fails closed when the container has no runtime instance token', async () => {
    const interceptor = createRuntimeInstanceAuthInterceptor({});
    const next = vi.fn(async () => ({ mutated: true }));

    const failure = await interceptor(next as never)(
      { header: new Headers() } as never,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConnectError);
    expect((failure as ConnectError).code).toBe(Code.Unauthenticated);
    expect(next).not.toHaveBeenCalled();
  });
});
