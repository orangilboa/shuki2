"""
openshuki agent utilities (Python).

Agents running under openshuki's subprocess runner emit one JSON object per
line on stdout. Each object is a `{ type, node?, payload? }` event that the
backend translates 1:1 into the run-event bus, the SSE stream, and the
persistent `run_events` table.

Use these helpers to avoid hand-formatting JSON. They flush after every
write so the backend gets events live, not at process exit.

Event types match the backend's `RunEventType` vocabulary:
    node_start | node_end | token | tool_call | tool_result
    custom     | error    | done
    waiting_for_llm | done_waiting

Anything you `print()` outside these helpers becomes a `token` event.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import threading
import time
import uuid
from typing import Any, Iterator

# Force UTF-8 stdout so non-ASCII payloads (e.g. ° µ) round-trip safely on
# Windows where the default console encoding is cp1252.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def emit(type_: str, *, node: str | None = None, payload: Any = None) -> None:
    """Emit a single event line to stdout."""
    msg: dict[str, Any] = {"type": type_}
    if node is not None:
        msg["node"] = node
    if payload is not None:
        msg["payload"] = payload
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def node_start(node: str, payload: Any = None) -> None:
    emit("node_start", node=node, payload=payload)


def node_end(node: str, *, progress: float | None = None, **extra: Any) -> None:
    """Mark the end of a node. `progress` is forwarded to the runs row."""
    payload: dict[str, Any] = dict(extra)
    if progress is not None:
        payload["progress"] = progress
    emit("node_end", node=node, payload=payload or None)


def token(text: str, *, node: str | None = None) -> None:
    emit("token", node=node, payload={"text": text})


def tool_call(name: str, *, args: Any = None, node: str | None = None) -> None:
    emit("tool_call", node=node, payload={"name": name, "args": args})


def tool_result(name: str, *, ok: bool, node: str | None = None, **extra: Any) -> None:
    emit("tool_result", node=node, payload={"name": name, "ok": ok, **extra})


def custom(payload: Any, *, node: str | None = None) -> None:
    """Send an arbitrary structured event. Surfaces in the UI as 'custom'."""
    emit("custom", node=node, payload=payload)


def emit_error(message: str, **extra: Any) -> None:
    """Report a fatal error. The backend will set the run to failed."""
    emit("error", payload={"message": message, **extra})


def done(*, ok: bool = True, **extra: Any) -> None:
    """Final event. The backend will synthesize one if the process exits
    without emitting it, but emitting it explicitly lets you attach a
    summary payload."""
    emit("done", payload={"ok": ok, **extra})


# ---------- llm wait (UI live-counter signal) -----------------------------
#
# Surfaces a live elapsed-seconds counter in the run-view log between
# `waiting_for_llm` and `done_waiting`. Pure UI signal, no DB side effect.
#
# Prefer the `llm_wait()` context manager — it generates a waitId, times the
# block, emits the paired events, and reports ok=False if the wrapped code
# raises. Use the standalone emitters when the wait spans an awkward
# control-flow boundary.


def waiting_for_llm(
    label: str | None = None,
    *,
    model: str | None = None,
    node: str | None = None,
) -> str:
    """Signal that the agent is blocked on an LLM call. Returns the generated
    `waitId` — pass it to `done_waiting()` to close the pair.
    """
    wait_id = str(uuid.uuid4())
    payload: dict[str, Any] = {"waitId": wait_id}
    if label is not None:
        payload["label"] = label
    if model is not None:
        payload["model"] = model
    emit("waiting_for_llm", node=node, payload=payload)
    return wait_id


def done_waiting(
    wait_id: str,
    *,
    duration_ms: int | None = None,
    ok: bool = True,
    node: str | None = None,
) -> None:
    """Close the pair opened by `waiting_for_llm()`."""
    payload: dict[str, Any] = {"waitId": wait_id, "ok": ok}
    if duration_ms is not None:
        payload["durationMs"] = duration_ms
    emit("done_waiting", node=node, payload=payload)


@contextlib.contextmanager
def llm_wait(
    label: str | None = None,
    *,
    model: str | None = None,
    node: str | None = None,
) -> Iterator[str]:
    """Context manager that emits a paired `waiting_for_llm`/`done_waiting`
    around a blocking LLM call. Reports `ok=False` if the block raises.

    Usage:
        with llm_wait("calling claude-opus-4-7", model=model, node="plan"):
            response = client.messages.create(...)
    """
    wait_id = waiting_for_llm(label, model=model, node=node)
    t0 = time.monotonic()
    try:
        yield wait_id
    except BaseException:
        done_waiting(
            wait_id,
            duration_ms=int((time.monotonic() - t0) * 1000),
            ok=False,
            node=node,
        )
        raise
    else:
        done_waiting(
            wait_id,
            duration_ms=int((time.monotonic() - t0) * 1000),
            ok=True,
            node=node,
        )


# ---------- agent config (onboarding) -------------------------------------
#
# The backend injects the agent's persisted onboarding config as the
# OPENSHUKI_AGENT_CONFIG env var (a JSON object). Read it with
# `load_agent_config()`. Grow it over time by emitting `config_patch(...)`:
# `set` overwrites scalar keys, `append` unions string values into list keys.
# The backend merges the patch into the agent_config row immediately.


def load_agent_config() -> dict[str, Any]:
    """Return the agent's persisted onboarding config (or {} if unset)."""
    raw = os.environ.get("OPENSHUKI_AGENT_CONFIG")
    if not raw:
        return {}
    try:
        obj = json.loads(raw)
    except Exception:
        return {}
    return obj if isinstance(obj, dict) else {}


