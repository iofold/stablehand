#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scaffold } from './scaffold.js';

const { positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'no-interactive': { type: 'boolean', default: false },
  },
  strict: false,
});

const projectName = positionals[0];
if (!projectName) {
  console.error('Usage: create-stablehand <project-name>');
  process.exit(1);
}

const projectDir = resolve(projectName);
const packageName = basename(projectDir);
console.log(`\nCreating Stablehand project: ${packageName}\n`);

scaffold({ projectDir, packageName });

console.log(`  Created ${projectName}/`);
console.log('');
console.log('  Next steps:');
console.log(`    cd ${projectName}`);
console.log('    cp .env.example .env');
console.log('    # Add your API keys to .env');
console.log('    docker compose up --build');
console.log('    docker compose exec orchestrator npx stablehand chat');
console.log('');
