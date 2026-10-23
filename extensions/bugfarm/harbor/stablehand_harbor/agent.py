"""``StablehandAgent``: a Harbor agent whose turns run on a Stablehand harness.

Per trial:

1. Start a relay on the Docker bridge that serves ``task_bash``, ``task_read``,
   ``task_write`` and ``task_submit`` against the trial's environment, guarded by
   a fresh bearer secret.
2. Create a solver agent on Stablehand with the chosen harness and model,
   ``egress: {mode: "deny"}`` and those HTTP tools (the secret is a tools-scope
   agent secret, so it never enters the sandbox).
3. Start a background turn tagged ``{campaign, bench_cell, task, trial}`` with the
   task's instruction, and wait for it.
4. Fetch the full turn messages and write ``trajectory.json`` (ATIF) plus the raw
   turn next to it. Harbor's verifier grades the container as usual.

Run it with::

    harbor run -p <tasks> --agent stablehand_harbor:StablehandAgent \\
        --ak harness=pi --ak model=gpt-5.4-mini --ak campaign=my-bench

``STABLEHAND_API_TOKEN`` (and optionally ``STABLEHAND_API_URL``) come from the
environment, never from agent kwargs, so the token stays out of job configs.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import secrets
import time
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path
from typing import Annotated, Any, Literal

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.agents.options import AgentOptions, Env
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.result import AgentInfo, ModelInfo
from harbor.utils.trajectory_utils import format_trajectory_json
from pydantic import Field

from stablehand_harbor.client import TERMINAL_TURN_STATUSES, StablehandClient
from stablehand_harbor.relay import RelayLimits, TaskRelay, tool_definitions, wait_closed
from stablehand_harbor.trajectory import build_trajectory, fill_context

RELAY_SECRET_NAME = "TASK_RELAY_TOKEN"

HARNESS_ALIASES: dict[str, str] = {
    "claude-agents": "claude-agents",
    "claude": "claude-agents",
    "pi": "pi-agent",
    "pi-agent": "pi-agent",
    "langgraph": "langgraph",
}

# Harness-native tools that reach the internet from outside the sandbox's
# egress proxy (Claude's web search runs on the provider's side). Benchmark
# solvers must not look the fix up, so these are denied by default.
WEB_TOOLS_BY_HARNESS: dict[str, list[str]] = {
    "claude-agents": ["WebSearch", "WebFetch"],
}

SYSTEM_PROMPT = """\
You are a software engineer solving a task in a separate task environment: a Linux container.

Where things are:
- The task's files, repository and tools exist only in the task environment. Reach it only with the task_* tools:
  - task_bash runs a bash command there (working directory {workdir}). Use it to explore, run tests, and make \
targeted edits, for example with sed or a short python script.
  - task_read returns a file's contents (pass startLine and endLine for part of a long file); task_write replaces a \
whole file.
  - task_submit records that you are finished.
- Your own built-in tools (shell, file listing, reading and writing, subagents, and so on) run on a different \
machine: your sandbox. It holds only the agent runtime, which may include its own /app or /workspace directories. \
None of that is the task, and those tools cannot see or change the task environment. Every path in the task, such \
as {workdir}, means the task environment. Do not use your own tools for the task.
- Neither environment has internet access.

Work until the task is done. Check your change by running the relevant tests in the task environment with \
task_bash, then call task_submit once and stop.
"""

TASK_REMINDER = """

---
The task's files are only in the task environment (working directory: {workdir}). Work there with task_bash, \
task_read and task_write. Your own built-in tools run in a different sandbox whose files are unrelated to this task, \
even where paths look alike. Call task_submit when you are done."""


def normalize_harness(raw: str) -> str:
    harness = HARNESS_ALIASES.get(raw.strip().lower())
    if harness is None:
        known = ", ".join(sorted(HARNESS_ALIASES))
        raise ValueError(f"Unknown Stablehand harness {raw!r}; use one of: {known}")
    return harness


def infer_provider(model: str) -> str:
    name = model.lower()
    if name.startswith("claude") or "anthropic" in name:
        return "anthropic"
    if name.startswith("gemini"):
        return "google"
    return "openai"


