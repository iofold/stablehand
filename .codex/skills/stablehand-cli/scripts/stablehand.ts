#!/usr/bin/env bun

import { runOpsCli } from '../../../../packages/stablehand/src/cli/ops.ts';

process.exitCode = await runOpsCli(Bun.argv.slice(2), {
  invocation: 'bun scripts/stablehand.ts',
});
