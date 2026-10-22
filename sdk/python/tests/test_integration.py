"""The Python SDK against a real hub.

The unit vectors prove the encoder agrees with TypeScript; this proves the
whole chain — canonicalize, descriptor, sign, and a Node hub actually
accepting it. Skipped when the hub has not been built, so a Python-only
checkout still runs the rest of the suite rather than failing confusingly.
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

from agentbridge import AgentBridgeError, Client

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "tests" / "fixtures" / "python-hub.mjs"
HUB_DIST = ROOT / "hub" / "dist" / "index.js"


@unittest.skipUnless(HUB_DIST.exists(), "hub is not built; run `pnpm run build` first")
class TestAgainstRealHub(unittest.TestCase):
    proc: subprocess.Popen
    client: Client

    @classmethod
    def setUpClass(cls) -> None:
        cls.proc = subprocess.Popen(
            ["node", str(FIXTURE)],
            cwd=str(ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = cls.proc.stdout.readline()
        if not line.strip():
            err = cls.proc.stderr.read()
            raise RuntimeError(f"hub fixture did not start: {err}")
        cfg = json.loads(line)
        import base64

        cls.client = Client(
            base_url=f"http://127.0.0.1:{cfg['port']}",
            workspace=cfg["workspace"],
            agent=cfg["agent"],
            private_key=base64.b64decode(cfg["privateKeyBase64"]),
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.proc.terminate()
        cls.proc.wait(timeout=10)

    def test_a_python_signature_is_accepted_by_the_node_hub(self) -> None:
        # The whole point of the SDK. If canonicalization or the descriptor
        # diverged by one byte this is where it shows.
        task = self.client.create_task(
            thread="thr_py", assignee="agent:peer", title="from python", payload={"q": 1}
        )
        self.assertEqual(task["state"], "submitted")

    def test_round_trips_unicode_through_the_signature(self) -> None:
        task = self.client.create_task(
            thread="thr_py",
            assignee="agent:peer",
            title="unicode",
            payload={"text": "héllo 日本語 👩‍💻", "combining": "e\u0301"},
        )
        fetched = self.client.get_task(task["id"])
        self.assertEqual(fetched["payload"]["text"], "héllo 日本語 👩‍💻")

    def test_a_side_effect_task_is_held_at_the_gate(self) -> None:
        task = self.client.create_task(
            thread="thr_py",
            assignee="agent:peer",
            title="send email",
            payload={"to": "a@b.com"},
            side_effect=True,
        )
        self.assertEqual(task["state"], "needs-approval")

    def test_inbox_bodies_arrive_wrapped_as_untrusted(self) -> None:
        self.client.send(thread="thr_py", to=["agent:pyagent"], body={"text": "hi"})
        items = self.client.list_inbox()
        self.assertTrue(items)
        # The wrapper must survive the trip: an f-string gives the placeholder,
        # and .value is the deliberate way through.
        self.assertNotIn("hi", f"{items[0].body}")
        self.assertEqual(items[0].body.value, {"text": "hi"})

    def test_an_idempotent_create_replays_rather_than_duplicating(self) -> None:
        args = dict(
            thread="thr_py",
            assignee="agent:peer",
            title="once",
            payload={},
            idempotency_key="py-only-once",
        )
        first = self.client.create_task(**args)
        second = self.client.create_task(**args)
        self.assertEqual(first["id"], second["id"])

    def test_surfaces_a_hub_error_code_rather_than_a_status(self) -> None:
        with self.assertRaises(AgentBridgeError) as ctx:
            self.client.create_task(
                thread="thr_py", assignee="agent:ghost", title="x", payload={}
            )
        self.assertEqual(ctx.exception.code, "not_found")

    def test_a_tampered_key_is_refused(self) -> None:
        import base64

        impostor = Client(
            base_url=self.client.base_url,
            workspace=self.client.workspace,
            agent=self.client.agent,
            private_key=bytes(32),
            max_retries=0,
        )
        with self.assertRaises(AgentBridgeError) as ctx:
            impostor.get_task("tsk_whatever")
        self.assertIn(ctx.exception.code, {"signature_invalid", "unauthenticated"})


if __name__ == "__main__":
    sys.exit(unittest.main())
