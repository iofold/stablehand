"""HTTP relay between a Stablehand agent's HTTP tools and a Harbor task environment.

Stablehand runs agent HTTP tools on its orchestrator. Each tool is a POST of the
model's JSON arguments to a fixed URL, and the response body becomes the tool
result. The relay serves those URLs from inside the Harbor agent process and
turns each call into an ``exec``, ``upload_file`` or ``download_file`` on the
trial's environment, so the repository never leaves the task container.

Every request must carry the trial's bearer secret. Errors the model can act on
(a missing file, a bad argument) come back as 4xx responses with a plain-text
reason; Stablehand shows that text to the model as the tool error.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import shlex
import socket
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

from aiohttp import web


class ExecResultLike(Protocol):
    stdout: str | None
    stderr: str | None
    return_code: int


class TaskEnvironment(Protocol):
    """The subset of Harbor's ``BaseEnvironment`` the relay uses."""

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResultLike: ...

    async def upload_file(self, source_path: Path | str, target_path: str) -> None: ...

    async def download_file(self, source_path: str, target_path: Path | str) -> None: ...


TOOL_NAMES = ("task_bash", "task_read", "task_write", "task_submit")


@dataclass(frozen=True)
class RelayLimits:
    default_timeout_sec: int = 120
    # Stablehand's sandbox gives one tool call 5 minutes; stay well under it.
    max_timeout_sec: int = 240
    max_output_chars: int = 30_000
    max_read_chars: int = 100_000
    max_write_bytes: int = 4_000_000


@dataclass
class RelayCall:
    tool: str
    status: int
    duration_ms: int
    detail: dict[str, Any] = field(default_factory=dict)


class RelayError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def truncate_middle(text: str, limit: int) -> str:
    """Keep the head and the (longer) tail of ``text`` when it exceeds ``limit``."""
    if len(text) <= limit:
        return text
    head = limit // 3
    tail = limit - head
    omitted = len(text) - head - tail
    return f"{text[:head]}\n[... {omitted} characters omitted ...]\n{text[-tail:]}"


