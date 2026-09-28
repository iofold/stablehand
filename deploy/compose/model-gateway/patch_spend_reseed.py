"""Guarded backport of two official LiteLLM spend-counter fixes to 1.93.0.

8b965880: prevent spend counter double counting
a39c3587: preserve local spend adjustments during reseeding

Only adapt annotations and surrounding context to the pinned source. No TTL,
database, reservation settlement, reset, authentication, or limit changes.
"""
import hashlib
import json
from pathlib import Path


ROOT = Path("/app/.venv/lib/python3.13/site-packages/litellm")
SOURCES = {
    "proxy/db/spend_counter_reseed.py": "91f033d08d38a9285a839381dc0d06363912a82edf7ef4d14274428fd23c8293",
    "proxy/proxy_server.py": "cabbcdd33d420999aff0872c6472812ec3252a7be25a52cea1d8f406ba0622e8",
}
UPSTREAM = [
    "https://github.com/BerriAI/litellm/commit/8b965880efd8e28321c1db74850fbb2b6f59242c",
    "https://github.com/BerriAI/litellm/commit/a39c35878569f74c50de3295320457dd7bd6adb2",
]
INCREMENT_METHOD = '''    @staticmethod
    async def increment_in_memory(
        spend_counter_cache: "DualCache", counter_key: str, increment: float
    ) -> Optional[float]:
        """Apply local deltas after an in-flight reseed establishes the spend balance."""
        lock = await SpendCounterReseed._get_lock(counter_key)
        async with lock:
            return await spend_counter_cache.async_increment_cache(
                key=counter_key, value=increment, local_only=True, refresh_ttl=True
            )

'''


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError("Unexpected reviewed source shape; refusing budget patch")
    return source.replace(old, new, 1)


def patch_reseed(source):
    marker = '    @staticmethod\n    async def from_db('
    source = replace_once(source, marker, INCREMENT_METHOD + marker)
    source = replace_once(
        source,
        '                    await spend_counter_cache.async_increment_cache(key=counter_key, value=db_spend, refresh_ttl=True)',
        '''                    cached_spend = spend_counter_cache.in_memory_cache.get_cache(key=counter_key)
                    seeded_spend = max(db_spend, float(cached_spend)) if cached_spend is not None else db_spend
                    spend_counter_cache.in_memory_cache.set_cache(key=counter_key, value=seeded_spend)
                    return seeded_spend''',
    )
    source = replace_once(
        source,
        '                    await spend_counter_cache.async_increment_cache(key=counter_key, value=window_spend)',
        '''                    cached_spend = spend_counter_cache.in_memory_cache.get_cache(key=counter_key)
                    seeded_spend = (
                        max(window_spend, float(cached_spend)) if cached_spend is not None else window_spend
                    )
                    spend_counter_cache.in_memory_cache.set_cache(key=counter_key, value=seeded_spend)
                    return seeded_spend''',
    )
    return replace_once(source, '            return window_spend\n', '            return current_value\n')


def patch_proxy(source):
    return replace_once(
        source,
        '''    return await spend_counter_cache.async_increment_cache(
        key=counter_key,
        value=increment,
        refresh_ttl=True,
    )''',
        '''    return await SpendCounterReseed.increment_in_memory(
        spend_counter_cache=spend_counter_cache, counter_key=counter_key, increment=increment
    )''',
    )


def apply(root=ROOT):
    planned = []
    for relative, expected in SOURCES.items():
        path = root / relative
        original = path.read_bytes()
        if hashlib.sha256(original).hexdigest() != expected:
            raise RuntimeError(f"Unreviewed LiteLLM source: {relative}; refusing budget patch")
        patched = (patch_reseed if relative.endswith('spend_counter_reseed.py') else patch_proxy)(original.decode())
        compile(patched, str(path), "exec")
        planned.append((path, patched, {
            "source": relative,
            "before_sha256": expected,
            "after_sha256": hashlib.sha256(patched.encode()).hexdigest(),
        }))
    # Validate every file before writing any file in the build layer.
    for path, patched, _ in planned:
        path.write_text(patched)
    return {
        "patch": "upstream-in-memory-spend-reseed-and-delta-lock-backport",
        "upstream": UPSTREAM,
        "sources": [metadata for _, _, metadata in planned],
        "ttl_changed": False,
        "budget_limits_changed": False,
        "reservation_settlement_changed": False,
        "known_independent_gap": "expired-counter-old-settlement-can-subtract-new-reservation",
    }


if __name__ == "__main__":
    print(json.dumps(apply(), sort_keys=True))
