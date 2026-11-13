"""The app-lab harness interference endpoint (`POST /interfere` in run.py).

The real-app recovery, conflict and stalled-quit rows need an action only the
*harness* can perform: write a file from outside the application, change a
fixture's mode, or terminate the app's process group after an acknowledged
recovery write. The endpoint is loopback-only, refuses paths outside the
scenario workspace (including through a symlink), and refuses any signal target
that is not the app it launched.

Run with: python3 -m unittest discover -s scripts/tests
"""

import importlib.util
import json
import os
import signal
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
RUN_PY = REPO / "scripts/app-lab/run.py"


def load_module():
    spec = importlib.util.spec_from_file_location("app_lab_run_interfere", RUN_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class InterfereTest(unittest.TestCase):
    def setUp(self) -> None:
        self.run = load_module()
        self.scratch = tempfile.TemporaryDirectory()
        self.workspace = Path(self.scratch.name) / "workspace"
        self.workspace.mkdir()
        self.outside = Path(self.scratch.name) / "outside"
        self.outside.mkdir()
        self.server = self.run.ReportServer(self.workspace)

    def tearDown(self) -> None:
        self.server.httpd.shutdown()
        self.server.httpd.server_close()
        self.scratch.cleanup()

    def post(self, payload) -> tuple[int, dict]:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        request = urllib.request.Request(
            f"{self.server.url}/interfere",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read() or b"{}")

    # ---------------------------------------------------------------- write
    def test_write_inside_the_workspace_succeeds(self) -> None:
        target = self.workspace / "conflict.txt"
        status, reply = self.post(
            {"action": "write", "path": str(target), "content": "external v1\n"}
        )
        self.assertEqual(status, 200)
        self.assertTrue(reply["ok"])
        self.assertEqual(target.read_text(), "external v1\n")

    def test_write_outside_the_workspace_is_refused(self) -> None:
        for target in (
            self.outside / "escape.txt",
            self.workspace / ".." / "outside" / "escape.txt",
        ):
            status, reply = self.post(
                {"action": "write", "path": str(target), "content": "no\n"}
            )
            self.assertEqual(status, 400, target)
            self.assertFalse(reply["ok"])
            self.assertIn("outside", reply["error"])
            self.assertFalse(target.exists())

    def test_write_through_a_symlink_out_of_the_workspace_is_refused(self) -> None:
        link = self.workspace / "link"
        link.symlink_to(self.outside, target_is_directory=True)
        target = link / "escape.txt"
        status, reply = self.post(
            {"action": "write", "path": str(target), "content": "no\n"}
        )
        self.assertEqual(status, 400)
        self.assertIn("outside", reply["error"])
        self.assertFalse((self.outside / "escape.txt").exists())

    def test_write_requires_an_absolute_path_and_a_string_body(self) -> None:
        status, reply = self.post(
            {"action": "write", "path": "relative.txt", "content": "x"}
        )
        self.assertEqual(status, 400)
        self.assertIn("absolute", reply["error"])
        status, reply = self.post(
            {"action": "write", "path": str(self.workspace / "a.txt"), "content": 1}
        )
        self.assertEqual(status, 400)

    # ---------------------------------------------------------------- chmod
    def test_chmod_inside_the_workspace_changes_the_mode(self) -> None:
        target = self.workspace / "readonly.txt"
        target.write_text("fixture\n")
        status, reply = self.post(
            {"action": "chmod", "path": str(target), "mode": 0o444}
        )
        self.assertEqual(status, 200)
        self.assertTrue(reply["ok"])
        self.assertEqual(os.stat(target).st_mode & 0o777, 0o444)
        status, _ = self.post({"action": "chmod", "path": str(target), "mode": 0o644})
        self.assertEqual(status, 200)
        self.assertEqual(os.stat(target).st_mode & 0o777, 0o644)

    def test_chmod_outside_the_workspace_is_refused(self) -> None:
        target = self.outside / "escape.txt"
        target.write_text("x\n")
        status, reply = self.post(
            {"action": "chmod", "path": str(target), "mode": 0o444}
        )
        self.assertEqual(status, 400)
        self.assertEqual(os.stat(target).st_mode & 0o777, 0o644)

    def test_chmod_refuses_a_mode_that_is_not_a_permission_bitset(self) -> None:
        target = self.workspace / "fixture.txt"
        target.write_text("x\n")
        for mode in (-1, 0o10000, "0644", True):
            status, reply = self.post(
                {"action": "chmod", "path": str(target), "mode": mode}
            )
            self.assertEqual(status, 400, mode)
            self.assertFalse(reply["ok"])

    # ---------------------------------------------------------------- signal
    def test_signal_refuses_a_server_without_a_launched_app(self) -> None:
        status, reply = self.post(
            {"action": "signal", "target": "app", "signal": "SIGKILL"}
        )
        self.assertEqual(status, 400)
        self.assertIn("not been launched", reply["error"])

    def test_signal_refuses_other_targets_and_signals(self) -> None:
        self.server.app_pid = os.getpid()
        for payload in (
            {"action": "signal", "target": "harness", "signal": "SIGKILL"},
            {"action": "signal", "target": "app", "signal": "SIGINT"},
            {"action": "signal", "target": "app"},
        ):
            status, reply = self.post(payload)
            self.assertEqual(status, 400, payload)
            self.assertFalse(reply["ok"])

    def test_signal_kills_the_app_process_group(self) -> None:
        process = subprocess.Popen(
            ["sleep", "60"], start_new_session=True
        )
        try:
            self.server.app_pid = process.pid
            status, reply = self.post(
                {"action": "signal", "target": "app", "signal": "SIGKILL"}
            )
            self.assertEqual(status, 200)
            self.assertTrue(reply["ok"])
            self.assertEqual(reply["signal"], "SIGKILL")
            process.wait(timeout=10)
            self.assertEqual(process.returncode, -signal.SIGKILL)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)

    # ---------------------------------------------------------------- protocol
    def test_unknown_action_and_bad_json_are_refused(self) -> None:
        status, reply = self.post({"action": "delete", "path": str(self.workspace)})
        self.assertEqual(status, 400)
        self.assertIn("action", reply["error"])
        status, reply = self.post(b"{not json")
        self.assertEqual(status, 400)

    def test_only_loopback_clients_may_interfere(self) -> None:
        self.assertTrue(self.server.loopback("127.0.0.1"))
        self.assertTrue(self.server.loopback("::1"))
        self.assertFalse(self.server.loopback("10.0.0.5"))
        self.assertFalse(self.server.loopback("192.168.1.10"))

    def test_no_server_without_a_workspace_accepts_a_path(self) -> None:
        bare = self.run.ReportServer()
        try:
            status, reply = bare.interfere(
                {"action": "write", "path": str(self.workspace / "a.txt"), "content": "x"}
            )
            self.assertEqual(status, 400)
            self.assertIn("workspace", reply["error"])
            self.assertFalse((self.workspace / "a.txt").exists())
        finally:
            bare.httpd.shutdown()
            bare.httpd.server_close()

    def test_every_accepted_action_is_recorded_as_evidence(self) -> None:
        self.post(
            {"action": "write", "path": str(self.workspace / "a.txt"), "content": "x"}
        )
        self.assertEqual(len(self.server.operations), 1)
        self.assertEqual(self.server.operations[0]["action"], "write")

    def test_oversized_content_length_is_rejected_before_reading_body(self) -> None:
        port = self.server.httpd.server_port
        oversized = self.run.INTERFERE_MAX_BODY + 1
        with socket.create_connection(("127.0.0.1", port), timeout=1.5) as sock:
            sock.sendall(
                f"POST /interfere HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{port}\r\n"
                f"Content-Length: {oversized}\r\n"
                f"\r\n".encode("ascii")
            )
            chunks = []
            while chunk := sock.recv(4096):
                chunks.append(chunk)
            response = b"".join(chunks).decode("utf-8", "replace")
        self.assertTrue(response.startswith("HTTP/1.0 413"), response)
        self.assertIn("request too large", response)


