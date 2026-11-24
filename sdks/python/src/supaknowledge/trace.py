"""TraceRecorder: buffer what an agent did and ship it to the `traces` Edge Function.

Recording methods never raise and return the recorder (chainable). Network work happens in ``flush()`` and
``end()``, which never raise either: failures go to ``on_error``. Use it as a context manager to end the
trace automatically (outcome "failure" when the block raised, unless set explicitly).
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable, Protocol

from ._http import SupaknowledgeError

if TYPE_CHECKING:
    from .types import FlagKind, TraceOutcome


class TraceTransport(Protocol):
    def create(self, body: dict[str, Any]) -> dict[str, Any]: ...
    def update(self, trace_id: str, body: dict[str, Any]) -> None: ...
    def flag(self, **kwargs: Any) -> dict[str, Any]: ...


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _retryable(e: BaseException) -> bool:
    if not isinstance(e, SupaknowledgeError):
        return True
    return e.status is None or e.status in (408, 429) or e.status >= 500


class TraceRecorder:
    def __init__(
        self,
        transport: TraceTransport,
        *,
        name: str | None = None,
        external_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        max_batch: int = 50,
        max_buffer: int = 1000,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> None:
        self.id: str | None = None
        self.name = name
        self.external_id = external_id
        self._t = transport
        self._metadata = metadata
        self._max_batch = max_batch
        self._max_buffer = max_buffer
        self._on_error = on_error
        self._buffer: list[dict[str, Any]] = []
        self._lock = threading.RLock()
        self._ended = False
        self._outcome: TraceOutcome | None = None

    # ------------------------------------------------------------------ recording
    def system(self, content: str, metadata: dict[str, Any] | None = None) -> "TraceRecorder":
        return self.event({"role": "system", "content": content, "metadata": metadata})

    def user(self, content: str, metadata: dict[str, Any] | None = None) -> "TraceRecorder":
        return self.event({"role": "user", "content": content, "metadata": metadata})

    def assistant(self, content: str, metadata: dict[str, Any] | None = None) -> "TraceRecorder":
        return self.event({"role": "assistant", "content": content, "metadata": metadata})

    def tool(self, name: str, input: Any = None, output: Any = None, is_error: bool = False, metadata: dict[str, Any] | None = None) -> "TraceRecorder":
        return self.event({"role": "tool", "tool_name": name, "tool_input": input, "tool_output": output, "is_error": is_error, "metadata": metadata})

    def feedback(self, content: str, metadata: dict[str, Any] | None = None) -> "TraceRecorder":
        """Human feedback or a correction. The curator mines these for knowledge fixes."""
        return self.event({"role": "feedback", "content": content, "metadata": metadata})

    def event(self, e: dict[str, Any]) -> "TraceRecorder":
        try:
            with self._lock:
                if self._ended:
                    self._report(SupaknowledgeError("trace already ended; event dropped"))
                    return self
                ev = {k: v for k, v in e.items() if v is not None}
                ev.setdefault("at", _now())
                self._buffer.append(ev)
                if len(self._buffer) > self._max_buffer:
                    del self._buffer[: len(self._buffer) - self._max_buffer]
                full = len(self._buffer) >= self._max_batch
            if full:
                self.flush()
        except Exception as err:  # never raise into the host app
            self._report(err)
        return self

    def set_outcome(self, outcome: "TraceOutcome") -> "TraceRecorder":
        self._outcome = outcome
        return self

    # ------------------------------------------------------------------ shipping
    def flush(self) -> None:
        """Send buffered events now. Never raises."""
        try:
            self._flush(None)
        except Exception as err:
            self._report(err)

    def start(self) -> str | None:
        """Create the trace on the server (even with no events) and return its id. Never raises."""
        try:
            self._flush(None if self.id else {})
        except Exception as err:
            self._report(err)
        return self.id

    def end(self, outcome: "TraceOutcome | None" = None, metadata: dict[str, Any] | None = None) -> str | None:
        """Flush and close the trace. Returns the trace id (None if it never reached the server)."""
        with self._lock:
            if self._ended:
                return self.id
            self._ended = True
        extra: dict[str, Any] = {"outcome": outcome or self._outcome or "unknown", "ended_at": _now()}
        if metadata:
            extra["metadata"] = metadata
        try:
            self._flush(extra)
        except Exception as err:
            self._report(err)
        return self.id

    def flag(self, kind: "FlagKind", observation: str, **kwargs: Any) -> dict[str, Any] | None:
        """Raise a flag linked to this trace. Never raises; returns None on failure."""
        self.start()
        try:
            return self._t.flag(kind=kind, observation=observation, trace_id=self.id, **kwargs)
        except Exception as err:
            self._report(err)
            return None

    def __enter__(self) -> "TraceRecorder":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.end(outcome=self._outcome or ("failure" if exc_type else "success"))

    # ------------------------------------------------------------------ internals
    def _report(self, err: BaseException) -> None:
        try:
            if self._on_error:
                self._on_error(err)
        except Exception:
            pass

    def _flush(self, extra: dict[str, Any] | None) -> None:
        with self._lock:
            if not self._buffer and extra is None:
                return
            events = self._buffer
            self._buffer = []
            try:
                if not self.id:
                    body: dict[str, Any] = {"events": events}
                    if self.name:
                        body["name"] = self.name
                    if self.external_id:
                        body["external_id"] = self.external_id
                    meta = {**(self._metadata or {}), **((extra or {}).get("metadata") or {})}
                    if meta:
                        body["metadata"] = meta
                    if extra and extra.get("outcome"):
                        body["outcome"] = extra["outcome"]
                    r = self._t.create(body)
                    if not r or not r.get("trace_id"):
                        raise SupaknowledgeError("traces endpoint returned no trace_id")
                    self.id = r["trace_id"]
                    if extra and extra.get("ended_at"):
                        self._t.update(self.id, {"ended_at": extra["ended_at"], "outcome": extra["outcome"]})
                else:
                    upd: dict[str, Any] = {**(extra or {})}
                    if events:
                        upd["events"] = events
                    self._t.update(self.id, upd)
            except Exception as e:
                if _retryable(e) and not self._ended:
                    self._buffer = events + self._buffer
                raise
