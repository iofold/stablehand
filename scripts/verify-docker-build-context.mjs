#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Exercise Docker's own ignore matcher without sending any real checkout files
// or credentials to the builder. No base image or network access is needed.
const root = process.cwd();
mkdirSync(join(root, '.tmp'), { recursive: true });
const fixture = mkdtempSync(join(root, '.tmp', 'docker-context-security-'));
const context = join(fixture, 'context');
const output = join(fixture, 'output');
const excluded = [
  '.env',
  '.env.production',
  'packages/examples/finance-dashboard/.env',
  'packages/examples/nested/.env.local',
  'packages/examples/nested/.npmrc',
  'packages/examples/nested/credentials.json',
  'packages/examples/nested/secrets.json',
  'packages/examples/nested/service-account-test.json',
  'packages/examples/nested/private.pem',
  'packages/examples/nested/private.key',
  'packages/examples/nested/id_ed25519',
];
const retained = ['.env.example', 'packages/examples/nested/.env.example', 'packages/examples/nested/agent.yaml'];

try {
  mkdirSync(context);
  copyFileSync(join(root, '.dockerignore'), join(context, '.dockerignore'));
  writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /context/\n');
  for (const name of [...excluded, ...retained]) {
    const path = join(context, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'SYNTHETIC_BUILD_CONTEXT_FIXTURE\n');
  }
  execFileSync('docker', ['build', '--progress=plain', '--output', `type=local,dest=${output}`, context], {
    stdio: 'inherit',
    timeout: 120_000,
  });
  for (const name of excluded) {
    assert.equal(existsSync(join(output, 'context', name)), false, `Credential file entered the Docker image: ${name}`);
  }
  for (const name of retained) {
    assert.equal(existsSync(join(output, 'context', name)), true, `Required example/source file was excluded: ${name}`);
  }
  console.log(`Docker build context: ${excluded.length} credential fixtures excluded; ${retained.length} examples/source fixtures retained.`);
} finally {
  rmSync(resolve(fixture), { recursive: true, force: true });
}
