"""Operator commands around a StablehandAgent benchmark campaign.

    stablehand-harbor campaign --campaign NAME --cap-usd 10 --models claude-sonnet-5,gpt-5.4-mini
    stablehand-harbor spend --campaign NAME
    stablehand-harbor probe-egress --agent-id ID --campaign NAME

All commands read STABLEHAND_API_URL (default http://localhost:3002) and
STABLEHAND_API_TOKEN (the master token: budgets and campaign keys are
master-only). Secret values are written to files, never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from stablehand_harbor.client import TERMINAL_TURN_STATUSES, StablehandClient


def _client() -> StablehandClient:
    token = os.environ.get("STABLEHAND_API_TOKEN")
    if not token:
        sys.exit("Set STABLEHAND_API_TOKEN")
    return StablehandClient(os.environ.get("STABLEHAND_API_URL", "http://localhost:3002"), token)


def _print(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False))


async def _find_policy(client: StablehandClient, campaign: str) -> dict[str, Any] | None:
    for policy in await client.list_budgets():
        if policy.get("doc", {}).get("selector") == {"campaign": campaign}:
            return policy
    return None


async def cmd_campaign(args: argparse.Namespace) -> None:
    """Ensure a cost-blocking budget for the campaign tag, then a campaign gateway key under it."""
    async with _client() as client:
        policy = await _find_policy(client, args.campaign)
        if policy is None:
            policy = await client.create_budget(
                {
                    "name": f"campaign {args.campaign}",
                    "enabled": True,
                    "doc": {
                        "selector": {"campaign": args.campaign},
                        "window": args.window,
                        "limits": {"costUsd": args.cap_usd},
                        "actions": [
                            {"threshold": 0.5, "action": "warn"},
                            {"threshold": 0.85, "action": "warn"},
                            {"threshold": 1, "action": "block"},
                        ],
                    },
                }
            )
            policy_state = "created"
        else:
            policy_state = "existing"

        key_info: dict[str, Any] | None = None
        if not args.no_key:
            existing = [
                key
                for key in await client.list_campaign_keys()
                if key.get("tags") == {"campaign": args.campaign} and key.get("status") == "active"
            ]
            if existing:
                key_info = {"state": "existing", **_key_summary(existing[0])}
            else:
                models = [model.strip() for model in args.models.split(",") if model.strip()]
                created = await client.create_campaign_key(
                    {
                        "name": f"{args.campaign} bench",
                        "tags": {"campaign": args.campaign},
                        "models": models,
                        "maxBudgetUsd": args.cap_usd,
                    }
                )
                key_file = Path(args.key_file or Path.home() / ".config" / "stablehand-harbor" / f"{args.campaign}.key")
                key_file.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as handle:
                    handle.write(created["key"] + "\n")
                key_info = {"state": "created", "keyFile": str(key_file), **_key_summary(created)}
        _print(
            {
                "budget": {"state": policy_state, "id": policy["id"], "name": policy["name"], "doc": policy["doc"]},
                "campaignKey": key_info,
            }
        )


def _key_summary(key: dict[str, Any]) -> dict[str, Any]:
    return {
        name: key.get(name)
        for name in ("id", "name", "tags", "models", "maxBudgetUsd", "capSource", "capPolicyName", "status", "spend")
    }


async def cmd_spend(args: argparse.Namespace) -> None:
    """Spend for a campaign: the budget's view, campaign keys, and tagged turns per bench cell."""
    async with _client() as client:
        policy = await _find_policy(client, args.campaign)
        budget = await client.budget_spend(policy["id"]) if policy else None
        keys = [
            _key_summary(key)
            for key in await client.list_campaign_keys()
            if key.get("tags", {}).get("campaign") == args.campaign
        ]
        turns = await client.search_turns({"campaign": args.campaign})
        cells: dict[str, dict[str, Any]] = defaultdict(
            lambda: {"turns": 0, "statuses": defaultdict(int), "costUsd": 0.0, "costPending": 0, "tokens": 0}
        )
        for turn in turns:
            cell = cells[(turn.get("tags") or {}).get("bench_cell", "?")]
            cell["turns"] += 1
            cell["statuses"][turn.get("status")] += 1
            usage = turn.get("usage") or {}
            cost = usage.get("cost") or {}
            cell["costUsd"] += float(cost.get("totalUsd") or cost.get("knownUsd") or 0)
            cell["tokens"] += int(usage.get("totalTokens") or 0)
            if cost.get("coverage") not in ("complete", None):
                cell["costPending"] += 1
        _print(
            {
                "campaign": args.campaign,
                "budget": budget,
                "campaignKeys": keys,
                "turnsByCell": {
                    name: {**cell, "statuses": dict(cell["statuses"]), "costUsd": round(cell["costUsd"], 6)}
                    for name, cell in cells.items()
                },
                "turnCostUsd": round(sum(cell["costUsd"] for cell in cells.values()), 6),
            }
        )