def slug(value: str, limit: int = 120) -> str:
    cleaned = re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-")
    return cleaned[:limit].rstrip("-") or "x"


def _package_version() -> str:
    try:
        return package_version("stablehand-harbor")
    except PackageNotFoundError:
        return "0.0.0+local"


class StablehandAgentOptions(AgentOptions):
    harness: str = Field(description="Stablehand harness: claude-agents, pi (pi-agent) or langgraph.")
    model: str | None = Field(default=None, description="Gateway model name; defaults to Harbor's -m model.")
    provider: Literal["openai", "anthropic", "google"] | None = Field(
        default=None, description="Model provider; inferred from the model name when omitted."
    )
    campaign: Annotated[str, Env("STABLEHAND_CAMPAIGN", fallback="STABLEHAND_CAMPAIGN")] = Field(
        default="bench", description="Campaign tag on every turn; budgets select on it."
    )
    bench_cell: str | None = Field(default=None, description="Benchmark cell tag; defaults to <harness>/<model>.")
    api_url: Annotated[str, Env("STABLEHAND_API_URL", fallback="STABLEHAND_API_URL")] = Field(
        default="http://localhost:3002", description="Stablehand API base URL."
    )
    relay_bind: Annotated[str | None, Env("STABLEHAND_RELAY_BIND", fallback="STABLEHAND_RELAY_BIND")] = Field(
        default=None,
        description="Address the relay listens on; defaults to the Docker bridge gateway.",
    )
    relay_host: Annotated[str, Env("STABLEHAND_RELAY_HOST", fallback="STABLEHAND_RELAY_HOST")] = Field(
        default="host.docker.internal",
        description="Host name the Stablehand orchestrator uses to reach the relay (must be in its egress allowlist).",
    )
    relay_port: int = Field(default=0, ge=0, le=65535, description="Relay port; 0 picks a free one.")
    workdir: str | None = Field(default=None, description="Task working directory; defaults to the container's.")
    max_cost_usd: float = Field(default=2.0, gt=0, description="Spend cap for one trial's turn, in USD.")
    max_tool_calls: int = Field(default=250, gt=0, description="Tool-call cap for one trial's turn.")
    turn_timeout_sec: int = Field(default=1800, ge=60, le=3600, description="Stablehand turn timeout.")
    bash_max_timeout_sec: int = Field(default=240, ge=10, le=280, description="Longest task_bash command.")
    poll_interval_sec: float = Field(default=3.0, gt=0)
    cost_wait_sec: float = Field(default=60.0, ge=0, description="How long to wait for the turn's cost to settle.")
    post_submit_grace_sec: float = Field(
        default=90.0, ge=0, description="Cancel a turn still running this long after task_submit."
    )
    keep_agent: bool = Field(
        default=True, description="Keep the solver agent afterwards (deleting it also deletes its turns and spend)."
    )
    deny_web_tools: bool = Field(default=True, description="Deny harness-native web search and fetch tools.")
    native_tools: Literal["all", "none"] = Field(
        default="all",
        description="Harness-native tools (shell, files, subagents). 'none' leaves only the task_* tools.",
    )
    harness_config: dict[str, Any] | None = Field(default=None, description="Extra harnessConfig fields.")