class TaskRelay:
    """Serves the ``task_*`` tools for one trial."""

    def __init__(
        self,
        environment: TaskEnvironment,
        token: str,
        *,
        workdir: str | None = None,
        limits: RelayLimits | None = None,
        log_path: Path | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        if len(token) < 16:
            raise ValueError("relay token must be at least 16 characters")
        self._environment = environment
        self._token = token.encode()
        self._workdir = workdir
        self.limits = limits or RelayLimits()
        self._log_path = log_path
        self._logger = logger or logging.getLogger(__name__)
        self._runner: web.AppRunner | None = None
        self.port: int | None = None
        self.expected_agent_id: str | None = None
        self.calls: list[RelayCall] = []
        self._inflight: set[asyncio.Task[Any]] = set()
        self.submitted_at: float | None = None
        self.submit_note: str | None = None

    # -- lifecycle -----------------------------------------------------------

    @property
    def workdir(self) -> str:
        return self._workdir or "/"

    async def start(self, host: str, port: int = 0) -> int:
        if self._workdir is None:
            self._workdir = await self._discover_workdir()
        app = web.Application(client_max_size=self.limits.max_write_bytes * 2 + 65_536)
        for name in TOOL_NAMES:
            app.router.add_post(f"/{name}", self._handler(name))
        app.router.add_get("/healthz", self._healthz)
        family = socket.AF_INET6 if ":" in host else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            sock.close()
            raise
        # Do not hold shutdown for an in-flight command; the trial is over by then.
        runner = web.AppRunner(app, access_log=None, shutdown_timeout=2.0)
        await runner.setup()
        site = web.SockSite(runner, sock)
        await site.start()
        self._runner = runner
        self.port = sock.getsockname()[1]
        return self.port

    async def stop(self) -> None:
        # Commands still running belong to a trial that is over: stop waiting on them.
        pending = [task for task in self._inflight if not task.done()]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.wait(pending, timeout=5)
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None

    @property
    def submitted(self) -> bool:
        return self.submitted_at is not None

    async def _discover_workdir(self) -> str:
        try:
            result = await self._environment.exec("pwd", timeout_sec=30)
        except Exception:  # noqa: BLE001 - fall back to / when the probe fails
            self._logger.warning("relay: could not read the task container's working directory")
            return "/"
        lines = (result.stdout or "").strip().splitlines()
        if result.return_code == 0 and lines and lines[-1].startswith("/"):
            return lines[-1]
        return "/"

    # -- request plumbing ----------------------------------------------------

    async def _healthz(self, _request: web.Request) -> web.Response:
        return web.Response(text="ok")

    def _handler(self, tool: str):
        async def handle(request: web.Request) -> web.Response:
            current = asyncio.current_task()
            if current is not None:
                self._inflight.add(current)
                current.add_done_callback(self._inflight.discard)
            started = time.monotonic()
            detail: dict[str, Any] = {}
            status = 200
            try:
                self._authorize(request)
                args = await self._read_args(request)
                text = await self._dispatch(tool, args, detail)
                response = web.Response(text=text, content_type="text/plain")
            except RelayError as exc:
                status = exc.status
                response = web.Response(status=exc.status, text=exc.message, content_type="text/plain")
            except Exception as exc:  # noqa: BLE001 - every failure must reach the model as text
                status = 502
                self._logger.exception("relay: %s failed", tool)
                response = web.Response(
                    status=502,
                    text=f"The task environment failed to run {tool}: {type(exc).__name__}: {exc}",
                    content_type="text/plain",
                )
            if status != 401:
                self._record(tool, status, started, detail)
            return response

        return handle

    def _authorize(self, request: web.Request) -> None:
        header = request.headers.get("Authorization", "")
        scheme, _, presented = header.partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(presented.strip().encode(), self._token):
            raise RelayError(401, "unauthorized")
        if self.expected_agent_id is not None:
            agent_id = request.headers.get("X-Agent-Id")
            if agent_id is not None and agent_id != self.expected_agent_id:
                raise RelayError(403, "this relay serves a different agent")

    async def _read_args(self, request: web.Request) -> dict[str, Any]:
        raw = await request.read()
        if not raw.strip():
            return {}
        try:
            args = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RelayError(400, f"arguments must be a JSON object: {exc}") from exc
        if not isinstance(args, dict):
            raise RelayError(400, "arguments must be a JSON object")
        return args

    def _record(self, tool: str, status: int, started: float, detail: dict[str, Any]) -> None:
        call = RelayCall(tool=tool, status=status, duration_ms=int((time.monotonic() - started) * 1000), detail=detail)
        self.calls.append(call)
        if self._log_path is None:
            return
        line = {"ts": time.time(), "tool": tool, "status": status, "durationMs": call.duration_ms, **detail}
        try:
            with self._log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(line, ensure_ascii=False) + "\n")
        except OSError:
            self._logger.warning("relay: could not append to %s", self._log_path)

    async def _dispatch(self, tool: str, args: dict[str, Any], detail: dict[str, Any]) -> str:
        if tool == "task_bash":
            return await self.task_bash(args, detail)
        if tool == "task_read":
            return await self.task_read(args, detail)
        if tool == "task_write":
            return await self.task_write(args, detail)
        if tool == "task_submit":
            return self.task_submit(args, detail)
        raise RelayError(404, f"unknown tool {tool}")

    # -- tools ---------------------------------------------------------------

    def _resolve(self, raw: Any) -> str:
        if not isinstance(raw, str) or not raw.strip():
            raise RelayError(400, "path must be a non-empty string")
        if "\0" in raw:
            raise RelayError(400, "path must not contain NUL")
        path = PurePosixPath(raw.strip())
        if not path.is_absolute():
            path = PurePosixPath(self.workdir) / path
        return str(path)

    def _timeout(self, raw: Any) -> int:
        if raw is None:
            return self.limits.default_timeout_sec
        try:
            value = int(raw)
        except (TypeError, ValueError) as exc:
            raise RelayError(400, "timeoutSec must be a whole number of seconds") from exc
        return max(1, min(value, self.limits.max_timeout_sec))

    async def task_bash(self, args: dict[str, Any], detail: dict[str, Any]) -> str:
        command = args.get("command")
        if not isinstance(command, str) or not command.strip():
            raise RelayError(400, "command must be a non-empty string")
        timeout = self._timeout(args.get("timeoutSec"))
        detail["command"] = command[:500]
        detail["timeoutSec"] = timeout
        # `timeout` kills the command inside the container; the exec timeout is
        # only a backstop for a wedged `docker compose exec`.
        wrapped = f"timeout -k 5 {timeout} bash -c {shlex.quote(command)}"
        try:
            result = await self._environment.exec(wrapped, cwd=self.workdir, timeout_sec=timeout + 30)
        except RuntimeError as exc:
            if "timed out" in str(exc):
                detail["exitCode"] = None
                return f"exit_code: timeout\nThe command did not finish within {timeout} s and was stopped."
            raise
        exit_code = result.return_code
        detail["exitCode"] = exit_code
        output = (result.stdout or "") + (result.stderr or "")
        header = f"exit_code: {exit_code}"
        if exit_code == 124:
            header += f" (stopped after the {timeout} s timeout)"
        body = truncate_middle(output, self.limits.max_output_chars)
        return f"{header}\n{body}" if body else header

    async def task_read(self, args: dict[str, Any], detail: dict[str, Any]) -> str:
        path = self._resolve(args.get("path"))
        detail["path"] = path
        start_line = _optional_int(args.get("startLine"), "startLine")
        end_line = _optional_int(args.get("endLine"), "endLine")
        with tempfile.TemporaryDirectory(prefix="sh-relay-") as scratch:
            local = Path(scratch) / "file"
            try:
                await self._environment.download_file(path, local)
            except Exception as exc:  # noqa: BLE001 - explain the miss to the model
                raise RelayError(404, await self._explain_missing(path, exc)) from exc
            if not local.is_file():
                raise RelayError(404, await self._explain_missing(path, None))
            data = local.read_bytes()
        detail["bytes"] = len(data)
        if b"\0" in data[:8192]:
            return f"{path} is a binary file ({len(data)} bytes); inspect it with task_bash instead."
        text = data.decode("utf-8", errors="replace")
        if start_line is not None or end_line is not None:
            lines = text.splitlines(keepends=True)
            first = max(1, start_line or 1)
            last = min(len(lines), end_line or len(lines))
            text = "".join(lines[first - 1 : last])
            note = f"[lines {first}-{last} of {len(lines)}]\n"
        else:
            note = ""
        if len(text) > self.limits.max_read_chars:
            total_lines = text.count("\n") + 1
            text = text[: self.limits.max_read_chars]
            note += (
                f"[truncated to the first {self.limits.max_read_chars} characters of about {total_lines} lines;"
                " pass startLine and endLine to read the rest]\n"
            )
        return note + text

    async def _explain_missing(self, path: str, exc: Exception | None) -> str:
        quoted = shlex.quote(path)
        probe = f"if [ -d {quoted} ]; then echo dir; elif [ -e {quoted} ]; then echo other; else echo missing; fi"
        try:
            result = await self._environment.exec(probe, timeout_sec=30)
            kind = (result.stdout or "").strip().splitlines()[-1:] or ["missing"]
        except Exception:  # noqa: BLE001 - the probe is best effort
            kind = ["unknown"]
        if kind[0] == "dir":
            return f"{path} is a directory; list it with task_bash (ls)."
        if kind[0] == "missing":
            return f"No such file: {path}"
        reason = f": {exc}" if exc else ""
        return f"Could not read {path}{reason}"

    async def task_write(self, args: dict[str, Any], detail: dict[str, Any]) -> str:
        path = self._resolve(args.get("path"))
        content = args.get("content")
        if not isinstance(content, str):
            raise RelayError(400, "content must be a string")
        data = content.encode("utf-8")
        if len(data) > self.limits.max_write_bytes:
            raise RelayError(413, f"content is {len(data)} bytes; the limit is {self.limits.max_write_bytes}")
        detail["path"] = path
        detail["bytes"] = len(data)
        parent = str(PurePosixPath(path).parent)
        prepare = f"mkdir -p {shlex.quote(parent)} && (stat -c %a {shlex.quote(path)} 2>/dev/null || true)"
        prepared = await self._environment.exec(prepare, timeout_sec=30)
        if prepared.return_code != 0:
            raise RelayError(400, f"Could not create {parent}: {(prepared.stdout or '').strip()}")
        mode_lines = (prepared.stdout or "").strip().splitlines()
        mode = mode_lines[-1] if mode_lines and mode_lines[-1].isdigit() else None
        with tempfile.TemporaryDirectory(prefix="sh-relay-") as scratch:
            local = Path(scratch) / "file"
            local.write_bytes(data)
            local.chmod(0o644)
            await self._environment.upload_file(local, path)
        if mode is not None and mode != "644":
            await self._environment.exec(f"chmod {mode} {shlex.quote(path)}", timeout_sec=30)
        return f"Wrote {len(data)} bytes to {path}"

    def task_submit(self, args: dict[str, Any], detail: dict[str, Any]) -> str:
        note = args.get("summary") or args.get("note")
        if isinstance(note, str) and note.strip():
            self.submit_note = note.strip()[:2000]
        if self.submitted_at is None:
            self.submitted_at = time.time()
        detail["submitted"] = True
        return "Submission recorded. The task is finished: stop calling tools and end your turn with a one-line summary."


