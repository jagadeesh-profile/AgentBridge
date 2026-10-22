"""AgentBridge Python SDK (FR-18).

At parity with the TypeScript SDK on the things that must agree: JCS
canonicalization, Ed25519 request signing, the untrusted wrapper, and the
pull-inbox handler loop. Cross-language vectors generated from the
TypeScript implementation keep the two honest — see ``tests/vectors.json``.
"""

from .canonical import CanonicalizationError, canonicalize
from .client import AgentBridgeError, Client
from .keys import generate_key_pair, load_key, public_key_base64, save_key
from .signing import (
    owner_request_descriptor,
    payload_hash,
    request_descriptor,
    sha256_hex,
    sign_descriptor,
    verify_descriptor,
)
from .untrusted import Untrusted

__all__ = [
    "AgentBridgeError",
    "CanonicalizationError",
    "Client",
    "Untrusted",
    "canonicalize",
    "generate_key_pair",
    "load_key",
    "owner_request_descriptor",
    "payload_hash",
    "public_key_base64",
    "request_descriptor",
    "save_key",
    "sha256_hex",
    "sign_descriptor",
    "verify_descriptor",
]
