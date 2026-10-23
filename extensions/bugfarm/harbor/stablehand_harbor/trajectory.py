"""Map a Stablehand turn (``GET /api/agents/:id/turns/:turnId``) to an ATIF trajectory.

Stablehand stores one assistant message per stretch of model output, with its
text and tool calls as ordered ``parts``; each tool call part carries its full
result. Tool results are also repeated as ``role: tool`` messages, which are
used only to fill in a result a part lacks. Model-call boundaries are not kept,
so a step here is one run of assistant text followed by the tool calls that
came after it, and ``llm_call_count`` is left unset.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)

# Claude Agents exposes Stablehand tools through an in-process MCP server, so the
# model sees them as `mcp__stablehand__<name>`. Strip that so a tool has one name
# across harnesses; the harness's own name stays in the call's `extra`.
STABLEHAND_MCP_PREFIX = "mcp__stablehand__"

TRAJECTORY_NOTES = (
    "Converted from Stablehand turn messages. A step is one run of assistant text plus the tool calls"
    " that followed it; model-call boundaries and per-step token counts are not recorded by Stablehand."
)


def _iso(epoch_ms: Any) -> str | None:
    if not isinstance(epoch_ms, (int, float)) or epoch_ms <= 0:
        return None
    return datetime.fromtimestamp(epoch_ms / 1000, tz=UTC).isoformat()


def _arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {"raw": raw}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    return {}


def _tool_result_text(part: dict[str, Any], fallback: str | None) -> str | None:
    result = part.get("result")
    error = part.get("error")
    if isinstance(result, str) and fallback and len(fallback) > len(result):
        result = fallback
    if result is None:
        result = fallback
    if error:
        return f"{result}\n[error] {error}" if result else f"[error] {error}"
    return result


def _parts(message: dict[str, Any]) -> list[dict[str, Any]]:
    parts = message.get("parts")
    if isinstance(parts, list) and parts:
        return [part for part in parts if isinstance(part, dict)]
    collected: list[dict[str, Any]] = []
    content = message.get("content")
    if isinstance(content, str) and content:
        collected.append({"type": "text", "content": content})
    for call in message.get("toolCalls") or []:
        if isinstance(call, dict):
            collected.append({"type": "tool_call", **call})
    return collected


def _tool_call(call: dict[str, Any], index: int) -> ToolCall:
    raw_name = str(call.get("name") or "unknown")
    name = raw_name.removeprefix(STABLEHAND_MCP_PREFIX) or raw_name
    extra = {
        key: call[key]
        for key in ("status", "durationMs", "parentToolCallId", "agentName")
        if call.get(key) is not None
    }
    if name != raw_name:
        extra["harnessToolName"] = raw_name
    return ToolCall(
        tool_call_id=str(call.get("id") or f"call_{index}"),
        function_name=name,
        arguments=_arguments(call.get("args")),
        extra=extra or None,
    )


def _assistant_steps(
    message: dict[str, Any],
    tool_results: dict[str, str],
    model_name: str | None,
) -> list[dict[str, Any]]:
    """Group a message's parts into (text, tool calls) steps, in order."""
    groups: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for part in _parts(message):
        kind = part.get("type")
        if kind == "text":
            text = part.get("content") or ""
            if current is None or current["calls"]:
                current = {"text": [], "calls": []}
                groups.append(current)
            current["text"].append(text)
        elif kind == "tool_call":
            if current is None:
                current = {"text": [], "calls": []}
                groups.append(current)
            current["calls"].append(part)

    timestamp = _iso(message.get("createdAt"))
    steps: list[dict[str, Any]] = []
    for group in groups:
        text = "".join(group["text"]).strip()
        calls = group["calls"]
        step: dict[str, Any] = {"source": "agent", "message": text, "timestamp": timestamp}
        if model_name:
            step["model_name"] = model_name
        if calls:
            step["tool_calls"] = [_tool_call(call, index) for index, call in enumerate(calls)]
            step["observation"] = Observation(
                results=[
                    ObservationResult(
                        source_call_id=str(call.get("id") or f"call_{index}"),
                        content=_tool_result_text(call, tool_results.get(str(call.get("id")))),
                    )
                    for index, call in enumerate(calls)
                ]
            )
        if text or calls:
            steps.append(step)
    return steps


def build_trajectory(
    detail: dict[str, Any],
    *,
    agent_name: str,
    agent_version: str,
    model_name: str | None,
    session_id: str | None = None,
    system_prompt: str | None = None,
    instruction: str | None = None,
    extra: dict[str, Any] | None = None,
) -> Trajectory:
    turn = detail.get("turn") or {}
    messages = [m for m in detail.get("messages") or [] if isinstance(m, dict)]
    tool_results = {
        str(m.get("toolCallId")): m.get("content") or ""
        for m in messages
        if m.get("role") == "tool" and m.get("toolCallId")
    }

    raw_steps: list[dict[str, Any]] = []
    if system_prompt:
        raw_steps.append({"source": "system", "message": system_prompt})
    saw_user = False
    for message in messages:
        role = message.get("role")
        timestamp = _iso(message.get("createdAt"))
        if role == "user":
            saw_user = True
            raw_steps.append({"source": "user", "message": message.get("content") or "", "timestamp": timestamp})
        elif role == "system":
            raw_steps.append({"source": "system", "message": message.get("content") or "", "timestamp": timestamp})
        elif role == "assistant":
            raw_steps.extend(_assistant_steps(message, tool_results, model_name))
    if not saw_user and instruction:
        insert_at = 1 if system_prompt else 0
        raw_steps.insert(insert_at, {"source": "user", "message": instruction})
    if not raw_steps:
        raw_steps.append({"source": "user", "message": instruction or ""})

    steps = [
        Step(step_id=index, **{key: value for key, value in raw.items() if value is not None})
        for index, raw in enumerate(raw_steps, start=1)
    ]

    usage = turn.get("usage") or {}
    cost = usage.get("cost") or {}
    final_metrics = FinalMetrics(
        total_prompt_tokens=usage.get("inputTokens"),
        total_completion_tokens=usage.get("outputTokens"),
        total_cost_usd=_cost_usd(usage),
        total_steps=len(steps),
        extra={
            key: value
            for key, value in {
                "modelCalls": usage.get("modelCalls"),
                "costCoverage": cost.get("coverage"),
            }.items()
            if value is not None
        }
        or None,
    )
    return Trajectory(
        session_id=session_id or turn.get("id"),
        agent=Agent(name=agent_name, version=agent_version, model_name=model_name),
        steps=steps,
        notes=TRAJECTORY_NOTES,
        final_metrics=final_metrics,
        extra=extra,
    )


def _cost_usd(usage: dict[str, Any]) -> float | None:
    cost = usage.get("cost") or {}
    total = cost.get("totalUsd")
    if isinstance(total, (int, float)):
        return float(total)
    known = cost.get("knownUsd")
    return float(known) if isinstance(known, (int, float)) and known > 0 else None


def fill_context(context: AgentContext, turn: dict[str, Any]) -> None:
    usage = turn.get("usage") or {}
    if isinstance(usage.get("inputTokens"), int):
        context.n_input_tokens = usage["inputTokens"]
    if isinstance(usage.get("outputTokens"), int):
        context.n_output_tokens = usage["outputTokens"]
    cost = _cost_usd(usage)
    if cost is not None:
        context.cost_usd = cost
