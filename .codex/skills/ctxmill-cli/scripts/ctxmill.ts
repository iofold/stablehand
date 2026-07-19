#!/usr/bin/env bun

import { runOpsCli } from '../../../../packages/ctxmill/src/cli/ops.ts';

process.exitCode = await runOpsCli(Bun.argv.slice(2));
