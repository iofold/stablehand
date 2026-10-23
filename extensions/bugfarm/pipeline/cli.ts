#!/usr/bin/env node
// Bugfarm deterministic pipeline (spike). Run with:
//   node --experimental-strip-types extensions/bugfarm/pipeline/cli.ts <command> [args]
// Commands: scout | build-env | check | package | controls | run | clean
import { readFileSync } from 'node:fs';
import { SHORTLIST } from './lib/config.ts';
import { log, parseArgs } from './lib/util.ts';

const USAGE = `usage: cli.ts <command> [options]

  scout     [--repos a/b,c/d] [--no-suite] [--suite-timeout-sec 600]
            Mine candidate fixes per repo, build each env, time the suite, rank -> results/scout.json
  build-env <owner/repo> [--dockerfile path] [--force]
            Build bugfarm/env-<slug>:<head> and confirm pytest collects -> results/<slug>/env.json
  check     <owner/repo> [--limit N] [--shas a,b] [--concurrency 3]
            Fail-to-pass / pass-to-pass check per candidate -> results/<slug>/checks/*.json
  package   <owner/repo>
            Write Harbor tasks for accepted checks -> tasks/<slug>/<task>/ and results/<slug>/swebench.jsonl
  controls  <owner/repo> [--tasks name1,name2]
            harbor run -a oracle (must be 1) and -a nop (must be 0) -> results/<slug>/controls.json
  run       <owner/repo> [--limit N] [--concurrency 3]
            All of the above for N candidates, then print the funnel -> results/<slug>/funnel.json
  clean     Remove containers any pipeline run started and left behind (never Harbor trials)
  prune-cache [--all] [--dry-run]
            Remove build-cache records left by task builds (--all: env builds too); only steps
            unique to this pipeline's Dockerfiles are matched
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, repoArg] = args._;
  const num = (k: string, d: number) => (typeof args[k] === 'string' ? Number(args[k]) : d);
  const list = (k: string) => (typeof args[k] === 'string' ? String(args[k]).split(',').filter(Boolean) : undefined);
  const needRepo = () => {
    if (!repoArg || !repoArg.includes('/')) throw new Error(`missing <owner/repo>\n\n${USAGE}`);
    return repoArg;
  };

  switch (cmd) {
    case 'scout': {
      const { scout } = await import('./lib/scout.ts');
      const res = await scout(list('repos') ?? SHORTLIST, { measureSuite: !args['no-suite'], suiteTimeoutMs: num('suite-timeout-sec', 600) * 1000 });
      for (const r of res) {
        console.log(`${r.repo.padEnd(22)} score=${String(r.score).padEnd(6)} candidates=${String(r.candidates).padEnd(4)} commits=${r.funnel.commits_since ?? 0} suite=${r.suite ? `${r.suite.seconds}s (${r.suite.passed} passed${r.suite.timed_out ? ', timed out' : ''})` : r.env ? `env ${r.env.reason}` : 'n/a'}`);
      }
      console.log(`pick: ${res[0]?.repo}`);
      break;
    }
    case 'build-env': {
      const { buildEnv } = await import('./lib/build-env.ts');
      const dockerfileText = typeof args.dockerfile === 'string' ? readFileSync(args.dockerfile, 'utf8') : undefined;
      const r = await buildEnv(needRepo(), { dockerfileText, force: Boolean(args.force) });
      console.log(JSON.stringify({ ...r, dockerfile: undefined }, null, 2));
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case 'check': {
      const { checkRepo } = await import('./lib/run.ts');
      const r = await checkRepo(needRepo(), { limit: num('limit', 40), shas: list('shas'), concurrency: num('concurrency', 3) });
      console.log(`accepted ${r.filter((c) => c.accepted).length}/${r.length}`);
      break;
    }
    case 'package': {
      const { packageAccepted } = await import('./lib/run.ts');
      const r = await packageAccepted(needRepo());
      console.log(`packaged ${r.length} tasks`);
      break;
    }
    case 'controls': {
      const { runControlsForRepo } = await import('./lib/run.ts');
      const r = await runControlsForRepo(needRepo(), { tasks: list('tasks') });
      console.log(JSON.stringify(r.summary, null, 2));
      break;
    }
    case 'run': {
      const { runPipeline, printFunnel } = await import('./lib/run.ts');
      const f = await runPipeline(needRepo(), { limit: num('limit', 30), concurrency: num('concurrency', 3) });
      printFunnel(f);
      break;
    }
    case 'clean': {
      const { removeLabelledContainers } = await import('./lib/docker.ts');
      console.log(`removed ${await removeLabelledContainers({ all: true })} containers`);
      break;
    }
    case 'prune-cache': {
      const { pruneOwnBuildCache } = await import('./lib/docker.ts');
      const { TASK_BUILD_STEPS, envBuildSteps } = await import('./lib/repos.ts');
      const steps = args.all ? [...TASK_BUILD_STEPS, ...envBuildSteps()] : TASK_BUILD_STEPS;
      const r = await pruneOwnBuildCache(steps, { dryRun: Boolean(args['dry-run']) });
      console.log(`${args['dry-run'] ? 'would prune' : 'pruned'} ${r.records} records, ${(r.bytes / 1e9).toFixed(2)} GB`);
      break;
    }
    default:
      console.log(USAGE);
      if (cmd) process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  log('error', e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
