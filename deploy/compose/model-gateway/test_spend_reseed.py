"""Offline regressions against the LiteLLM package installed in the image.

Run with network disabled. DB reads are deterministic coroutine substitutes;
the cache and reseed implementations are the installed, unmodified classes.
Only the proxy counter helper functions are AST-loaded to avoid starting a
proxy server or loading deployment configuration.
"""
from __future__ import annotations

import ast
import asyncio
from datetime import datetime
import logging
from pathlib import Path
import sys
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import litellm
from litellm.caching.dual_cache import DualCache
from litellm.proxy.db.spend_counter_reseed import SpendCounterReseed
from litellm.proxy.spend_tracking.budget_reservation import (
    _BudgetCounter,
    _reserve_counter,
    _set_reserved_entry_actual_cost,
)
from litellm.proxy._types import UserAPIKeyAuth
from litellm.proxy.auth.auth_checks import _virtual_key_max_budget_check


class SpendReseedTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Each isolated unittest owns a fresh event loop; the live proxy has one.
        SpendCounterReseed._locks.clear()
        SpendCounterReseed._registry_lock = None
        self.cache = DualCache(default_in_memory_ttl=60)
        self.key = "spend:key:invented-offline-key"
        source = Path(litellm.__file__).parent / "proxy/proxy_server.py"
        tree = ast.parse(source.read_text())
        names = {
            "_repair_stale_spend_counter", "reseed_spend_counter_from_db",
            "_ensure_spend_counter_initialized", "_is_spend_counter_cache_warm",
            "_increment_spend_counter_cache", "_invalidate_spend_counter",
        }
        nodes = [node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)
                 and node.name in names]
        self.assertEqual(len(nodes), len(names))
        self.namespace = {
            "SpendCounterReseed": SpendCounterReseed,
            "spend_counter_cache": self.cache,
            "prisma_client": None,
            "verbose_proxy_logger": logging.getLogger("offline-spend-reseed"),
        }
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), "exec"), self.namespace)
        proxy = ModuleType("litellm.proxy.proxy_server")
        proxy.__dict__.update(self.namespace)
        proxy._ensure_window_spend_counter_initialized = AsyncMock()
        proxy.general_settings = {}
        proxy.get_current_spend = AsyncMock(side_effect=lambda **kwargs: self.cache.in_memory_cache.get_cache(kwargs["counter_key"]))
        self.proxy_patch = patch.dict(sys.modules, {"litellm.proxy.proxy_server": proxy})
        self.proxy_patch.start()
        self.addCleanup(self.proxy_patch.stop)

    def counter(self, fallback=285.0):
        return _BudgetCounter(counter_key=self.key, max_budget=500.0,
                              fallback_spend=fallback, entity_type="Key",
                              entity_id="invented-offline-key", source_cache_key="invented-offline-key")

    async def seed(self):
        return await SpendCounterReseed.coalesced(None, self.cache, self.key)

    async def test_cold_counter_gets_one_database_balance(self):
        with patch.object(SpendCounterReseed, "from_db", AsyncMock(return_value=285.0)) as read:
            self.assertEqual(await self.seed(), 285.0)
        self.assertEqual(self.cache.in_memory_cache.get_cache(self.key), 285.0)
        read.assert_awaited_once()

    async def test_reconcile_reseed_during_db_await_does_not_double_spend(self):
        started, release = asyncio.Event(), asyncio.Event()
        calls = 0

        async def database(prisma_client, counter_key):
            nonlocal calls
            calls += 1
            if calls == 1:
                started.set()
                await release.wait()
            return 285.0

        with patch.object(SpendCounterReseed, "from_db", database):
            task = asyncio.create_task(self.seed())
            await asyncio.wait_for(started.wait(), 2)
            repair = asyncio.create_task(self.namespace["reseed_spend_counter_from_db"](self.key))
            await asyncio.sleep(0)
            release.set()
            returned = await asyncio.wait_for(task, 2)
            await asyncio.wait_for(repair, 2)
        self.assertEqual(calls, 2)
        self.assertEqual(returned, 285.0)
        self.assertEqual(self.cache.in_memory_cache.get_cache(self.key), 285.0)
        self.assertLess(self.cache.in_memory_cache.get_cache(self.key), 500.0)

    async def concurrent_reservation(self, amount):
        started, release = asyncio.Event(), asyncio.Event()
        calls = 0

        async def database(prisma_client, counter_key):
            nonlocal calls
            calls += 1
            if calls == 1:
                started.set()
                await release.wait()
            return 285.0

        async def repair_then_reserve():
            await self.namespace["reseed_spend_counter_from_db"](self.key)
            return await _reserve_counter(self.counter(), amount)

        with patch.object(SpendCounterReseed, "from_db", database):
            task = asyncio.create_task(self.seed())
            await asyncio.wait_for(started.wait(), 2)
            reservation = asyncio.create_task(repair_then_reserve())
            await asyncio.sleep(0)
            release.set()
            returned = await asyncio.wait_for(task, 2)
            reserved = await asyncio.wait_for(reservation, 2)
        return returned, reserved, self.cache.in_memory_cache.get_cache(self.key)

    async def test_preserves_concurrent_reservations(self):
        # The floor repair and another reservation populated 285 + 15 while
        # this reader awaited the DB. Neither duplicate the floor nor erase 15.
        returned, reserved, stored = await self.concurrent_reservation(15.0)
        self.assertEqual((returned, reserved, stored), (285.0, 300.0, 300.0))

    async def test_never_lowers_concurrent_over_budget_spend(self):
        returned, reserved, stored = await self.concurrent_reservation(235.0)
        self.assertEqual((returned, reserved, stored), (285.0, 520.0, 520.0))
        self.assertGreaterEqual(stored, 500.0)

    async def test_warm_counter_does_not_read_or_reset_database_spend(self):
        self.cache.in_memory_cache.set_cache(self.key, 520.0)
        with patch.object(SpendCounterReseed, "from_db", AsyncMock()) as read:
            self.assertEqual(await self.seed(), 520.0)
        read.assert_not_awaited()

    async def test_zero_database_balance_still_warms_cache(self):
        with patch.object(SpendCounterReseed, "from_db", AsyncMock(return_value=0.0)):
            self.assertEqual(await self.seed(), 0.0)
        self.assertEqual(self.cache.in_memory_cache.get_cache(self.key), 0.0)

    async def test_unavailable_database_does_not_invent_a_balance(self):
        with patch.object(SpendCounterReseed, "from_db", AsyncMock(return_value=None)):
            self.assertIsNone(await self.seed())
        self.assertIsNone(self.cache.in_memory_cache.get_cache(self.key))

    async def test_concurrent_cold_readers_share_one_database_seed(self):
        read = AsyncMock(return_value=285.0)
        with patch.object(SpendCounterReseed, "from_db", read):
            values = await asyncio.gather(self.seed(), self.seed(), self.seed())
        self.assertEqual(values, [285.0, 285.0, 285.0])
        self.assertEqual(self.cache.in_memory_cache.get_cache(self.key), 285.0)
        read.assert_awaited_once()

    async def test_redis_nx_loser_preserves_winning_counter(self):
        redis = SimpleNamespace(
            async_get_cache=AsyncMock(side_effect=[None, 300.0]),
            async_set_cache=AsyncMock(return_value=False),
        )
        self.cache.redis_cache = redis
        with patch.object(SpendCounterReseed, "from_db", AsyncMock(return_value=285.0)):
            self.assertEqual(await self.seed(), 300.0)
        redis.async_set_cache.assert_awaited_once_with(key=self.key, value=285.0, nx=True)
        self.assertEqual(self.cache.in_memory_cache.get_cache(self.key), 300.0)

    async def diagnostic_expired_counter_settlement_preserves_new_reservation(self):
        # A held 20 against 285 real spend. Its counter expires. A's actual 5
        # reaches the DB, B reseeds from 290 and reserves 15, then A's delayed
        # negative reconcile must not subtract its old reservation a second time.
        with patch.object(SpendCounterReseed, "from_db", AsyncMock(return_value=285.0)):
            self.assertEqual(await _reserve_counter(self.counter(), 20.0), 305.0)
        old = {"counter_key": self.key, "reserved_cost": 20.0}
        self.cache.in_memory_cache.ttl_dict[self.key] = time.time() - 1
        with patch.object(SpendCounterReseed, "from_db", AsyncMock(return_value=290.0)):
            self.assertEqual(await _reserve_counter(self.counter(), 15.0), 305.0)
            await _set_reserved_entry_actual_cost(old, actual_cost=5.0, default_reserved_cost=20.0)
        self.assertEqual(self.cache.in_memory_cache.get_cache(self.key), 305.0)

    async def test_negative_partial_and_repeated_settlement_preserve_other_reservations(self):
        with patch.object(SpendCounterReseed, "from_db", AsyncMock(return_value=285.0)):
            self.assertEqual(await _reserve_counter(self.counter(), 20.0), 305.0)
            self.assertEqual(await _reserve_counter(self.counter(), 15.0), 320.0)
            first = {"counter_key": self.key, "reserved_cost": 20.0}
            await _set_reserved_entry_actual_cost(first, actual_cost=5.0, default_reserved_cost=20.0)
            self.assertEqual(self.cache.in_memory_cache.get_cache(self.key), 305.0)
            await _set_reserved_entry_actual_cost(first, actual_cost=5.0, default_reserved_cost=20.0)
            self.assertEqual(self.cache.in_memory_cache.get_cache(self.key), 305.0)
            await _set_reserved_entry_actual_cost(first, actual_cost=7.0, default_reserved_cost=20.0)
            self.assertEqual(self.cache.in_memory_cache.get_cache(self.key), 307.0)

    async def test_missing_counter_settlement_with_no_other_reservations_uses_database(self):
        with patch.object(SpendCounterReseed, "from_db", AsyncMock(return_value=285.0)):
            await _reserve_counter(self.counter(), 20.0)
        first = {"counter_key": self.key, "reserved_cost": 20.0}
        self.cache.in_memory_cache.delete_cache(self.key)
        with patch.object(SpendCounterReseed, "from_db", AsyncMock(return_value=290.0)):
            await _set_reserved_entry_actual_cost(first, actual_cost=5.0, default_reserved_cost=20.0)
        self.assertEqual(self.cache.in_memory_cache.get_cache(self.key), 290.0)

    async def test_signed_deltas_wait_for_cold_reseed(self):
        for delta in (-5.0, 15.0):
            with self.subTest(delta=delta):
                self.cache.in_memory_cache.delete_cache(self.key)
                started, release = asyncio.Event(), asyncio.Event()

                async def database(prisma_client, counter_key):
                    started.set()
                    await release.wait()
                    return 285.0

                with patch.object(SpendCounterReseed, "from_db", database):
                    seed = asyncio.create_task(self.seed())
                    await asyncio.wait_for(started.wait(), 2)
                    self.cache.in_memory_cache.set_cache(self.key, 285.0)
                    change = asyncio.create_task(self.namespace["_increment_spend_counter_cache"](self.key, delta))
                    await asyncio.sleep(0)
                    blocked = not change.done()
                    release.set()
                    await asyncio.wait_for(seed, 2)
                    await asyncio.wait_for(change, 2)
                self.assertTrue(blocked)
                self.assertEqual(self.cache.in_memory_cache.get_cache(self.key), 285.0 + delta)

    async def test_window_reseed_preserves_signed_concurrent_deltas(self):
        for delta in (-5.0, 15.0):
            with self.subTest(delta=delta):
                self.cache.in_memory_cache.delete_cache(self.key)
                started, release = asyncio.Event(), asyncio.Event()

                async def database(**kwargs):
                    started.set()
                    await release.wait()
                    return 285.0

                with patch.object(SpendCounterReseed, "window_from_spend_logs", database):
                    seed = asyncio.create_task(SpendCounterReseed.coalesced_window(
                        None, self.cache, self.key, "Key", "invented-offline-key", datetime(2026, 9, 28)))
                    await asyncio.wait_for(started.wait(), 2)
                    await self.namespace["_repair_stale_spend_counter"](self.key, 285.0)
                    change = asyncio.create_task(self.namespace["_increment_spend_counter_cache"](self.key, delta))
                    await asyncio.sleep(0)
                    blocked = not change.done()
                    release.set()
                    await asyncio.wait_for(seed, 2)
                    await asyncio.wait_for(change, 2)
                self.assertTrue(blocked)
                self.assertEqual(self.cache.in_memory_cache.get_cache(self.key), 285.0 + delta)

    async def test_real_virtual_key_check_keeps_500_cap(self):
        auth = UserAPIKeyAuth(token="invented-offline-key", max_budget=500.0, spend=285.0)
        logger = SimpleNamespace(budget_alerts=AsyncMock())
        for spend in (499.99, 500.0, 520.0):
            self.cache.in_memory_cache.set_cache(self.key, spend)
            if spend < 500:
                await _virtual_key_max_budget_check(auth, logger)
            else:
                with self.assertRaises(litellm.BudgetExceededError):
                    await _virtual_key_max_budget_check(auth, logger)
            self.assertEqual(auth.max_budget, 500.0)
            self.assertEqual(self.cache.in_memory_cache.get_cache(self.key), spend)
        await asyncio.sleep(0)


class ExistingAccountingGap(unittest.IsolatedAsyncioTestCase):
    """Explicit diagnostic: fails on baseline AND candidate; not repaired here."""
    asyncSetUp = SpendReseedTests.asyncSetUp
    counter = SpendReseedTests.counter
    test_expired_counter_settlement_preserves_new_reservation = (
        SpendReseedTests.diagnostic_expired_counter_settlement_preserves_new_reservation
    )


if __name__ == "__main__":
    unittest.main(verbosity=2)
