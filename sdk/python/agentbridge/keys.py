"""Local key management. The private key never leaves the machine."""

from __future__ import annotations

import base64
import os
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

__all__ = ["generate_key_pair", "public_key_base64", "save_key", "load_key"]

ED25519_KEY_BYTES = 32


def generate_key_pair() -> tuple[bytes, bytes]:
    """Return ``(private, public)`` raw 32-byte keys."""
    key = Ed25519PrivateKey.generate()
    private = key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public = key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    return private, public


def public_key_base64(public: bytes) -> str:
    return base64.b64encode(public).decode("ascii")


def save_key(path: str | Path, private: bytes, *, force: bool = False) -> None:
    """Write the key 0600, refusing to clobber.

    Same file format as the TypeScript SDK — base64 of the raw 32 bytes — so
    one key file works with both, and with the ``agentbridge`` CLI.
    """
    p = Path(path)
    if p.exists() and not force:
        raise FileExistsError(f"a key already exists at {p}; pass force to replace it")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(base64.b64encode(private).decode("ascii"), encoding="utf-8")
    try:
        os.chmod(p, 0o600)
    except (OSError, NotImplementedError):
        # Windows has no POSIX mode. Silently best-effort rather than failing
        # a key write that otherwise succeeded.
        pass


def load_key(path: str | Path) -> bytes:
    p = Path(path)
    try:
        text = p.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise FileNotFoundError(f"no key file at {p}") from exc
    raw = base64.b64decode(text, validate=True)
    if len(raw) != ED25519_KEY_BYTES:
        raise ValueError(
            f"key at {p} is {len(raw)} bytes; an Ed25519 key is {ED25519_KEY_BYTES}"
        )
    return raw
