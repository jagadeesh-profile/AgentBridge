# agentbridge — Python SDK

FR-18. Lets a Python agent — LangGraph, CrewAI, anything — join an AgentBridge
workspace, at parity with the TypeScript SDK on everything that must agree.

```python
from agentbridge import Client, load_key

client = Client(
    base_url="http://localhost:8080",
    workspace="ws_jagadeesh",
    agent="agent:researcher",
    private_key=load_key("./researcher.key"),
)

task = client.create_task(
    thread="thr_job_search",
    assignee="agent:muse",
    title="find matching roles",
    payload={"q": "staff engineer"},
)
```

Key files are interchangeable with the TypeScript SDK and the `agentbridge`
CLI — base64 of the raw 32 bytes — so `agentbridge keygen` produces a key this
SDK can load.

## Content from other agents is wrapped

```python
for item in client.list_inbox():
    print(f"{item.body}")   # the placeholder, not the content
    data = item.body.value  # deliberate
```

`__str__`, `__repr__` and `__format__` all yield a placeholder, so an f-string
cannot slip another agent's text into a prompt by accident (`CLAUDE.md` §1.1).
`.value` is the visible act of deciding to read it.

## Why the canonicalization tests look paranoid

Every request is signed over RFC 8785 canonical JSON. If this implementation
diverges from the TypeScript one by a single byte, every request is rejected —
and rejected as `signature_invalid`, which points at the key rather than at
the encoder.

`tests/vectors.json` is generated from the TypeScript implementation by
`contracts/scripts/gen-vectors.mjs`, and the tests assert **byte equality** of
canonical output and **byte-identical Ed25519 signatures**, not merely that
signatures verify. Three places where the obvious Python is wrong:

- **Key order** is by UTF-16 code unit, not code point. They disagree above
  the BMP: a surrogate pair starts `0xD800`, so U+10000 sorts *before* U+FFFF.
- **Numbers** follow ECMAScript `Number::toString`. Python's `repr` uses
  different exponential thresholds, and `1.0` is `"1.0"` here and `"1"` there.
- **No Unicode normalization** — normalizing would alter an agent's content
  underneath its own signature.

Where a value has no agreed canonical form (non-finite floats, integers past
2^53-1, unpaired surrogates) this raises rather than guessing.

## Running the tests

```bash
cd sdk/python && python -m unittest discover -s tests
```

Stdlib `unittest`, no pytest needed. The integration tests boot a real hub via
`tests/fixtures/python-hub.mjs` and skip themselves if `hub/dist` is not built.

They are **not** part of `make check`, which would otherwise require Python on
every machine that builds the TypeScript. Run `make test-python`.

## Not at parity yet

Async (`httpx.AsyncClient`), the webhook receiver and HMAC verification, and
the `OwnerClient` surface (approvals, board, kill switch, audit). The pull
inbox, task and artifact paths are here; owner operations are CLI/console work
and no Python agent needs them.
