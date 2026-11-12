"""Invariants of the upstream-state sentinels used by the coexistence run.

Run with: python3 -m unittest discover -s scripts/tests
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import linux_profile  # noqa: E402
import namespace_sentinels  # noqa: E402


class SentinelTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="terax-sentinels-")
        self.home = Path(self._tmp.name) / "home"
        self.home.mkdir()
        self.manifest = namespace_sentinels.seed(self.home)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_untouched_upstream_state_verifies(self) -> None:
        self.assertEqual(namespace_sentinels.verify(self.home, self.manifest), [])

    def test_every_kind_of_upstream_state_is_covered(self) -> None:
        names = set(self.manifest["files"])
        self.assertIn(f".cache/{linux_profile.UPSTREAM_NAMESPACE}/control.json", names)
        self.assertIn(
            f".cache/{linux_profile.UPSTREAM_NAMESPACE}/run/4242/bin/terax", names
        )
        self.assertIn(f".config/{linux_profile.UPSTREAM_IDENTIFIER}/settings.json", names)
        self.assertIn(
            f".local/share/{linux_profile.UPSTREAM_IDENTIFIER}/secrets.json", names
        )
        self.assertIn(f".local/state/{linux_profile.UPSTREAM_IDENTIFIER}/state.json", names)
        self.assertIn(
            f".cache/{linux_profile.UPSTREAM_NAMESPACE}/shell-integration/bash/bashrc", names
        )
        self.assertIn(".claude/settings.json", names)
        self.assertIn(".pi/agent/extensions/terax-notifications.ts", names)
        upstream_hooks = json.loads((self.home / ".claude/settings.json").read_text())
        serialized = json.dumps(upstream_hooks)
        # Derived from the table, not a literal: the sentinel must carry upstream's own CLI
        # variable so the fork's install/uninstall sees it as foreign.
        self.assertIn(f"${linux_profile.UPSTREAM_ENV_PREFIX}_CLI", serialized)
        self.assertNotIn(
            f"${linux_profile.IDENTITY['envPrefix']}_", serialized
        )

    def test_a_modified_or_deleted_file_is_detected(self) -> None:
        control = self.home / ".cache" / linux_profile.UPSTREAM_NAMESPACE / "control.json"
        control.write_text("{}\n")
        self.assertTrue(
            any(
                "control.json" in problem
                for problem in namespace_sentinels.verify(self.home, self.manifest)
            )
        )

        (self.home / ".pi/agent/extensions/terax-notifications.ts").unlink()
        self.assertTrue(
            any(
                "terax-notifications.ts" in problem
                for problem in namespace_sentinels.verify(self.home, self.manifest)
            )
        )

    def test_a_file_created_inside_an_upstream_directory_is_detected(self) -> None:
        stray = (
            self.home
            / ".cache"
            / linux_profile.UPSTREAM_NAMESPACE
            / "shell-integration"
            / "zsh"
            / ".pwn"
        )
        stray.write_text("x")
        self.assertTrue(
            any(
                "created inside an upstream directory" in problem
                for problem in namespace_sentinels.verify(self.home, self.manifest)
            )
        )

    def test_the_fork_state_is_namespaced_and_never_the_upstream_cache_dir(self) -> None:
        state = namespace_sentinels.fork_state(self.home)
        self.assertFalse(state["isUpstreamCacheDir"])
        self.assertNotEqual(state["namespace"], linux_profile.UPSTREAM_NAMESPACE)
        self.assertTrue(state["cacheDir"].endswith(linux_profile.NAMESPACE))
        self.assertTrue(state["dataDir"].endswith(linux_profile.PRODUCT_IDENTIFIER))
        # The descriptor the fork publishes is not the one the upstream app owns.
        self.assertNotEqual(
            Path(state["controlDescriptor"]).parent,
            self.home / ".cache" / linux_profile.UPSTREAM_NAMESPACE,
        )


if __name__ == "__main__":
    unittest.main()
