# stablehand-harbor

A [Harbor](https://harborframework.com) agent that solves a Harbor task with a Stablehand harness
(`claude-agents`, `pi` or `langgraph`). Bugfarm's benchmark uses it to put Stablehand's harness × model
cells next to Harbor's own agents. It is option C of
`docs/plans/proposals/2026-09-28-harbor-task-execution.md`.

## How a trial runs

```
harbor (host) ── StablehandAgent.run ──┬─ relay on the Docker bridge (aiohttp, per-trial bearer secret)
                                       │     task_bash / task_read / task_write / task_submit
                                       │     └─ environment.exec / upload_file / download_file ─▶ task container
                                       └─ Stablehand API
                                             create solver agent: harness + model, egress deny,
                                             HTTP tools ─▶ http://host.docker.internal:<port>/task_*
                                             start a background turn tagged {campaign, bench_cell, task, trial}
                                             poll; then GET /api/agents/:id/turns/:turnId (full messages)
                                             ─▶ agent/trajectory.json (ATIF) + agent/stablehand-turn.json
```

- Harbor keeps the task environment (local Docker, `network_mode: none`) and grades it with its own
  verifier. The relay is the only way into the container.
- Each trial gets its own solver agent, so no workspace or memory carries over between attempts. Agents
  are kept by default: deleting an agent also deletes its turns and their spend history.
- The solver sandbox has `egress: {mode: "deny"}` (model gateway only). Claude's `WebSearch` and
  `WebFetch` are denied because web search runs on the provider's side, outside the sandbox proxy.
  Stablehand's built-in tools (approval requests, events, UI blocks) are off. Other harness-native tools
  stay on, and the prompt says they act on the solver's own sandbox, not the task. That sandbox holds the
  runtime, including its own `/app`, which a task's `/app` can be mistaken for: in a trial, LangGraph with
  gpt-5.4-mini explored and "fixed" the runtime's files instead of the task's. `--ak native_tools=none`
  leaves only the `task_*` tools for a cell where that happens. The benchmark leaves LangGraph out of its
  default cells for this reason; its optional cell runs with `native_tools: none` and says so on the
  leaderboard (`../bench/cells.json`).
- The relay secret is a tools-scope agent secret: the orchestrator sends it, the sandbox never sees it.
  It is deleted when the trial ends.
- A turn that ends in `ERROR` raises `NonZeroAgentExitCodeError`, so Harbor records it and still runs the
  verifier. A Harbor timeout cancels the turn.

## Requirements on the Stablehand side

The orchestrator's SSRF guard blocks private addresses, so it must allow the relay host:

```
STABLEHAND_EGRESS_ALLOWLIST=host.docker.internal   # in the stack's .env, then recreate the orchestrator
```

The compose file already maps `host.docker.internal` to the host gateway. By default the relay binds the
default Docker bridge's gateway (what `host.docker.internal` resolves to), not a public interface.

The allowlist names hosts, not ports (`hostMatchesAllowlist` in `packages/stablehand/src/util/egress.ts`
matches the hostname only), so this entry lets agent HTTP tools reach any port on the host gateway, not
just the relay's. What guards the relay is its per-trial bearer secret, which only the orchestrator holds.
Narrowing the entry to the relay's port needs `host:port` entries in core. Until then, bind other host
services to `127.0.0.1` rather than `0.0.0.0`: a service on the loopback address cannot be reached
through the bridge gateway.

## Run

For a benchmark over many cells, use the runner in [`../bench`](../bench/README.md): it runs this agent
and terminus-2 side by side under one campaign budget, resumes after a crash, and fills the leaderboard.
By hand:

```bash
cd extensions/bugfarm/harbor
uv sync
export STABLEHAND_API_TOKEN=...            # master token; never pass it as --ak
export STABLEHAND_API_URL=http://localhost:3002
export HARBOR_TELEMETRY=0

# Once per campaign: a cost-blocking budget on the campaign tag, and a campaign gateway key under it
# (the key is written to ~/.config/stablehand-harbor/<campaign>.key, mode 0600, for Harbor-side calls).
uv run stablehand-harbor campaign --campaign bugfarm-dev-bench --cap-usd 10

uv run harbor run -p /path/to/tasks --jobs-dir "$PWD/.jobs" -n 2 \
  --agent stablehand_harbor:StablehandAgent \
  --ak harness=pi --ak model=gpt-5.4-mini --ak campaign=bugfarm-dev-bench

uv run stablehand-harbor spend --campaign bugfarm-dev-bench
uv run stablehand-harbor probe-egress --agent-id <solver agent id> --campaign bugfarm-dev-bench
```

Harbor's `-m` works in place of `--ak model=`. Other kwargs (`harbor agent schema
stablehand_harbor:StablehandAgent` lists them all): `provider`, `bench_cell`, `max_cost_usd` (per trial,
default 2), `max_tool_calls`, `turn_timeout_sec`, `bash_max_timeout_sec`, `keep_agent`,
`deny_web_tools`, `native_tools` (`all` or `none`), `harness_config` (JSON merged into the harness config), `relay_bind`, `relay_host`,
`relay_port`, `workdir`.

Running next to the Bugfarm pipeline: the pipeline's cleanup (`removeLabelledContainers`) removes every
container labelled `bugfarm=1`, and Bugfarm task images carry that label, so it also kills benchmark
trials in flight. Until that cleanup is scoped to the pipeline's own runs, benchmark task copies need a
different value (`LABEL bugfarm=bench` in `environment/Dockerfile` and in the compose labels).

How a campaign's spend is capped: harness turns run on Stablehand's per-session gateway keys and are
counted by their `campaign` tag, so the budget blocks new turns at admission and caps each turn mid-run.
The campaign key is for model calls made outside Stablehand (for example terminus-2 cells) and counts
against the same budget.

## Tests

```bash
uv run pytest
```