def _optional_int(raw: Any, name: str) -> int | None:
    if raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise RelayError(400, f"{name} must be a whole number") from exc
    if value < 1:
        raise RelayError(400, f"{name} starts at 1")
    return value


def tool_definitions(base_url: str, *, secret_name: str, max_timeout_sec: int) -> list[dict[str, Any]]:
    """Stablehand ``httpTools`` entries for the relay at ``base_url``."""
    auth = {"type": "bearer", "secretName": secret_name}
    bash_timeout_ms = (max_timeout_sec + 45) * 1000
    return [
        {
            "name": "task_bash",
            "description": (
                "Run a bash command inside the task environment, where the task's files live. Returns the exit code"
                " and combined stdout/stderr (long output is cut in the middle). Use it to explore, run tests and"
                " make targeted edits. No network is available there."
            ),
            "endpoint": f"{base_url}/task_bash",
            "method": "POST",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The bash command to run."},
                    "timeoutSec": {
                        "type": "integer",
                        "description": f"Seconds before the command is stopped (default 120, max {max_timeout_sec}).",
                    },
                },
                "required": ["command"],
            },
            "timeoutMs": bash_timeout_ms,
            "authentication": auth,
        },
        {
            "name": "task_read",
            "description": (
                "Read a text file from the task environment. Relative paths start at the task's working directory."
                " Pass startLine and endLine (1-based, inclusive) to read part of a long file."
            ),
            "endpoint": f"{base_url}/task_read",
            "method": "POST",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path in the task environment."},
                    "startLine": {"type": "integer", "description": "First line to return (1-based)."},
                    "endLine": {"type": "integer", "description": "Last line to return (inclusive)."},
                },
                "required": ["path"],
            },
            "timeoutMs": 120_000,
            "authentication": auth,
        },
        {
            "name": "task_write",
            "description": (
                "Create or replace a file in the task environment with the given content. Parent directories are"
                " created. Write the whole file: this does not patch."
            ),
            "endpoint": f"{base_url}/task_write",
            "method": "POST",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path in the task environment."},
                    "content": {"type": "string", "description": "The complete new file content."},
                },
                "required": ["path", "content"],
            },
            "timeoutMs": 120_000,
            "authentication": auth,
        },
        {
            "name": "task_submit",
            "description": "Call once when the task is done. Your changes in the task environment are then graded.",
            "endpoint": f"{base_url}/task_submit",
            "method": "POST",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string", "description": "Optional one-line summary of the change."},
                },
            },
            "timeoutMs": 30_000,
            "authentication": auth,
        },
    ]


async def wait_closed(relay: TaskRelay, timeout: float = 10.0) -> None:
    """Stop the relay without letting a slow shutdown block the trial."""
    try:
        await asyncio.wait_for(relay.stop(), timeout)
    except (asyncio.TimeoutError, OSError):
        logging.getLogger(__name__).warning("relay: shutdown did not finish cleanly")
