"""Ed25519 signing and the request descriptor, matching the TypeScript SDK.

Deterministic by construction: Ed25519 over the same bytes with the same key
produces the same signature in both languages, which is what
``tests/test_canonical.py`` asserts. "The signature verifies" would be a
weaker check — it would pass even if the two encoders disagreed on payloads
the test happened not to cover.
"""

from __future__ import annotations

import base64
import hashlib
from typing import Any, Mapping, Sequence
from urllib.parse import quote

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from .canonical import canonicalize

__all__ = [
    "PREFIX",
    "sha256_hex",
    "payload_hash",
    "request_descriptor",
    "owner_request_descriptor",
    "sign_descriptor",
    "verify_descriptor",
]

PREFIX = "ed25519:"


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def payload_hash(payload: Any) -> str:
    """The hash an approval is bound to."""
    return sha256_hex(canonicalize(payload))


def _encode_query(query: Mapping[str, str | Sequence[str]]) -> str:
    """Sorted, percent-encoded query, matching ``requestDescriptor``.

    ``encodeURIComponent`` leaves ``!'()*-._~`` unescaped; ``quote`` has a
    different default safe set, so it is given explicitly. Array values are
    sorted among themselves so two clients sending the same set agree.
    """
    safe = "!'()*-._~"
    parts: list[str] = []
    for key in sorted(query.keys()):
        value = query[key]
        values = sorted(value) if isinstance(value, (list, tuple)) else [value]
        for item in values:
            parts.append(f"{quote(key, safe=safe)}={quote(str(item), safe=safe)}")
    return "&".join(parts)


def request_descriptor(
    *,
    method: str,
    path: str,
    query: Mapping[str, str | Sequence[str]],
    body: str,
    timestamp: str,
) -> str:
    """Canonical descriptor for a request, newline delimited so no field can
    bleed into the next."""
    return "\n".join(
        [method.upper(), path, _encode_query(query), sha256_hex(body), timestamp]
    )


def owner_request_descriptor(
    *,
    method: str,
    path: str,
    query: Mapping[str, str | Sequence[str]],
    body: str,
    workspace: str,
    issued_at: str,
) -> str:
    """Owner-authenticated request descriptor (ADR 0006).

    Binds the workspace, which the agent descriptor does not: an agent exists
    in exactly one workspace so the lookup fails elsewhere, but the owner has
    no such lookup. The leading version tag keeps an agent signature from
    verifying as an owner one.
    """
    return "\n".join(
        [
            "agentbridge-owner-v1",
            workspace,
            request_descriptor(
                method=method, path=path, query=query, body=body, timestamp=issued_at
            ),
        ]
    )


def sign_descriptor(descriptor: str, private_key: bytes) -> str:
    key = Ed25519PrivateKey.from_private_bytes(private_key)
    sig = key.sign(descriptor.encode("utf-8"))
    return PREFIX + base64.b64encode(sig).decode("ascii")


def verify_descriptor(descriptor: str, signature: str, public_key: bytes) -> bool:
    """A malformed signature is a failed verification, never an exception."""
    if not signature.startswith(PREFIX):
        return False
    try:
        raw = base64.b64decode(signature[len(PREFIX) :], validate=True)
        Ed25519PublicKey.from_public_bytes(public_key).verify(
            raw, descriptor.encode("utf-8")
        )
        return True
    except Exception:
        return False
