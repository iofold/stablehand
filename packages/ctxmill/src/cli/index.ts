#!/usr/bin/env node
import { parseArgs } from 'node:util';

const { positionals } = parseArgs({ allowPositionals: true, strict: false });
const command = positionals[0];

switch (command) {
  case 'dev':
    await import('./dev.js');
    break;
  case 'chat':
    await import('./chat.js');
    break;
  default:
    console.log(`
CTXMill - Build vertical AI products

Commands:
  ctxmill dev          Start the orchestrator process (container entrypoint)
  ctxmill chat         Chat with agent in terminal via the running Docker stack

Options:
  --help               Show help
  --version            Show version
`);
}
