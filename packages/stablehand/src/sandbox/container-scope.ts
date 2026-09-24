import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const CONTAINER_SCOPE_LABEL = 'stablehand.scope-id';

export function resolveContainerScopeIdentity(explicitIdentity?: string): string {
  return explicitIdentity
    ?? process.env.STABLEHAND_CONTAINER_SCOPE
    ?? process.env.STABLEHAND_DATA_VOLUME
    ?? (process.env.STABLEHAND_DATA_DIR ? resolve(process.env.STABLEHAND_DATA_DIR) : process.cwd());
}

export function resolveContainerScopeId(explicitIdentity?: string): string {
  const digest = createHash('sha256')
    .update(resolveContainerScopeIdentity(explicitIdentity))
    .digest('hex')
    .slice(0, 24);
  return `s-${digest}`;
}
