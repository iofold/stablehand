"""Small async client for the parts of the Stablehand HTTP API this agent uses."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

TERMINAL_TURN_STATUSES = frozenset({"COMPLETED", "ERROR", "CANCELLED"})


class StablehandApiError(RuntimeError):
    def __init__(self, method: str, path: str, status: int, body: str):
        super().__init__(f"Stablehand {method} {path} returned {status}: {body[:500]}")
        self.status = status
        self.body = body


class StablehandClient:
    def __init__(
        self,
        base_url: str,
        token: str | None,
        *,
        timeout: float = 60.0,
        logger: logging.Logger | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers=headers,
            timeout=timeout,
            transport=transport,
        )
        self._logger = logger or logging.getLogger(__name__)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "StablehandClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Any = None,
        headers: dict[str, str] | None = None,
        retries: int = 3,
        ok: tuple[int, ...] = (200, 201, 202, 204),
    ) -> Any:
        """Send a request; GETs (and explicitly retried calls) retry transient failures."""
        attempt = 0
        while True:
            attempt += 1
            try:
                response = await self._http.request(method, path, json=json, params=params, headers=headers)
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                if attempt > retries:
                    raise
                self._logger.warning("stablehand %s %s failed (%s); retrying", method, path, exc)
                await asyncio.sleep(min(2**attempt, 10))
                continue
            if response.status_code in ok:
                if response.status_code == 204 or not response.content:
                    return None
                return response.json()
            if response.status_code >= 500 and attempt <= retries:
                self._logger.warning("stablehand %s %s returned %s; retrying", method, path, response.status_code)
                await asyncio.sleep(min(2**attempt, 10))
                continue
            raise StablehandApiError(method, path, response.status_code, response.text)

    # -- health ---------------------------------------------------------------

    async def health(self) -> dict[str, Any]:
        return await self._request("GET", "/api/health")

    # -- agents ---------------------------------------------------------------

    async def create_agent(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/api/agents", json=body, retries=0)

    async def get_agent(self, agent_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/api/agents/{agent_id}")

    async def patch_agent(self, agent_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._request("PATCH", f"/api/agents/{agent_id}", json=body, retries=1)

    async def delete_agent(self, agent_id: str) -> None:
        await self._request("DELETE", f"/api/agents/{agent_id}", retries=1)

    async def put_secret(self, agent_id: str, key: str, value: str, *, scope: str = "sandbox") -> None:
        await self._request(
            "POST",
            f"/api/agents/{agent_id}/secrets",
            json={"key": key, "value": value, "scope": scope},
            retries=1,
        )

    async def delete_secret(self, agent_id: str, key: str, *, scope: str = "sandbox") -> None:
        await self._request(
            "DELETE",
            f"/api/agents/{agent_id}/secrets/{key}",
            params={"scope": scope},
            retries=1,
            ok=(200, 204, 404),
        )

    # -- turns ----------------------------------------------------------------

    async def start_turn(
        self,
        agent_id: str,
        task: str,
        *,
        tags: dict[str, str],
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Queue a background turn. With an idempotency key, retries cannot start a second turn."""
        return await self._request(
            "POST",
            f"/api/agents/{agent_id}/turns",
            json={"task": task, "tags": tags},
            headers={"Idempotency-Key": idempotency_key} if idempotency_key else None,
            retries=3 if idempotency_key else 0,
        )

    async def get_turn(self, turn_id: str) -> dict[str, Any]:
        """The turn without its messages (cheap to poll)."""
        response = await self._request("GET", f"/api/turns/{turn_id}")
        return response["turn"]

    async def get_turn_detail(self, agent_id: str, turn_id: str) -> dict[str, Any]:
        """The turn plus its full, untruncated messages."""
        return await self._request("GET", f"/api/agents/{agent_id}/turns/{turn_id}")

    async def cancel_turn(self, agent_id: str, turn_id: str) -> dict[str, Any] | None:
        return await self._request(
            "POST",
            f"/api/agents/{agent_id}/turns/{turn_id}/cancel",
            json={},
            retries=1,
            ok=(200, 202, 409),
        )

    async def search_turns(self, tags: dict[str, str], *, limit: int = 200) -> list[dict[str, Any]]:
        turns: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            params: list[tuple[str, str]] = [("tag", f"{key}:{value}") for key, value in tags.items()]
            params.append(("limit", str(limit)))
            if cursor:
                params.append(("cursor", cursor))
            page = await self._request("GET", "/api/turns", params=params)
            turns.extend(page.get("turns", []))
            cursor = page.get("nextCursor")
            if not cursor:
                return turns

    # -- budgets and campaign keys ---------------------------------------------

    async def list_budgets(self) -> list[dict[str, Any]]:
        return (await self._request("GET", "/api/budgets"))["policies"]

    async def create_budget(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/api/budgets", json=body, retries=0)

    async def budget_spend(self, policy_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/api/budgets/{policy_id}/spend")

    async def list_campaign_keys(self) -> list[dict[str, Any]]:
        return (await self._request("GET", "/api/model-gateway/campaign-keys"))["campaignKeys"]

    async def create_campaign_key(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/api/model-gateway/campaign-keys", json=body, retries=0)
