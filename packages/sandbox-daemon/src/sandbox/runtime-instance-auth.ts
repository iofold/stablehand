import { createHash, timingSafeEqual } from 'node:crypto';
import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import {
  RUNTIME_INSTANCE_TOKEN_ENV,
  RUNTIME_INSTANCE_TOKEN_HEADER,
} from '@stablehand/shared';

export {
  RUNTIME_INSTANCE_TOKEN_ENV,
  RUNTIME_INSTANCE_TOKEN_HEADER,
};

type RuntimeInstanceAuthEnv = Readonly<Record<string, string | undefined>>;

function nonEmptyTrimmed(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function tokensEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(digestToken(presented), digestToken(expected));
}

export function createRuntimeInstanceAuthInterceptor(
  env: RuntimeInstanceAuthEnv = process.env,
): Interceptor {
  const expectedToken = nonEmptyTrimmed(env[RUNTIME_INSTANCE_TOKEN_ENV]);

  return (next) => async (request) => {
    if (!expectedToken) {
      throw new ConnectError(
        'Sandbox runtime instance token is not configured',
        Code.Unauthenticated,
      );
    }

    const presentedToken = nonEmptyTrimmed(
      request.header.get(RUNTIME_INSTANCE_TOKEN_HEADER),
    );
    if (!presentedToken || !tokensEqual(presentedToken, expectedToken)) {
      throw new ConnectError(
        'Invalid sandbox runtime instance token',
        Code.Unauthenticated,
      );
    }

    return await next(request);
  };
}
