from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path

import httpx
import pytest
from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory

from stablehand_harbor import agent as agent_module
from stablehand_harbor.agent import StablehandAgent, infer_provider, normalize_harness, slug
from stablehand_harbor.client import StablehandClient

ENV = {"STABLEHAND_API_TOKEN": "test-token"}


def _agent(tmp_path: Path, **kwargs) -> StablehandAgent:
    logs = tmp_path / "trial" / "agent"
    logs.mkdir(parents=True, exist_ok=True)
    agent = StablehandAgent(logs_dir=logs, extra_env=ENV, **kwargs)
    agent.session_id = "fastapi-0f3e7bd682__AbCdEfG__agent"
    agent.context_id = uuid.UUID("594025f3-7d65-4655-8576-4bee95002eae")
    return agent


def test_harness_aliases_and_provider_inference():
    assert normalize_harness("pi") == "pi-agent"
    assert normalize_harness("Claude-Agents") == "claude-agents"
    assert normalize_harness("langgraph") == "langgraph"
    with pytest.raises(ValueError):
        normalize_harness("codex")
    assert infer_provider("claude-sonnet-5") == "anthropic"
    assert infer_provider("gemini-3.6-flash") == "google"
    assert infer_provider("gpt-5.4-mini") == "openai"
    assert slug("bench-pi-agent-GPT 5.4/mini") == "bench-pi-agent-gpt-5.4-mini"


def test_options_are_validated(tmp_path):
    with pytest.raises(ValueError, match="Unknown option"):
        _agent(tmp_path, harness="pi", model="gpt-5.4-mini", bogus=1)
    with pytest.raises(ValueError, match="needs a model"):
        _agent(tmp_path, harness="pi")
    with pytest.raises(ValueError, match="Anthropic models only"):
        _agent(tmp_path, harness="claude-agents", model="gpt-5.4-mini")
    # Harbor's -m works as the model too.
    assert _agent(tmp_path, model_name="anthropic/claude-sonnet-5", harness="claude").model == "claude-sonnet-5"


def test_agent_body_denies_egress_and_web_tools(tmp_path):
    claude = _agent(tmp_path, harness="claude-agents", model="claude-sonnet-5", campaign="bench-x", max_cost_usd=1.5)
    body = claude._agent_body("fastapi-0f3e7bd682__AbCdEfG", "fastapi-0f3e7bd682", "/app")
    assert body["egress"] == {"mode": "deny"}
    assert body["builtinToolPolicy"] == {"policy": "none"}
    assert body["nativeToolPolicy"] == {"policy": "deny", "names": ["WebSearch", "WebFetch"]}
    assert body["harness"] == "claude-agents"
    assert body["harnessConfig"] == {
        "model": "claude-sonnet-5",
        "provider": "anthropic",
        "limits": {"maxCostUsd": 1.5, "maxToolCalls": 250},
    }
    assert body["name"] == "bench-claude-agents-claude-sonnet-5-fastapi-0f3e7bd682__abcdefg"
    assert "/app" in body["systemPrompt"] and "task_bash" in body["systemPrompt"]
    assert "httpTools" not in body

    pi = _agent(tmp_path, harness="pi", model="gpt-5.4-mini", harness_config={"thinkingLevel": "low", "limits": {"maxModelCalls": 80}})
    pi_body = pi._agent_body("t", "task", "/app")
    assert "nativeToolPolicy" not in pi_body
    assert pi_body["harness"] == "pi-agent"
    assert pi_body["harnessConfig"]["thinkingLevel"] == "low"
    assert pi_body["harnessConfig"]["limits"] == {"maxCostUsd": 2.0, "maxToolCalls": 250, "maxModelCalls": 80}
    assert pi.bench_cell == "pi-agent/gpt-5.4-mini"

    bare = _agent(tmp_path, harness="langgraph", model="gpt-5.4-mini", native_tools="none")
    assert bare._agent_body("t", "task", "/app")["nativeToolPolicy"] == {"policy": "none"}


def test_task_name_comes_from_the_trial_config(tmp_path):
    agent = _agent(tmp_path, harness="pi", model="gpt-5.4-mini")
    trial = agent._trial_name()
    assert trial == "fastapi-0f3e7bd682__AbCdEfG"
    assert agent._task_name(trial) == "fastapi-0f3e7bd682"
    (agent.logs_dir.parent / "config.json").write_text(json.dumps({"task": {"path": "/tasks/fastapi-89317c7003"}}))
    assert agent._task_name(trial) == "fastapi-89317c7003"


