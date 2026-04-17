#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_URL = process.env.CTXMILL_VERIFY_API_URL ?? 'http://localhost:3002/api/health';
const UI_URL = process.env.CTXMILL_VERIFY_UI_URL ?? 'http://localhost:3200';
const WAIT_TIMEOUT_MS = Number(process.env.CTXMILL_VERIFY_TIMEOUT_MS ?? 5 * 60 * 1000);
const POLL_INTERVAL_MS = 2_000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

async function waitForHttp(url, label) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastError = 'unknown error';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok) {
        console.log(`[verify:fresh-deploy] ${label} ready at ${url}`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }

  throw new Error(`${label} did not become ready at ${url} within ${WAIT_TIMEOUT_MS}ms (${lastError})`);
}

try {
  console.log('[verify:fresh-deploy] rebuilding Docker services');
  run('docker', ['compose', 'up', '--build', '-d']);

  console.log('[verify:fresh-deploy] waiting for API and UI health');
  await waitForHttp(API_URL, 'API');
  await waitForHttp(UI_URL, 'UI');

  console.log('[verify:fresh-deploy] running deterministic smoke suite');
  run('pnpm', ['exec', 'playwright', 'test', '--config=playwright.smoke.config.ts']);

  console.log('[verify:fresh-deploy] success');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[verify:fresh-deploy] failed: ${message}`);
  try {
    run('docker', ['compose', 'ps']);
  } catch {}
  try {
    run('docker', ['compose', 'logs', '--tail', '200', 'orchestrator', 'ui']);
  } catch {}
  process.exitCode = 1;
}
