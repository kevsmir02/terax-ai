"""Issue #38's decision record must match the code it describes.

Run with: `python3 -m unittest discover -s scripts/tests`

`docs/architecture/update-handoff.md` records the accepted **package-tool handoff after
safe closure** as this fork's supported upgrade path, because the guarantees an in-app
RPM/DEB transaction would need were never measured. A document like that rots quietly: the
decision stays "recorded" while the code grows the very capability the decision says does
not exist. These tests read the producers (capability files, the updater sources) instead of
restating their values, so a re-granted install permission, a relaunch caller or a silently
implemented download fails here.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
DOC = REPO / "docs/architecture/update-handoff.md"
DISCOVERY_DOC = REPO / "docs/architecture/update-discovery.md"
CAPABILITIES = REPO / "src-tauri/capabilities"
UPDATER = REPO / "src/modules/updater"

# Exactly the guarantees the decision record must keep admitting are unvalidated.
UNVALIDATED = (
    "Dependency resolution",
    "Privilege prompt",
    "Cancellation mid-transaction",
    "Package locks",
    "Upgrade and removal",
    "Failure recovery",
    "Package signature rejection",
)


def capability_documents() -> list[dict]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(CAPABILITIES.glob("*.json"))]


def source_files() -> list[Path]:
    return sorted(
        path
        for path in (REPO / "src").rglob("*")
        if path.suffix in {".ts", ".tsx"} and not path.name.endswith((".test.ts", ".test.tsx"))
    )


class HandoffDecisionRecordTest(unittest.TestCase):
    def setUp(self) -> None:
        self.doc = DOC.read_text(encoding="utf-8")

    def test_the_decision_and_the_date_are_recorded(self) -> None:
        self.assertIn("2026-11-13", self.doc, "the accepted decision must carry its date")
        self.assertIn("package-tool handoff after safe closure", self.doc)
        self.assertIn("#38", self.doc, "the record must name the ticket it satisfies")
        self.assertIn("#39", self.doc, "the record must name the ticket that consumes it")

    def test_every_guarantee_is_admitted_as_unvalidated(self) -> None:
        for guarantee in UNVALIDATED:
            row = next(
                (line for line in self.doc.splitlines() if line.startswith(f"| {guarantee}")),
                None,
            )
            self.assertIsNotNone(row, f"the record does not account for {guarantee!r}")
            self.assertIn(
                "not validated",
                row,
                f"{guarantee!r} must not be claimed as validated without transaction evidence",
            )

    def test_the_record_names_what_would_validate_each_guarantee(self) -> None:
        table = [line for line in self.doc.splitlines() if line.startswith("| ")]
        # header + separator + one row per guarantee: every row carries a non-empty "what
        # would validate it" cell rather than leaving the guarantee unexplained.
        for line in table[2:]:
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            if len(cells) == 4:
                self.assertTrue(cells[3], f"row {cells[0]!r} does not say what would validate it")

    def test_the_discovery_document_points_at_the_decision(self) -> None:
        self.assertIn(
            "update-handoff.md",
            DISCOVERY_DOC.read_text(encoding="utf-8"),
            "the handoff decision must be reachable from the update document",
        )


class HandoffCodeFactsTest(unittest.TestCase):
    """The facts the record asserts about the code, read from the producers."""

    def test_no_capability_grants_an_updater_command(self) -> None:
        for document in capability_documents():
            for permission in document.get("permissions", []):
                self.assertFalse(
                    str(permission).startswith("updater:"),
                    f"a capability re-granted {permission!r}; the in-app install path is not supported",
                )

    def test_request_download_stays_unimplemented(self) -> None:
        source = (UPDATER / "requestDownload.ts").read_text(encoding="utf-8")
        self.assertIn('"not-implemented"', source)
        self.assertNotIn("invoke(", source, "an approval must not reach a native download command")

    def test_nothing_relaunches_the_application(self) -> None:
        for path in source_files():
            text = path.read_text(encoding="utf-8")
            self.assertNotIn(
                "@tauri-apps/plugin-process",
                text,
                f"{path.relative_to(REPO)} imports the process plugin; the app must never relaunch itself",
            )

    def test_the_handoff_copy_names_the_package_tools_and_the_limit(self) -> None:
        source = (UPDATER / "packageGuidance.ts").read_text(encoding="utf-8")
        for tool in ("apt", "dnf", "pacman"):
            self.assertIn(tool, source, f"the handoff must name {tool} for that distro")
        self.assertIn(
            "never relaunches",
            source,
            "the handoff copy must say the app does not relaunch itself",
        )
        self.assertIn(
            "does not run the",
            source,
            "the handoff copy must say the app does not run the transaction",
        )


if __name__ == "__main__":
    unittest.main()