def config_patch(
    *,
    set: dict[str, Any] | None = None,
    append: dict[str, list[str]] | None = None,
    node: str | None = None,
) -> None:
    """Persist learned configuration into the agent_config row mid-run.

    `set` overwrites scalar keys; `append` unions string values into the
    existing array at each key (the "learn over time" primitive).
    """
    payload: dict[str, Any] = {}
    if set:
        payload["set"] = set
    if append:
        payload["append"] = append
    emit("config_patch", node=node, payload=payload)


# ---------- artifacts ------------------------------------------------------
#
# An artifact is a piece of output that should outlive the run's event log:
# a markdown summary, a generated image, an audio clip, etc. The backend
# persists artifacts in its `artifacts` table and serves them via
# /api/artifacts/<id>/content. The UI renders them under the run's
# "Artifacts" tab.

def artifact(
    name: str,
    kind: str,
    content: str,
    *,
    mime: str | None = None,
    node: str | None = None,
) -> None:
    """Emit a text-shaped artifact (kind='md' or 'text') with inline content.

    `name`  filesystem-safe display name (e.g. "summary.md")
    `kind`  'md' | 'text'
    `mime`  optional override; defaults are text/markdown / text/plain
    """
    payload: dict[str, Any] = {"name": name, "kind": kind, "content": content}
    if mime is not None:
        payload["mime"] = mime
    emit("artifact", node=node, payload=payload)


def artifact_file(
    name: str,
    kind: str,
    path: str,
    *,
    mime: str | None = None,
    node: str | None = None,
) -> None:
    """Emit an artifact whose content lives in a file on disk.

    The backend will copy the file into its managed artifacts directory.
    Use this for binary kinds ('image', 'audio', 'video'); text kinds may
    also use file mode if more convenient.

    `path` may be absolute or relative to the tool's working directory.
    """
    payload: dict[str, Any] = {"name": name, "kind": kind, "path": path}
    if mime is not None:
        payload["mime"] = mime
    emit("artifact", node=node, payload=payload)


# ---------- ask_user (agent ↔ user Q&A) ---------------------------------
#
# When an agent needs input from the user it emits an `ask_user` event with
# a fresh `interactionId` and then blocks reading stdin. The backend persists
# the question to the `agent_interactions` table, surfaces it in the UI, and
# once the user answers, writes a `{ "type": "user_response", "payload":
# { "interactionId", "answer" } }` JSONL line back on this process's stdin.
#
# The reader runs in a background thread (started lazily on first call) and
# routes each response to the matching `interactionId`. This lets multiple
# concurrent questions resolve independently, in any order.


_ASK_LOCK = threading.Lock()
# interactionId -> Event signalling that the answer has arrived.
_PENDING_EVENTS: dict[str, threading.Event] = {}
_ANSWERS: dict[str, str] = {}
_READER_THREAD: threading.Thread | None = None


def _ensure_reader_started() -> None:
    """Spin up the stdin reader thread on first ask_user call."""
    global _READER_THREAD
    with _ASK_LOCK:
        if _READER_THREAD is not None and _READER_THREAD.is_alive():
            return

        def reader() -> None:
            for raw_line in sys.stdin:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if not isinstance(obj, dict):
                    continue
                if obj.get("type") != "user_response":
                    continue
                payload = obj.get("payload") or {}
                interaction_id = payload.get("interactionId")
                answer = payload.get("answer")
                if not isinstance(interaction_id, str) or not isinstance(answer, str):
                    continue
                with _ASK_LOCK:
                    _ANSWERS[interaction_id] = answer
                    ev = _PENDING_EVENTS.pop(interaction_id, None)
                if ev is not None:
                    ev.set()

        t = threading.Thread(target=reader, name="agent-stdin-reader", daemon=True)
        t.start()
        _READER_THREAD = t


def ask_user(
    prompt: str,
    *,
    choices: list[str] | None = None,
    node: str | None = None,
) -> str:
    """Ask the user a question and block until they answer. Returns the
    answer string.

    This call is "asynchronous" with respect to the user — the run is paused
    indefinitely from the agent's point of view — but the function itself is
    synchronous (blocks the calling thread). For asyncio agents, see
    `ask_user_async()`, which wraps this with `asyncio.to_thread`.

    `choices` is an optional list of suggested answers; the UI may render
    them as quick-select buttons. The user can always type a free-form
    answer regardless.
    """
    _ensure_reader_started()
    interaction_id = str(uuid.uuid4())
    event = threading.Event()
    with _ASK_LOCK:
        _PENDING_EVENTS[interaction_id] = event

    payload: dict[str, Any] = {"interactionId": interaction_id, "prompt": prompt}
    if choices:
        payload["choices"] = list(choices)
    emit("ask_user", node=node, payload=payload)

    event.wait()
    with _ASK_LOCK:
        return _ANSWERS.pop(interaction_id, "")


async def ask_user_async(
    prompt: str,
    *,
    choices: list[str] | None = None,
    node: str | None = None,
) -> str:
    """Asyncio-compatible wrapper around `ask_user`.

    Delegates to the same stdin reader (so calling both forms in one process
    is fine) and yields control back to the event loop while waiting.
    """
    return await asyncio.to_thread(ask_user, prompt, choices=choices, node=node)
