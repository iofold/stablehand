from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest


class LocalEnvironment:
    """Stands in for a Harbor environment: container paths are host paths under a temp dir."""

    def __init__(self, root: Path):
        self.root = root
        self.execs: list[str] = []

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
        self.execs.append(command)
        proc = await asyncio.create_subprocess_exec(
            "bash",
            "-c",
            command,
            cwd=cwd or str(self.root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout_sec)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError(f"Command timed out after {timeout_sec} seconds")
        except asyncio.CancelledError:
            proc.kill()
            await proc.wait()
            raise
        return SimpleNamespace(stdout=out.decode(), stderr=None, return_code=proc.returncode)

    async def upload_file(self, source_path, target_path):
        shutil.copyfile(source_path, target_path)

    async def download_file(self, source_path, target_path):
        shutil.copyfile(source_path, target_path)


@pytest.fixture
def task_env(tmp_path: Path) -> LocalEnvironment:
    root = tmp_path / "app"
    root.mkdir()
    (root / "pkg").mkdir()
    (root / "pkg" / "mod.py").write_text("def answer():\n    return 41\n")
    return LocalEnvironment(root)