async def detect_bridge_gateway() -> str:
    """The default Docker bridge's gateway, which is what host.docker.internal resolves to."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker",
            "network",
            "inspect",
            "bridge",
            "--format",
            "{{range .IPAM.Config}}{{.Gateway}} {{end}}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), 20)
    except (OSError, asyncio.TimeoutError) as exc:
        raise RuntimeError(
            "Could not inspect the Docker bridge network; set relay_bind (or STABLEHAND_RELAY_BIND)"
        ) from exc
    for token in out.decode().split():
        try:
            if ipaddress.ip_address(token).version == 4:
                return token
        except ValueError:
            continue
    raise RuntimeError("The Docker bridge has no IPv4 gateway; set relay_bind (or STABLEHAND_RELAY_BIND)")


class StablehandAgent(BaseAgent):
    capabilities = AgentCapabilities(atif=True)
    options_model = StablehandAgentOptions

    def __init__(self, logs_dir: Path, model_name: str | None = None, *args: Any, **kwargs: Any) -> None:
        super().__init__(logs_dir, model_name, *args, **kwargs)
        options = self.options
        if not isinstance(options, StablehandAgentOptions):
            raise TypeError("StablehandAgent options did not parse")
        self.opts: StablehandAgentOptions = options
        self.harness = normalize_harness(options.harness)
        model = options.model or self._parsed_model_name
        if not model:
            raise ValueError("StablehandAgent needs a model: pass --ak model=<gateway model> or -m <model>")
        self.model = model
        self.provider = options.provider or infer_provider(model)
        if self.harness == "claude-agents" and self.provider != "anthropic":
            raise ValueError("The claude-agents harness runs Anthropic models only")
        self.bench_cell = options.bench_cell or f"{self.harness}/{self.model}"

    # -- Harbor surface ----------------------------------------------------------

    @staticmethod
    def name() -> str:
        return "stablehand"

    def version(self) -> str | None:
        return _package_version()

    def to_agent_info(self) -> AgentInfo:
        return AgentInfo(
            name=f"stablehand-{self.harness}",
            version=self.version() or "unknown",
            model_info=ModelInfo(name=self.model, provider=self.provider),
        )

    @classmethod
    def preflight(cls, kwargs: dict[str, Any] | None = None, env: Any = None) -> None:
        super().preflight(kwargs, env)
        options = cls.parse_options(kwargs, env)
        if isinstance(options, StablehandAgentOptions):
            normalize_harness(options.harness)

    async def setup(self, environment: BaseEnvironment) -> None:
        if not self._api_token():
            raise ValueError("Set STABLEHAND_API_TOKEN for the StablehandAgent")
        async with self._client() as client:
            await client.health()

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        opts = self.opts
        token = secrets.token_urlsafe(32)
        trial = self._trial_name()
        task = self._task_name(trial)
        tags = {"campaign": opts.campaign, "bench_cell": self.bench_cell, "task": task, "trial": trial}
        meta: dict[str, Any] = {
            "harness": self.harness,
            "model": self.model,
            "tags": tags,
            "apiUrl": opts.api_url,
        }
        context.metadata = {"stablehand": meta}
        self.logs_dir.mkdir(parents=True, exist_ok=True)

        relay = TaskRelay(
            environment,
            token,
            workdir=opts.workdir,
            limits=RelayLimits(max_timeout_sec=opts.bash_max_timeout_sec),
            log_path=self.logs_dir / "relay.jsonl",
            logger=self.logger,
        )
        bind = opts.relay_bind or await detect_bridge_gateway()
        port = await relay.start(bind, opts.relay_port)
        base_url = f"http://{opts.relay_host}:{port}"
        meta["relay"] = {"bind": bind, "port": port, "url": base_url, "workdir": relay.workdir}
        self.logger.info("stablehand: relay for %s listening on %s:%s (%s)", trial, bind, port, base_url)

        client = self._client()
        agent_id: str | None = None
        turn_id: str | None = None
        turn: dict[str, Any] | None = None
        cancelled = False
        try:
            agent = await client.create_agent(self._agent_body(trial, task, relay.workdir))
            agent_id = agent["id"]
            relay.expected_agent_id = agent_id
            meta["agentId"] = agent_id
            meta["agentName"] = agent.get("name")
            await client.put_secret(agent_id, RELAY_SECRET_NAME, token, scope="tools")
            # Re-register the HTTP tools now that their secret exists.
            await client.patch_agent(
                agent_id,
                {
                    "httpTools": tool_definitions(
                        base_url,
                        secret_name=RELAY_SECRET_NAME,
                        max_timeout_sec=opts.bash_max_timeout_sec,
                    )
                },
            )
            started = await client.start_turn(
                agent_id,
                instruction + TASK_REMINDER.format(workdir=relay.workdir),
                tags=tags,
                idempotency_key=f"harbor-{self.context_id or trial}",
            )
            turn_id = started["turnId"]
            meta["turnId"] = turn_id
            meta["conversationId"] = started.get("conversationId")
            self.logger.info("stablehand: %s started turn %s on agent %s", trial, turn_id, agent_id)
            turn = await self._wait_for_turn(client, agent_id, turn_id, relay)
        except asyncio.CancelledError:
            cancelled = True
            if agent_id and turn_id:
                await _bounded(client.cancel_turn(agent_id, turn_id), 20, self.logger, "cancel turn")
            raise
        finally:
            try:
                if agent_id and turn_id:
                    final = await _bounded(
                        self._collect(client, agent_id, turn_id, instruction, context, relay, meta, settle=not cancelled),
                        opts.cost_wait_sec + 60 if not cancelled else 30,
                        self.logger,
                        "collect turn",
                    )
                    if final is not None:
                        turn = final
            finally:
                await wait_closed(relay)
                if agent_id:
                    await _bounded(
                        client.delete_secret(agent_id, RELAY_SECRET_NAME, scope="tools"), 20, self.logger, "drop secret"
                    )
                    if not opts.keep_agent:
                        await _bounded(client.delete_agent(agent_id), 30, self.logger, "delete agent")
                await client.aclose()

        if turn is not None and turn.get("status") == "ERROR":
            stop = turn.get("stopReason") or {}
            raise NonZeroAgentExitCodeError(
                f"Stablehand turn {turn_id} ended in ERROR: {turn.get('error') or 'no error text'}"
                + (f" ({stop.get('code')})" if isinstance(stop, dict) and stop.get("code") else "")
            )

    # -- helpers -------------------------------------------------------------------

    def _api_token(self) -> str | None:
        return self._get_env("STABLEHAND_API_TOKEN")

    def _client(self) -> StablehandClient:
        return StablehandClient(self.opts.api_url, self._api_token(), logger=self.logger)

    def _trial_name(self) -> str:
        session = self.session_id or ""
        if session.endswith("__agent"):
            return session[: -len("__agent")]
        return session or self.logs_dir.parent.name

    def _task_name(self, trial: str) -> str:
        """The task's directory name from the trial config, else the trial name's task part."""
        config_path = self.logs_dir.parent / "config.json"
        try:
            config = json.loads(config_path.read_text())
            task = config.get("task") or {}
            path = task.get("path")
            if isinstance(path, str) and path:
                return Path(path).name
            name = task.get("name")
            if isinstance(name, str) and name:
                return name.split("/")[-1]
        except (OSError, ValueError, AttributeError):
            pass
        return trial.split("__")[0]

    def _harness_config(self) -> dict[str, Any]:
        opts = self.opts
        config: dict[str, Any] = {
            "model": self.model,
            "limits": {"maxCostUsd": opts.max_cost_usd, "maxToolCalls": opts.max_tool_calls},
        }
        config["provider"] = self.provider
        if opts.harness_config:
            extra = dict(opts.harness_config)
            limits = extra.pop("limits", None)
            config.update(extra)
            if isinstance(limits, dict):
                config["limits"] = {**config["limits"], **limits}
        return config

    def _agent_body(self, trial: str, task: str, workdir: str) -> dict[str, Any]:
        opts = self.opts
        body: dict[str, Any] = {
            "name": slug(f"bench-{self.harness}-{self.model}-{trial}"),
            "description": f"Harbor solver for {task}: {self.bench_cell} (campaign {opts.campaign})",
            "harness": self.harness,
            "harnessConfig": self._harness_config(),
            "systemPrompt": SYSTEM_PROMPT.format(workdir=workdir),
            "tools": [],
            "builtinToolPolicy": {"policy": "none"},
            "egress": {"mode": "deny"},
            "mode": "background",
            "resourceLimits": {"timeoutSec": opts.turn_timeout_sec},
            "metadata": {
                "bench": {
                    "campaign": opts.campaign,
                    "benchCell": self.bench_cell,
                    "task": task,
                    "trial": trial,
                    "harborContextId": str(self.context_id) if self.context_id else None,
                }
            },
        }
        web_tools = WEB_TOOLS_BY_HARNESS.get(self.harness)
        if opts.native_tools == "none":
            body["nativeToolPolicy"] = {"policy": "none"}
        elif opts.deny_web_tools and web_tools:
            body["nativeToolPolicy"] = {"policy": "deny", "names": web_tools}
        return body

    async def _wait_for_turn(
        self, client: StablehandClient, agent_id: str, turn_id: str, relay: TaskRelay
    ) -> dict[str, Any]:
        opts = self.opts
        deadline = time.monotonic() + opts.turn_timeout_sec + 120
        cancel_sent_at: float | None = None
        while True:
            turn = await client.get_turn(turn_id)
            if turn.get("status") in TERMINAL_TURN_STATUSES:
                return turn
            now = time.monotonic()
            reason = None
            if relay.submitted_at is not None and time.time() - relay.submitted_at > opts.post_submit_grace_sec:
                reason = "still running after task_submit"
            elif now > deadline:
                reason = "past the turn timeout"
            if reason and cancel_sent_at is None:
                self.logger.warning("stablehand: cancelling turn %s (%s)", turn_id, reason)
                await client.cancel_turn(agent_id, turn_id)
                cancel_sent_at = now
            elif cancel_sent_at is not None and now - cancel_sent_at > 120:
                self.logger.warning("stablehand: turn %s did not stop after cancel", turn_id)
                return turn
            await asyncio.sleep(opts.poll_interval_sec)

    async def _collect(
        self,
        client: StablehandClient,
        agent_id: str,
        turn_id: str,
        instruction: str,
        context: AgentContext,
        relay: TaskRelay,
        meta: dict[str, Any],
        *,
        settle: bool,
    ) -> dict[str, Any]:
        if settle:
            await self._wait_for_cost(client, turn_id)
        detail = await client.get_turn_detail(agent_id, turn_id)
        turn = detail.get("turn") or {}
        (self.logs_dir / "stablehand-turn.json").write_text(json.dumps(detail, indent=2, ensure_ascii=False))

        relay_summary: dict[str, Any] = {
            "calls": len(relay.calls),
            "byTool": {},
            "submitted": relay.submitted,
        }
        for call in relay.calls:
            relay_summary["byTool"][call.tool] = relay_summary["byTool"].get(call.tool, 0) + 1
        if relay.submit_note:
            relay_summary["submitNote"] = relay.submit_note
        meta.update(
            {
                "status": turn.get("status"),
                "error": turn.get("error"),
                "stopReason": turn.get("stopReason"),
                "usage": turn.get("usage"),
                "gatewayCorrelationId": turn.get("gatewayCorrelationId"),
                "relayCalls": relay_summary,
            }
        )
        trajectory = build_trajectory(
            detail,
            agent_name=f"stablehand-{self.harness}",
            agent_version=self.version() or "unknown",
            model_name=self.model,
            session_id=self.session_id,
            system_prompt=SYSTEM_PROMPT.format(workdir=relay.workdir),
            instruction=instruction,
            extra={"stablehand": {key: meta.get(key) for key in ("agentId", "turnId", "conversationId", "tags")}},
        )
        (self.logs_dir / "trajectory.json").write_text(format_trajectory_json(trajectory.to_json_dict()))
        fill_context(context, turn)
        return turn

    async def _wait_for_cost(self, client: StablehandClient, turn_id: str) -> None:
        """Give the gateway reconciler a moment so the trial reports settled cost."""
        deadline = time.monotonic() + self.opts.cost_wait_sec
        while time.monotonic() < deadline:
            turn = await client.get_turn(turn_id)
            coverage = ((turn.get("usage") or {}).get("cost") or {}).get("coverage")
            if coverage in ("complete", "unpriced") or turn.get("gatewayMode") is None:
                return
            await asyncio.sleep(5)


async def _bounded(awaitable: Any, timeout: float, logger: Any, what: str) -> Any:
    try:
        return await asyncio.wait_for(awaitable, timeout)
    except Exception as exc:  # noqa: BLE001 - cleanup must not mask the trial's own outcome
        logger.warning("stablehand: could not %s: %s", what, exc)
        return None
