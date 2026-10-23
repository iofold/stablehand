from __future__ import annotations

import asyncio
import json
import os
import stat

import httpx

from stablehand_harbor.relay import RelayLimits, TaskRelay, tool_definitions, truncate_middle

TOKEN = "t" * 32


async def _with_relay(task_env, body, *, limits=None, tmp_log=None):
    relay = TaskRelay(task_env, TOKEN, workdir=str(task_env.root), limits=limits, log_path=tmp_log)
    port = await relay.start("127.0.0.1", 0)
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=30) as http:
            return await body(relay, http)
    finally:
        await relay.stop()


def _auth(token: str = TOKEN) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_rejects_requests_without_the_trial_secret(task_env):
    async def body(relay, http):
        missing = await http.post("/task_bash", json={"command": "echo hi"})
        wrong = await http.post("/task_bash", json={"command": "echo hi"}, headers=_auth("x" * 32))
        return missing.status_code, wrong.status_code, list(relay.calls), list(task_env.execs)

    missing, wrong, calls, execs = asyncio.run(_with_relay(task_env, body))
    assert (missing, wrong) == (401, 401)
    assert calls == []
    assert all("echo hi" not in command for command in execs)


def test_rejects_a_different_agent(task_env):
    async def body(relay, http):
        relay.expected_agent_id = "agent-1"
        other = await http.post(
            "/task_bash", json={"command": "true"}, headers={**_auth(), "X-Agent-Id": "agent-2"}
        )
        same = await http.post(
            "/task_bash", json={"command": "true"}, headers={**_auth(), "X-Agent-Id": "agent-1"}
        )
        return other.status_code, same.status_code

    assert asyncio.run(_with_relay(task_env, body)) == (403, 200)


def test_bash_runs_in_the_workdir_and_reports_the_exit_code(task_env, tmp_path):
    log = tmp_path / "relay.jsonl"

    async def body(relay, http):
        ok = await http.post("/task_bash", json={"command": "ls pkg && echo err >&2"}, headers=_auth())
        failed = await http.post("/task_bash", json={"command": "exit 3"}, headers=_auth())
        slow = await http.post("/task_bash", json={"command": "sleep 5", "timeoutSec": 1}, headers=_auth())
        return ok.text, failed.text, slow.text

    ok, failed, slow = asyncio.run(_with_relay(task_env, body, tmp_log=log))
    assert ok.startswith("exit_code: 0\n")
    assert "mod.py" in ok and "err" in ok
    assert failed.startswith("exit_code: 3")
    assert slow.startswith("exit_code: 124 (stopped after the 1 s timeout)")
    lines = [json.loads(line) for line in log.read_text().splitlines()]
    assert [line["tool"] for line in lines] == ["task_bash"] * 3
    assert lines[1]["exitCode"] == 3


def test_bash_caps_the_timeout_and_cuts_long_output(task_env):
    limits = RelayLimits(max_timeout_sec=2, max_output_chars=300)

    async def body(relay, http):
        response = await http.post(
            "/task_bash",
            json={"command": "seq 1 2000", "timeoutSec": 999},
            headers=_auth(),
        )
        return response.text, relay.calls[-1].detail

    text, detail = asyncio.run(_with_relay(task_env, body, limits=limits))
    assert detail["timeoutSec"] == 2
    assert "characters omitted" in text
    assert text.rstrip().endswith("2000")


def test_write_then_read_round_trips_and_keeps_the_file_mode(task_env):
    script = task_env.root / "run.sh"
    script.write_text("#!/bin/sh\n")
    os.chmod(script, 0o755)

    async def body(relay, http):
        wrote = await http.post(
            "/task_write", json={"path": "pkg/mod.py", "content": "def answer():\n    return 42\n"}, headers=_auth()
        )
        nested = await http.post(
            "/task_write", json={"path": "new/dir/file.txt", "content": "héllo"}, headers=_auth()
        )
        await http.post("/task_write", json={"path": "run.sh", "content": "#!/bin/sh\necho hi\n"}, headers=_auth())
        read = await http.post("/task_read", json={"path": f"{task_env.root}/pkg/mod.py"}, headers=_auth())
        part = await http.post(
            "/task_read", json={"path": "pkg/mod.py", "startLine": 2, "endLine": 2}, headers=_auth()
        )
        return wrote, nested, read.text, part.text

    wrote, nested, read, part = asyncio.run(_with_relay(task_env, body))
    assert wrote.status_code == 200 and "Wrote" in wrote.text
    assert nested.status_code == 200
    assert (task_env.root / "new" / "dir" / "file.txt").read_text() == "héllo"
    assert read == "def answer():\n    return 42\n"
    assert part == "[lines 2-2 of 2]\n    return 42\n"
    assert stat.S_IMODE(os.stat(script).st_mode) == 0o755


def test_read_explains_missing_files_and_directories(task_env):
    async def body(relay, http):
        missing = await http.post("/task_read", json={"path": "nope.py"}, headers=_auth())
        directory = await http.post("/task_read", json={"path": "pkg"}, headers=_auth())
        bad = await http.post("/task_read", json={"path": ""}, headers=_auth())
        return missing, directory, bad

    missing, directory, bad = asyncio.run(_with_relay(task_env, body))
    assert missing.status_code == 404 and "No such file" in missing.text
    assert directory.status_code == 404 and "is a directory" in directory.text
    assert bad.status_code == 400


def test_submit_is_recorded_once(task_env):
    async def body(relay, http):
        first = await http.post("/task_submit", json={"summary": "fixed it"}, headers=_auth())
        submitted_at = relay.submitted_at
        await http.post("/task_submit", content=b"", headers=_auth())
        return first.text, submitted_at, relay.submitted_at, relay.submit_note

    text, first_at, second_at, note = asyncio.run(_with_relay(task_env, body))
    assert "Submission recorded" in text
    assert first_at is not None and first_at == second_at
    assert note == "fixed it"


def test_tool_definitions_match_the_relay_routes():
    tools = tool_definitions("http://host.docker.internal:1234", secret_name="TASK_RELAY_TOKEN", max_timeout_sec=240)
    assert [tool["name"] for tool in tools] == ["task_bash", "task_read", "task_write", "task_submit"]
    for tool in tools:
        assert tool["endpoint"] == f"http://host.docker.internal:1234/{tool['name']}"
        assert tool["authentication"] == {"type": "bearer", "secretName": "TASK_RELAY_TOKEN"}
        assert tool["method"] == "POST"
    # The orchestrator must wait longer than the longest command.
    assert tools[0]["timeoutMs"] > 240_000
    assert tools[0]["inputSchema"]["required"] == ["command"]


def test_truncate_middle():
    assert truncate_middle("abc", 10) == "abc"
    cut = truncate_middle("x" * 50 + "y" * 50, 30)
    assert cut.startswith("x" * 10) and cut.endswith("y" * 20)
    assert "70 characters omitted" in cut