class RecoveryScenarioWiringTest(unittest.TestCase):
    """`recovery` is a launch-indexed Linux scenario, not a single-page one."""

    def setUp(self) -> None:
        self.run = load_module()

    def test_recovery_is_a_linux_scenario(self) -> None:
        self.assertIn("recovery", self.run.LINUX_SCENARIOS)

    def test_recovery_has_a_host_timeout_for_two_launches(self) -> None:
        class Args:
            timeout = None
            scenario = "recovery"
            startup_repeats = 3
            warmup = 5
        timeout = self.run.host_timeout(Args(), {"name": "recovery"})
        self.assertGreaterEqual(timeout, 240)
        self.assertLessEqual(timeout, 900)

    def test_recovery_write_step_requires_two_acknowledged_drafts_and_sigkill(self) -> None:
        sigkill = [{"action": "signal", "signal": "SIGKILL"}]
        empty_ack = {"drafts": [], "bufferIds": []}
        self.assertFalse(
            self.run.recovery_write_step(empty_ack, -signal.SIGKILL, sigkill)["ok"]
        )
        one_ack = {"drafts": [{"bufferId": "a"}], "bufferIds": ["a"]}
        self.assertFalse(
            self.run.recovery_write_step(one_ack, -signal.SIGKILL, sigkill)["ok"]
        )
        two_ack = {
            "drafts": [{"bufferId": "a"}, {"bufferId": "b"}],
            "bufferIds": ["a", "b"],
        }
        self.assertFalse(self.run.recovery_write_step(two_ack, 0, sigkill)["ok"])
        self.assertFalse(
            self.run.recovery_write_step(two_ack, -signal.SIGKILL, [])["ok"]
        )
        self.assertTrue(
            self.run.recovery_write_step(two_ack, -signal.SIGKILL, sigkill)["ok"]
        )


if __name__ == "__main__":
    unittest.main()