class FakeStablehand:
    """Just enough of the Stablehand API; the 'turn' calls the relay like the orchestrator would."""

    def __init__(self, script, *, final_status="COMPLETED"):
        self.script = script
        self.final_status = final_status
        self.agent_body: dict | None = None
        self.http_tools: list[dict] = []
        self.secret: dict | None = None
        self.secret_deleted = False
        self.turn_body: dict | None = None
        self.turn_headers: dict | None = None
        self.status = "QUEUED"
        self.messages: list[dict] = []
        self.task: asyncio.Task | None = None

    async def handler(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        assert request.headers["Authorization"] == "Bearer test-token"
        if path == "/api/health":
            return httpx.Response(200, json={"status": "ok"})
        if method == "POST" and path == "/api/agents":
            self.agent_body = json.loads(request.content)
            return httpx.Response(201, json={"id": "agent-1", "name": self.agent_body["name"]})
        if method == "POST" and path == "/api/agents/agent-1/secrets":
            self.secret = json.loads(request.content)
            return httpx.Response(201, json={"key": self.secret["key"]})
        if method == "DELETE" and path == "/api/agents/agent-1/secrets/TASK_RELAY_TOKEN":
            assert request.url.params["scope"] == "tools"
            self.secret_deleted = True
            return httpx.Response(204)
        if method == "PATCH" and path == "/api/agents/agent-1":
            self.http_tools = json.loads(request.content)["httpTools"]
            return httpx.Response(200, json={"id": "agent-1"})
        if method == "POST" and path == "/api/agents/agent-1/turns":
            self.turn_body = json.loads(request.content)
            self.turn_headers = dict(request.headers)
            self.status = "RUNNING"
            self.task = asyncio.create_task(self._run_turn())
            return httpx.Response(201, json={"turnId": "turn-1", "conversationId": "conv-1"})
        if method == "GET" and path == "/api/turns/turn-1":
            return httpx.Response(200, json={"turn": self._turn()})
        if method == "GET" and path == "/api/agents/agent-1/turns/turn-1":
            return httpx.Response(200, json={"turn": self._turn(), "messages": self.messages})
        if method == "POST" and path == "/api/agents/agent-1/turns/turn-1/cancel":
            self.status = "CANCELLED"
            return httpx.Response(200, json={"cancelled": True, "turnId": "turn-1"})
        return httpx.Response(404, json={"error": f"unexpected {method} {path}"})

    def _turn(self) -> dict:
        return {
            "id": "turn-1",
            "status": self.status,
            "error": "model unavailable" if self.status == "ERROR" else None,
            "gatewayMode": "gateway_only",
            "usage": {
                "inputTokens": 100,
                "outputTokens": 20,
                "totalTokens": 120,
                "modelCalls": {"observed": 2, "costKnown": 2, "expected": None},
                "cost": {"totalUsd": 0.002, "knownUsd": 0.002, "coverage": "complete"},
            },
            "tags": self.turn_body["tags"] if self.turn_body else {},
        }

    async def _run_turn(self) -> None:
        tools = {tool["name"]: tool for tool in self.http_tools}
        parts = []
        async with httpx.AsyncClient(timeout=30) as http:
            for name, args in self.script:
                response = await http.post(
                    tools[name]["endpoint"],
                    json=args,
                    headers={"Authorization": f"Bearer {self.secret['value']}", "X-Agent-Id": "agent-1"},
                )
                parts.append(
                    {
                        "type": "tool_call",
                        "id": f"call_{len(parts)}",
                        "name": name,
                        "args": json.dumps(args),
                        "result": response.text,
                        "status": "complete" if response.is_success else "error",
                    }
                )
        self.messages = [
            {"id": "m0", "role": "user", "content": self.turn_body["task"], "createdAt": 1, "messageRevision": 0},
            {"id": "m1", "role": "assistant", "content": "", "createdAt": 2, "messageRevision": 0, "parts": parts},
            {"id": "m2", "role": "assistant", "content": "Fixed.", "createdAt": 3, "messageRevision": 0,
             "parts": [{"type": "text", "content": "Fixed."}]},
        ]
        self.status = self.final_status


def _run(tmp_path, monkeypatch, task_env, fake: FakeStablehand, **kwargs):
    agent = _agent(
        tmp_path,
        harness="pi",
        model="gpt-5.4-mini",
        campaign="unit",
        relay_bind="127.0.0.1",
        relay_host="127.0.0.1",
        workdir=str(task_env.root),
        poll_interval_sec=0.05,
        cost_wait_sec=1,
        **kwargs,
    )
    transport = httpx.MockTransport(fake.handler)
    monkeypatch.setattr(
        agent, "_client", lambda: StablehandClient("http://stablehand.test", "test-token", transport=transport)
    )
    context = AgentContext()

    async def go():
        await agent.setup(task_env)
        await agent.run("Make answer() return 42.", task_env, context)

    return agent, context, go


def test_run_solves_through_the_relay_and_writes_the_trajectory(tmp_path, monkeypatch, task_env):
    script = [
        ("task_bash", {"command": "cat pkg/mod.py"}),
        ("task_write", {"path": "pkg/mod.py", "content": "def answer():\n    return 42\n"}),
        ("task_bash", {"command": "python3 -c 'import pkg.mod as m; print(m.answer())'"}),
        ("task_submit", {}),
    ]
    fake = FakeStablehand(script)
    agent, context, go = _run(tmp_path, monkeypatch, task_env, fake)
    asyncio.run(go())

    assert (task_env.root / "pkg" / "mod.py").read_text().endswith("return 42\n")
    assert fake.agent_body["egress"] == {"mode": "deny"}
    assert fake.secret["scope"] == "tools" and len(fake.secret["value"]) >= 32
    assert fake.secret_deleted
    assert fake.turn_body["tags"] == {
        "campaign": "unit",
        "bench_cell": "pi-agent/gpt-5.4-mini",
        "task": "fastapi-0f3e7bd682",
        "trial": "fastapi-0f3e7bd682__AbCdEfG",
    }
    assert fake.turn_body["task"].startswith("Make answer() return 42.")
    assert "task_submit" in fake.turn_body["task"]
    assert fake.turn_headers["idempotency-key"] == "harbor-594025f3-7d65-4655-8576-4bee95002eae"
    assert all(tool["endpoint"].startswith("http://127.0.0.1:") for tool in fake.http_tools)

    trajectory = json.loads((agent.logs_dir / "trajectory.json").read_text())
    Trajectory.model_validate(trajectory)
    calls = [call["function_name"] for step in trajectory["steps"] for call in step.get("tool_calls", [])]
    assert calls == ["task_bash", "task_write", "task_bash", "task_submit"]
    outputs = [r["content"] for step in trajectory["steps"] for r in step.get("observation", {}).get("results", [])]
    assert outputs[2] == "exit_code: 0\n42\n"
    assert (agent.logs_dir / "stablehand-turn.json").exists()
    relay_log = [json.loads(line) for line in (agent.logs_dir / "relay.jsonl").read_text().splitlines()]
    assert [line["tool"] for line in relay_log] == ["task_bash", "task_write", "task_bash", "task_submit"]

    assert context.cost_usd == 0.002 and context.n_input_tokens == 100
    meta = context.metadata["stablehand"]
    assert meta["agentId"] == "agent-1" and meta["turnId"] == "turn-1" and meta["status"] == "COMPLETED"
    assert meta["relayCalls"]["submitted"] is True
    assert meta["relayCalls"]["byTool"] == {"task_bash": 2, "task_write": 1, "task_submit": 1}


def test_an_errored_turn_is_reported_so_the_verifier_still_runs(tmp_path, monkeypatch, task_env):
    fake = FakeStablehand([("task_bash", {"command": "true"})], final_status="ERROR")
    agent, context, go = _run(tmp_path, monkeypatch, task_env, fake)
    with pytest.raises(NonZeroAgentExitCodeError, match="model unavailable"):
        asyncio.run(go())
    assert (agent.logs_dir / "trajectory.json").exists()
    assert context.metadata["stablehand"]["status"] == "ERROR"
    assert fake.secret_deleted


def test_a_harbor_timeout_cancels_the_turn(tmp_path, monkeypatch, task_env):
    fake = FakeStablehand([("task_bash", {"command": "sleep 6", "timeoutSec": 30})])
    agent, context, go = _run(tmp_path, monkeypatch, task_env, fake)

    async def with_timeout():
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(go(), 2)
        if fake.task:
            fake.task.cancel()

    asyncio.run(with_timeout())
    assert fake.status == "CANCELLED"
    assert (agent.logs_dir / "trajectory.json").exists()
    assert fake.secret_deleted


def test_detect_bridge_gateway_reports_a_missing_docker(monkeypatch):
    async def missing(*_args, **_kwargs):
        raise FileNotFoundError("docker")

    monkeypatch.setattr(agent_module.asyncio, "create_subprocess_exec", missing)
    with pytest.raises(RuntimeError, match="relay_bind"):
        asyncio.run(agent_module.detect_bridge_gateway())
