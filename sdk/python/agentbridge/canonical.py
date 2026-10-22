"""JCS (RFC 8785) canonical JSON, byte-identical to the TypeScript reference.

This is the highest-risk file in the Python SDK. Every signature is computed
over canonical bytes, so a single byte of divergence from
``contracts/src/canonical.ts`` means every request this SDK makes is rejected
by the hub — and rejected with ``signature_invalid``, which points at the key
rather than at the encoder. ``tests/test_canonical.py`` asserts against
vectors generated from the TypeScript implementation for exactly that reason.

Three places where the obvious Python is wrong:

1. **Key order.** RFC 8785 §3.2.3 sorts by UTF-16 code unit. ``sorted()``
   sorts by code point, and the two disagree for anything above the BMP: a
   surrogate pair starts 0xD800, so U+10000 sorts *before* U+FFFF in UTF-16
   and *after* it by code point.
2. **Numbers.** §3.2.2.3 specifies ECMAScript ``Number::toString``. Python's
   ``repr`` agrees on many values but not on the exponential thresholds, and
   ``1.0`` is ``"1.0"`` in Python and ``"1"`` in JavaScript.
3. **No Unicode normalization.** U+00E9 and "e" + U+0301 stay distinct;
   normalizing would alter an agent's content underneath its own signature.
"""

from __future__ import annotations

import math
import re
from typing import Any

__all__ = ["canonicalize", "CanonicalizationError"]


class CanonicalizationError(TypeError):
    """A value that has no single agreed canonical form."""


def canonicalize(value: Any) -> str:
    """Return the RFC 8785 canonical JSON text for ``value``."""
    out: list[str] = []
    _write(value, out)
    return "".join(out)


def _utf16_key(key: str) -> bytes:
    """Sort key giving UTF-16 code unit order.

    Comparing UTF-16 big-endian bytes is equivalent to comparing the code unit
    sequence, which is what §3.2.3 asks for and what JavaScript's
    ``Array.prototype.sort`` does.
    """
    return key.encode("utf-16-be", errors="surrogatepass")


def _write(value: Any, out: list[str]) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, str):
        out.append(_string(value))
    elif isinstance(value, int):
        # bool is a subclass of int, handled above.
        out.append(_integer(value))
    elif isinstance(value, float):
        out.append(_number(value))
    elif isinstance(value, (list, tuple)):
        out.append("[")
        for i, item in enumerate(value):
            if i:
                out.append(",")
            _write(item, out)
        out.append("]")
    elif isinstance(value, dict):
        out.append("{")
        first = True
        for key in sorted(value.keys(), key=_utf16_key):
            if not isinstance(key, str):
                raise CanonicalizationError(
                    f"object keys must be strings, got {type(key).__name__}"
                )
            item = value[key]
            # Matches JSON.stringify, which omits undefined members. Python's
            # nearest equivalent is an explicitly absent key, so nothing is
            # dropped here — but None is null and IS emitted.
            if not first:
                out.append(",")
            first = False
            out.append(_string(key))
            out.append(":")
            _write(item, out)
        out.append("}")
    else:
        raise CanonicalizationError(
            f"cannot canonicalize {type(value).__name__}: no JSON representation"
        )


# 2**53 - 1: beyond this a JavaScript number cannot represent the integer
# exactly, so the two languages would disagree about the value itself rather
# than merely its spelling.
_MAX_SAFE = 9007199254740991


def _integer(value: int) -> str:
    if abs(value) > _MAX_SAFE:
        raise CanonicalizationError(
            f"integer {value} exceeds 2^53-1 and cannot round-trip through a "
            "JavaScript number; the hub would canonicalize it differently"
        )
    return str(value)


def _number(value: float) -> str:
    """ECMAScript ``Number::toString`` for a float.

    Implements §3.2.2.3's thresholds explicitly rather than trusting
    ``repr``: JavaScript switches to exponential notation at >=1e21 and
    <1e-6, and Python does not use the same boundaries.
    """
    if math.isnan(value) or math.isinf(value):
        raise CanonicalizationError(f"cannot canonicalize non-finite number: {value}")
    if value == 0:
        # JavaScript renders both 0 and -0 as "0".
        return "0"

    # An integral float is written without a fractional part, as JS does.
    if value.is_integer() and abs(value) < 1e21:
        as_int = int(value)
        if abs(as_int) > _MAX_SAFE:
            raise CanonicalizationError(
                f"{value} is integral but exceeds 2^53-1; see _integer"
            )
        return str(as_int)

    magnitude = abs(value)
    if magnitude >= 1e21 or magnitude < 1e-6:
        return _exponential(value)

    # repr gives the shortest string that round-trips, the same property
    # ECMAScript requires, and agrees with JS inside these thresholds.
    text = repr(value)
    if "e" in text or "E" in text:
        # Python chose exponential inside a range where JS would not.
        return _plain_from_exponential(text)
    return text


def _exponential(value: float) -> str:
    """Render as JavaScript does: ``1e+21``, ``1e-7``, ``1.5e-7``."""
    mantissa, exponent = f"{value:e}".split("e")
    # Shortest round-tripping mantissa, trailing zeros removed.
    shortest = repr(float(mantissa)).rstrip("0").rstrip(".")
    if shortest.endswith(".0"):
        shortest = shortest[:-2]
    exp = int(exponent)
    sign = "+" if exp >= 0 else "-"
    return f"{shortest}e{sign}{abs(exp)}"


def _plain_from_exponential(text: str) -> str:
    """Expand Python's exponential form to the plain decimal JS would emit."""
    from decimal import Decimal

    return format(Decimal(text), "f")


# JSON.stringify escapes only these, emits every other character literally,
# and uses the short forms where they exist.
_SHORT_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}

_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _string(value: str) -> str:
    if _LONE_SURROGATE.search(value):
        # JSON.stringify emits "\udXXX" for these; rather than guess at
        # matching that, refuse. A lone surrogate in a payload is a bug
        # upstream, and silently diverging here would break the signature.
        raise CanonicalizationError(
            "string contains an unpaired surrogate, which has no agreed canonical form"
        )

    out = ['"']
    for ch in value:
        escape = _SHORT_ESCAPES.get(ch)
        if escape is not None:
            out.append(escape)
        elif ch < " ":
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)
