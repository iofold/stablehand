#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { scaffold } from './scaffold.js';
import { DEFAULT_TEMPLATE, TEMPLATES } from './templates.js';

const USAGE = `Usage: create-stablehand <project-dir> [--template <name>]

Templates:
${TEMPLATES.map((template) => `  ${template.name.padEnd(20)} ${template.description}${template.name === DEFAULT_TEMPLATE ? ' (default)' : ''}`).join('\n')}
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    template: { type: 'string', short: 't' },
    'list-templates': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || values['list-templates']) {
  console.log(USAGE);
  process.exit(0);
}

const projectName = positionals[0];
if (!projectName) {
  console.error(USAGE);
  process.exit(1);
}

const projectDir = resolve(projectName);
if (existsSync(projectDir) && readdirSync(projectDir).length > 0) {
  console.error(`${projectName} already exists and is not empty.`);
  process.exit(1);
}
const packageName = basename(projectDir);

try {
  const template = scaffold({
    projectDir,
    packageName,
    template: values.template,
    openaiApiKey: process.env.OPENAI_API_KEY,
  });
  console.log(`\nCreated ${projectName}/ from the ${template.name} template.\n`);
  console.log('Next steps:');
  console.log(`  cd ${projectName}`);
  if (!process.env.OPENAI_API_KEY) {
    console.log('  # add OPENAI_API_KEY to .env (the other secrets are already generated)');
  }
  for (const step of template.nextSteps) {
    console.log(`  ${step}`);
  }
  console.log('');
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
