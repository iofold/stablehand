from __future__ import annotations

from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory

from stablehand_harbor.trajectory import build_trajectory, fill_context

LONG_RESULT = "exit_code: 0\n" + "line\n" * 2000


def _detail() -> dict:
    return {
        "turn": {
            "id": "turn-1",
            "status": "COMPLETED",
            "usage": {
                "inputTokens": 1200,
                "outputTokens": 300,
                "totalTokens": 1500,
                "modelCalls": {"observed": 3, "costKnown": 3, "expected": None},
                "cost": {"totalUsd": 0.0123, "knownUsd": 0.0123, "coverage": "complete"},
            },
        },
        "messages": [
            {"id": "m0", "role": "user", "content": "Fix the bug.", "createdAt": 1792790567873, "messageRevision": 0},
            {
                "id": "m1",
                "role": "assistant",
                "content": "Looking.Found it.Done.",
                "createdAt": 1792790571826,
                "messageRevision": 3,
                "parts": [
                    {"type": "text", "content": "Looking."},
                    {
                        "type": "tool_call",
                        "id": "call_a",
                        "name": "task_bash",
                        "args": '{"command": "ls"}',
                        "result": "exit_code: 0\npkg",
                        "status": "complete",
                    },
                    {
                        "type": "tool_call",
                        "id": "call_b",
                        "name": "mcp__stablehand__task_read",
                        "args": '{"path": "pkg/mod.py"}',
                        "status": "complete",
                    },
                    {"type": "text", "content": "Found it."},
                    {
                        "type": "tool_call",
                        "id": "call_c",
                        "name": "task_bash",
                        "args": "not json",
                        "result": "exit_code: 0\nline\n",
                        "error": None,
                        "status": "complete",
                    },
                    {"type": "tool_call", "id": "call_d", "name": "task_submit", "args": "", "error": "boom", "status": "error"},
                ],
            },
            {"id": "t1", "role": "tool", "toolCallId": "call_b", "content": "def answer(): ...", "messageRevision": 0, "createdAt": 1},
            {"id": "t2", "role": "tool", "toolCallId": "call_c", "content": LONG_RESULT, "messageRevision": 0, "createdAt": 2},
            {
                "id": "m2",
                "role": "assistant",
                "content": "Done.",
                "createdAt": 1792790597955,
                "messageRevision": 0,
                "parts": [{"type": "text", "content": "Done."}],
            },
        ],
    }


def test_groups_parts_into_steps_and_keeps_full_tool_output():
    trajectory = build_trajectory(
        _detail(),
        agent_name="stablehand-pi-agent",
        agent_version="0.1.0",
        model_name="gpt-5.4-mini",
        session_id="trial__agent",
        system_prompt="You are a solver.",
        extra={"stablehand": {"turnId": "turn-1"}},
    )
    data = trajectory.to_json_dict()
    Trajectory.model_validate(data)
    steps = data["steps"]
    assert [step["source"] for step in steps] == ["system", "user", "agent", "agent", "agent"]
    assert [step["step_id"] for step in steps] == [1, 2, 3, 4, 5]

    first = steps[2]
    assert first["message"] == "Looking."
    assert [call["function_name"] for call in first["tool_calls"]] == ["task_bash", "task_read"]
    assert first["tool_calls"][1]["extra"] == {"status": "complete", "harnessToolName": "mcp__stablehand__task_read"}
    assert first["tool_calls"][0]["arguments"] == {"command": "ls"}
    results = first["observation"]["results"]
    assert results[0] == {"source_call_id": "call_a", "content": "exit_code: 0\npkg"}
    # A part without a result takes it from the tool message.
    assert results[1]["content"] == "def answer(): ..."

    second = steps[3]
    assert second["message"] == "Found it."
    assert second["tool_calls"][0]["arguments"] == {"raw": "not json"}
    # The tool message is longer than the part's result: keep the full output.
    assert second["observation"]["results"][0]["content"] == LONG_RESULT
    assert second["observation"]["results"][1]["content"] == "[error] boom"
    assert second["tool_calls"][1]["arguments"] == {}

    assert steps[4]["message"] == "Done." and "tool_calls" not in steps[4]
    assert data["final_metrics"]["total_prompt_tokens"] == 1200
    assert data["final_metrics"]["total_completion_tokens"] == 300
    assert data["final_metrics"]["total_cost_usd"] == 0.0123
    assert data["final_metrics"]["total_steps"] == 5
    assert data["agent"] == {"name": "stablehand-pi-agent", "version": "0.1.0", "model_name": "gpt-5.4-mini"}
    assert data["extra"] == {"stablehand": {"turnId": "turn-1"}}


def test_a_turn_without_messages_still_yields_a_valid_trajectory():
    trajectory = build_trajectory(
        {"turn": {"id": "turn-2", "status": "ERROR", "usage": None}, "messages": []},
        agent_name="stablehand-langgraph",
        agent_version="0.1.0",
        model_name="gpt-5.4-mini",
        instruction="Fix the bug.",
    )
    data = trajectory.to_json_dict()
    assert data["steps"] == [{"step_id": 1, "source": "user", "message": "Fix the bug."}]
    assert data["session_id"] == "turn-2"


def test_fill_context_uses_turn_usage():
    context = AgentContext()
    fill_context(context, _detail()["turn"])
    assert (context.n_input_tokens, context.n_output_tokens, context.cost_usd) == (1200, 300, 0.0123)
    pending = AgentContext()
    fill_context(pending, {"usage": {"inputTokens": 5, "outputTokens": 1, "cost": {"totalUsd": None, "knownUsd": 0, "coverage": "pending"}}})
    assert pending.cost_usd is None and pending.n_input_tokens == 5
