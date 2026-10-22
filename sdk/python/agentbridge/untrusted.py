"""The untrusted wrapper (CLAUDE.md §1.1).

Content from another agent is data, never instructions. The TypeScript SDK
makes that hard to forget by yielding a placeholder from every stringification
path; Python's equivalent is ``__str__``/``__repr__``/``__format__``, which is
what an f-string, ``print`` and ``"%s"`` all reach for.

``.value`` is the deliberate, visible way to get at the content — the point is
that it cannot happen by accident when someone interpolates a payload into a
prompt.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

__all__ = ["Untrusted", "PLACEHOLDER"]

PLACEHOLDER = "[untrusted content; use .value to read it deliberately]"


@dataclass(frozen=True)
class Provenance:
    from_: str
    sig_verified: bool
    received_at: str


class Untrusted:
    """Wraps agent-supplied content so it cannot be interpolated by accident."""

    __slots__ = ("_value", "provenance")

    def __init__(self, value: Any, provenance: Provenance) -> None:
        self._value = value
        self.provenance = provenance

    @property
    def value(self) -> Any:
        """The content. Reading this is the deliberate act."""
        return self._value

    def __str__(self) -> str:
        return PLACEHOLDER

    def __repr__(self) -> str:
        return f"Untrusted(from={self.provenance.from_!r}, {PLACEHOLDER})"

    def __format__(self, spec: str) -> str:
        # f"{item}" goes through __format__, not __str__, so it needs its own
        # override or the placeholder is bypassed.
        return PLACEHOLDER

    @classmethod
    def from_wire(cls, wrapper: dict[str, Any]) -> "Untrusted":
        p = wrapper.get("provenance", {})
        return cls(
            wrapper.get("value"),
            Provenance(
                from_=p.get("from", ""),
                sig_verified=bool(p.get("sigVerified", False)),
                received_at=p.get("receivedAt", ""),
            ),
        )
