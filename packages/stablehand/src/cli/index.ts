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
  case 'ops': {
    const { runOpsCli } = await import('./ops.js');
    process.exitCode = await runOpsCli(process.argv.slice(3));
    break;
  }
  default:
    console.log(`
Stablehand - Build vertical AI products

Commands:
  stablehand dev          Start the orchestrator process (container entrypoint)
  stablehand chat         Chat with agent in terminal via the running Docker stack
  stablehand ops          Operate a running stablehand API (agent-safe JSON and exit codes)

Options:
  --help               Show help
  --version            Show version
`);
}