PROBE_TASK = """\
This is a network check, not a coding task. Do not call any task_* tool.
Use your own built-in shell tool to run exactly this command once, then reply with its output verbatim:

curl -sS -m 20 -o /dev/null -w 'http_code=%{{http_code}}\\n' {url}
"""


async def cmd_probe_egress(args: argparse.Namespace) -> None:
    """Ask a solver agent to fetch a URL from its own sandbox; the egress proxy log shows the verdict."""
    async with _client() as client:
        started = await client.start_turn(
            args.agent_id,
            PROBE_TASK.format(url=args.url),
            tags={"campaign": args.campaign, "bench_cell": "egress-probe", "task": "egress-probe"},
        )
        turn_id = started["turnId"]
        deadline = time.monotonic() + args.timeout_sec
        while True:
            turn = await client.get_turn(turn_id)
            if turn.get("status") in TERMINAL_TURN_STATUSES or time.monotonic() > deadline:
                break
            await asyncio.sleep(3)
        detail = await client.get_turn_detail(args.agent_id, turn_id)
        calls = [
            {"name": part.get("name"), "args": part.get("args"), "result": part.get("result"), "error": part.get("error")}
            for message in detail.get("messages", [])
            for part in message.get("parts") or []
            if part.get("type") == "tool_call"
        ]
        _print(
            {
                "turnId": turn_id,
                "status": detail["turn"].get("status"),
                "startedAt": detail["turn"].get("startedAt"),
                "completedAt": detail["turn"].get("completedAt"),
                "toolCalls": calls,
                "reply": [m.get("content") for m in detail.get("messages", []) if m.get("role") == "assistant"][-1:],
            }
        )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="stablehand-harbor", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    campaign = sub.add_parser("campaign", help="ensure the campaign's budget and gateway key")
    campaign.add_argument("--campaign", required=True)
    campaign.add_argument("--cap-usd", type=float, required=True)
    campaign.add_argument("--models", default="claude-sonnet-5,gpt-5.4-mini")
    campaign.add_argument("--window", default="rolling-30d")
    campaign.add_argument("--key-file", help="where to write the campaign key (mode 0600)")
    campaign.add_argument("--no-key", action="store_true", help="only ensure the budget")
    campaign.set_defaults(handler=cmd_campaign)

    spend = sub.add_parser("spend", help="show a campaign's spend")
    spend.add_argument("--campaign", required=True)
    spend.set_defaults(handler=cmd_spend)

    probe = sub.add_parser("probe-egress", help="check that a solver agent's sandbox cannot reach a URL")
    probe.add_argument("--agent-id", required=True)
    probe.add_argument("--campaign", required=True)
    probe.add_argument("--url", default="https://github.com/fastapi/fastapi")
    probe.add_argument("--timeout-sec", type=float, default=300)
    probe.set_defaults(handler=cmd_probe_egress)

    args = parser.parse_args(argv)
    asyncio.run(args.handler(args))


if __name__ == "__main__":
    main()
