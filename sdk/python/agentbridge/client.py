"""The agent client, at parity with the TypeScript ``Client``."""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import urlencode

import httpx

from .signing import request_descriptor, sign_descriptor
from .untrusted import Untrusted

__all__ = ["Client", "AgentBridgeError", "InboxItem"]


class AgentBridgeError(Exception):
    """An error the hub returned, carrying its contract code."""

    def __init__(self, code: str, message: str = "", trace_id: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code
        self.trace_id = trace_id


class InboxItem:
    __slots__ = ("id", "thread", "type", "task", "body", "created_at")

    def __init__(self, raw: Mapping[str, Any]) -> None:
        self.id: str = raw["id"]
        self.thread: str = raw["thread"]
        self.type: str = raw["type"]
        self.task: str | None = raw.get("task")
        # Wrapped, not unwrapped: the SDK never hands back a bare body.
        self.body = Untrusted.from_wire(raw.get("body", {}))
        self.created_at: str = raw.get("created_at", "")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


class Client:
    """Signs every request with the agent's Ed25519 key (ADR 0002)."""

    def __init__(
        self,
        *,
        base_url: str,
        workspace: str,
        agent: str,
        private_key: bytes,
        timeout: float = 10.0,
        max_retries: int = 3,
        http: httpx.Client | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.workspace = workspace
        self.agent = agent
        self._private_key = private_key
        self._timeout = timeout
        self._max_retries = max_retries
        self._http = http or httpx.Client(timeout=timeout)

    # ---------------------------------------------------------------- writes

    def send(
        self,
        *,
        thread: str,
        to: Sequence[str],
        body: Any,
        side_effect: bool = False,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/v1/messages",
            {
                "thread": thread,
                "to": list(to),
                "body": body,
                "side_effect": side_effect,
                # Always send one: the hub treats a keyed replay as a safe
                # retry and an unkeyed one as a replay attack.
                "idempotency_key": idempotency_key or str(uuid.uuid4()),
            },
        )

    def create_task(
        self,
        *,
        thread: str,
        assignee: str,
        title: str,
        payload: Any,
        side_effect: bool = False,
        due_at: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "thread": thread,
            "assignee": assignee,
            "title": title,
            "payload": payload,
            "side_effect": side_effect,
            "idempotency_key": idempotency_key or str(uuid.uuid4()),
        }
        if due_at is not None:
            body["due_at"] = due_at
        return self._request("POST", "/v1/tasks", body)

    def update_task(
        self,
        task_id: str,
        state: str,
        *,
        note: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "state": state,
            "idempotency_key": idempotency_key or str(uuid.uuid4()),
        }
        if note is not None:
            body["note"] = note
        return self._request("PATCH", f"/v1/tasks/{task_id}", body)

    def put_artifact(
        self,
        *,
        task: str,
        kind: str,
        name: str,
        content_type: str,
        inline: Any = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "task": task,
            "kind": kind,
            "name": name,
            "content_type": content_type,
            "idempotency_key": idempotency_key or str(uuid.uuid4()),
        }
        if inline is not None:
            body["inline"] = inline
        return self._request("POST", "/v1/artifacts", body)

    # ----------------------------------------------------------------- reads

    def get_task(self, task_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v1/tasks/{task_id}")

    def list_inbox(self, *, since: str | None = None, limit: int = 50) -> list[InboxItem]:
        query: dict[str, str] = {"limit": str(limit)}
        if since is not None:
            query["since"] = since
        res = self._request("GET", f"/v1/inbox?{urlencode(query)}")
        return [InboxItem(item) for item in res.get("items", [])]

    def ack_inbox(self, up_to: str) -> dict[str, Any]:
        return self._request("POST", "/v1/inbox/ack", {"up_to": up_to})

    # -------------------------------------------------------------- handlers

    def on_task(
        self,
        handler: Any,
        *,
        poll_seconds: float = 1.0,
        stop_after: int | None = None,
    ) -> int:
        """Pull-inbox loop: the transport for an agent that cannot be called.

        ``handler(item)`` receives an :class:`InboxItem` whose ``body`` is an
        :class:`Untrusted`. The cursor only advances after the handler
        returns, so a crash re-delivers rather than drops — at-least-once,
        which the hub's idempotency keys make safe.
        """
        handled = 0
        rounds = 0
        while stop_after is None or rounds < stop_after:
            rounds += 1
            items = self.list_inbox()
            if not items:
                if stop_after is not None:
                    continue
                time.sleep(poll_seconds)
                continue
            for item in items:
                handler(item)
                handled += 1
            self.ack_inbox(items[-1].id)
        return handled

    # ------------------------------------------------------------- transport

    def _request(self, method: str, path_with_query: str, body: Any = None) -> Any:
        bare, _, qs = path_with_query.partition("?")
        query: dict[str, Any] = {}
        if qs:
            for pair in qs.split("&"):
                k, _, v = pair.partition("=")
                from urllib.parse import unquote

                query[unquote(k)] = unquote(v)
        text = "" if body is None else _compact_json(body)

        last: Exception | None = None
        for attempt in range(self._max_retries + 1):
            # Re-sign per attempt: the timestamp is inside the signed
            # material, so a retry minutes later must not reuse the first.
            timestamp = _now_iso()
            signature = sign_descriptor(
                request_descriptor(
                    method=method, path=bare, query=query, body=text, timestamp=timestamp
                ),
                self._private_key,
            )
            try:
                res = self._http.request(
                    method,
                    f"{self.base_url}{path_with_query}",
                    headers={
                        "content-type": "application/json",
                        "x-agentbridge-workspace": self.workspace,
                        "x-agentbridge-agent": self.agent,
                        "x-agentbridge-timestamp": timestamp,
                        "x-agentbridge-signature": signature,
                    },
                    content=None if body is None else text.encode("utf-8"),
                )
            except httpx.HTTPError as exc:
                last = exc
            else:
                if res.is_success:
                    return res.json()
                err = _to_error(res)
                # A 4xx is the caller's fault and will not improve on retry.
                if res.status_code < 500:
                    raise err
                last = err

            if attempt < self._max_retries:
                time.sleep(2**attempt * 0.1)

        raise last if last else RuntimeError(f"request failed: {method} {path_with_query}")


def _compact_json(value: Any) -> str:
    """Compact JSON, matching ``JSON.stringify``.

    Not ``canonicalize``: the signature covers ``sha256(body)`` of the bytes
    actually sent, so what matters is that this string is what goes on the
    wire — not that its keys are sorted.
    """
    import json

    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _to_error(res: httpx.Response) -> Exception:
    try:
        parsed = res.json()
        err = parsed.get("error", {})
        code = err.get("code")
        if code:
            return AgentBridgeError(code, err.get("message", ""), err.get("trace_id"))
    except Exception:
        pass
    return AgentBridgeError("internal", f"hub returned {res.status_code}")


def iter_untrusted(items: Iterable[InboxItem]) -> Iterable[Any]:
    """Explicit unwrapping, for a caller that has decided to read content."""
    return (item.body.value for item in items)
