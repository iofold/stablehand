/**
 * Reads secrets from the tmpfs mount inside the sandbox container.
 *
 * The orchestrator writes a JSON file at `/run/secrets/config.json` before
 * starting the sandbox. This module reads and parses it into a plain
 * key-value map suitable for use as `ResolvedSecrets`.
 */

import { readFile } from 'node:fs/promises';

/** Default path where the orchestrator mounts secrets. */
export const DEFAULT_SECRETS_PATH = '/run/secrets/config.json';

/**
 * Read secrets from the given path (defaults to `/run/secrets/config.json`).
 *
 * Returns an empty map when the file doesn't exist — this lets the daemon
 * start in dev mode without a tmpfs mount.
 */
export async function readSecrets(
  path: string = DEFAULT_SECRETS_PATH,
): Promise<Record<string, string>> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`[sandbox] secrets file at ${path} is not a JSON object — ignoring`);
      return {};
    }

    // Coerce all values to strings for safety.
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      result[key] = String(value);
    }
    return result;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`[sandbox] secrets file not found at ${path} — running without secrets`);
      return {};
    }
    console.error(`[sandbox] failed to read secrets from ${path}:`, err);
    return {};
  }
}
