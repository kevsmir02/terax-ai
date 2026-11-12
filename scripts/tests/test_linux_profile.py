"""Safety invariants of the disposable Linux profile used by the real-app runners.

Run with: python3 -m unittest discover -s scripts/tests
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import linux_profile  # noqa: E402

LAB = linux_profile.disposable_identifier("app-lab", "stable")


class ProblemsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="terax-linux-profile-")
        self.root = Path(self._tmp.name) / "run"
        self.root.mkdir()
        self.home = self.root / "home"
        self.env = linux_profile.profile_env(self.home)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_a_proper_isolated_profile_is_accepted(self) -> None:
        env = {**self.env, "TERAX_BENCH_ISOLATED": "1"}
        self.assertEqual(
            linux_profile.problems(
                LAB, env, self.root, require_isolated=True
            ),
            [],
        )

    def test_the_product_identifier_is_refused(self) -> None:
        env = {**self.env, "TERAX_BENCH_ISOLATED": "1"}
        problems = linux_profile.problems(
            linux_profile.PRODUCT_IDENTIFIER, env, self.root, require_isolated=True
        )
        self.assertTrue(problems)
        self.assertTrue(any("product identifier" in p for p in problems))

    def test_an_upstream_identifier_is_refused(self) -> None:
        # Running this fork's build under an upstream identifier would share the
        # installed upstream application's profile, data and hook groups.
        env = {**self.env, "TERAX_BENCH_ISOLATED": "1"}
        for identifier in (
            linux_profile.UPSTREAM_IDENTIFIER,
            f"{linux_profile.UPSTREAM_IDENTIFIER}.app-lab-abc123",
        ):
            problems = linux_profile.problems(
                identifier, env, self.root, require_isolated=True
            )
            self.assertTrue(
                any("upstream" in p for p in problems), f"{identifier}: {problems}"
            )

    def test_the_identity_is_provisional_and_not_upstream(self) -> None:
        self.assertTrue(linux_profile.IDENTITY["provisional"])
        self.assertNotEqual(
            linux_profile.PRODUCT_IDENTIFIER, linux_profile.UPSTREAM_IDENTIFIER
        )
        self.assertNotEqual(linux_profile.NAMESPACE, linux_profile.UPSTREAM_NAMESPACE)
        # The control descriptor and shell integration live under the fork namespace, never
        # under the upstream product-name directory.
        self.assertNotEqual(linux_profile.NAMESPACE, "terax")

    def test_an_identifier_outside_the_terax_namespace_is_refused(self) -> None:
        env = {**self.env, "TERAX_BENCH_ISOLATED": "1"}
        problems = linux_profile.problems(
            "com.example.other", env, self.root, require_isolated=True
        )
        self.assertTrue(any("namespace" in p for p in problems))

    def test_profile_directories_outside_the_run_output_are_refused(self) -> None:
        outside = {**self.env, "HOME": str(Path.home())}
        outside["TERAX_BENCH_ISOLATED"] = "1"
        problems = linux_profile.problems(
            LAB, outside, self.root, require_isolated=True
        )
        self.assertTrue(any("HOME" in p and "output" in p for p in problems))

        # A single escaped XDG directory is enough: it is where the control descriptor lives.
        escaped = {**self.env, "XDG_CACHE_HOME": str(Path.home() / ".cache")}
        escaped["TERAX_BENCH_ISOLATED"] = "1"
        problems = linux_profile.problems(
            LAB, escaped, self.root, require_isolated=True
        )
        self.assertTrue(any("XDG_CACHE_HOME" in p for p in problems))

    def test_a_missing_profile_variable_is_refused(self) -> None:
        env = {**self.env, "TERAX_BENCH_ISOLATED": "1"}
        env.pop("XDG_CACHE_HOME")
        problems = linux_profile.problems(
            LAB, env, self.root, require_isolated=True
        )
        self.assertTrue(any("XDG_CACHE_HOME" in p for p in problems))

    def test_a_bench_run_must_declare_isolation(self) -> None:
        problems = linux_profile.problems(
            LAB, self.env, self.root, require_isolated=True
        )
        self.assertTrue(any("TERAX_BENCH_ISOLATED" in p for p in problems))
        # The transport smoke is not a bench build: it only needs the profile.
        self.assertEqual(
            linux_profile.problems(
                linux_profile.disposable_identifier("pty-smoke", "abc"),
                self.env,
                self.root,
                require_isolated=False,
            ),
            [],
        )


class CleanupTest(unittest.TestCase):
    def test_cleanup_removes_the_isolated_profile(self) -> None:
        with tempfile.TemporaryDirectory(prefix="terax-linux-profile-") as tmp:
            root = Path(tmp) / "run"
            home = root / "home"
            (home / ".cache" / linux_profile.NAMESPACE).mkdir(parents=True)
            (home / ".cache" / linux_profile.NAMESPACE / "control.json").write_text("{}")
            linux_profile.prepare(home, root)
            linux_profile.cleanup(home, root)
            self.assertFalse(home.exists())

    def test_cleanup_refuses_a_directory_outside_the_run_output(self) -> None:
        with tempfile.TemporaryDirectory(prefix="terax-linux-profile-") as tmp:
            root = Path(tmp) / "run"
            root.mkdir()
            outside = Path(tmp) / "somewhere-else"
            outside.mkdir()
            with self.assertRaises(linux_profile.UnsafeProfile):
                linux_profile.cleanup(outside, root)
            self.assertTrue(outside.exists())


if __name__ == "__main__":
    unittest.main()
