import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const CONTAINER_SCOPE_LABEL = 'ctxmill.scope-id';

export function resolveContainerScopeIdentity(explicitIdentity?: string): string {
  return explicitIdentity
    ?? process.env.CTXMILL_CONTAINER_SCOPE
    ?? process.env.CTXMILL_DATA_VOLUME
    ?? (process.env.CTXMILL_DATA_DIR ? resolve(process.env.CTXMILL_DATA_DIR) : process.cwd());
}

export function resolveContainerScopeId(explicitIdentity?: string): string {
  const digest = createHash('sha256')
    .update(resolveContainerScopeIdentity(explicitIdentity))
    .digest('hex')
    .slice(0, 24);
  return `s-${digest}`;
}
