"""Package metadata and the roadmap must describe the product this fork actually ships.

Run with: `python3 -m unittest discover -s scripts/tests`

Ticket #14 removed the built-in AI stack end to end: providers, API-key storage, the `keyring`
dependency and the AI transport are gone, and coding agents run as external CLI processes in a
terminal tab. `src/app/ai-native-removal.test.ts` guards the source tree; these are the two places
a *reader* meets the product before running it — the bundle/crate description that lands in the
package metadata and `ROADMAP.md` — so a description that still advertises an "AI-native" agent
system or keys in the OS keychain is a false claim with no code behind it.

`ROADMAP.md` keeps upstream's history, so a line may still *name* a removed feature when it also
says it is upstream's, removed or external. The metadata descriptions cannot: they are shipped
verbatim and describe this build.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
TAURI_CONFIG = REPO / "src-tauri/tauri.conf.json"
CARGO_MANIFEST = REPO / "src-tauri/Cargo.toml"
ROADMAP = REPO / "ROADMAP.md"

# Claims about the built-in AI surface that ticket #12/#14 removed. They are matched against
# prose, so they name the specific feature rather than the word "AI" alone.
REMOVED_AI_CLAIMS = (
    re.compile(r"AI-native", re.IGNORECASE),
    re.compile(r"\bAI agent(s)?\b", re.IGNORECASE),
    re.compile(r"\bAI (autocomplete|edit|coding|assistant|chat)\b", re.IGNORECASE),
    re.compile(r"\bAI tools?\b", re.IGNORECASE),
    re.compile(r"\bAPI[- ]keys?\b", re.IGNORECASE),
    re.compile(r"\bkeychain\b", re.IGNORECASE),
    re.compile(r"\bBYOK\b", re.IGNORECASE),
    re.compile(r"\blocal models?\b", re.IGNORECASE),
)

# A roadmap line may keep a removed feature in the record when it says so on the same line.
ROADMAP_QUALIFIERS = (
    "upstream",
    "removed",
    "no longer",
    "external",
    "not this fork",
)

# The retained product: a terminal workspace with an editor, source control and previews.
RETAINED_SURFACE = ("editor", "git", "source control", "preview", "workspace")


def cargo_description() -> str:
    match = re.search(
        r'^description\s*=\s*"([^"]*)"', CARGO_MANIFEST.read_text(), re.MULTILINE
    )
    if not match:
        raise AssertionError(f"{CARGO_MANIFEST} has no package description")
    return match.group(1)


def shipped_descriptions() -> dict[str, str]:
    """The three strings a package index or `tauri build` ships as the product summary."""
    bundle = json.loads(TAURI_CONFIG.read_text())["bundle"]
    return {
        "src-tauri/tauri.conf.json shortDescription": bundle["shortDescription"],
        "src-tauri/tauri.conf.json longDescription": bundle["longDescription"],
        "src-tauri/Cargo.toml description": cargo_description(),
    }


def offending_lines(body: str) -> list[str]:
    found: list[str] = []
    for number, line in enumerate(body.splitlines(), start=1):
        if not any(pattern.search(line) for pattern in REMOVED_AI_CLAIMS):
            continue
        if any(qualifier in line.lower() for qualifier in ROADMAP_QUALIFIERS):
            continue
        found.append(f"{ROADMAP.name}:{number}: {line.strip()}")
    return found


class PackageMetadataCopyTest(unittest.TestCase):
    def test_the_shipped_descriptions_advertise_no_removed_ai_feature(self) -> None:
        for where, value in shipped_descriptions().items():
            for pattern in REMOVED_AI_CLAIMS:
                self.assertNotRegex(
                    value,
                    pattern,
                    f"{where} still advertises a surface ticket #12/#14 removed: {value!r}",
                )

    def test_the_shipped_descriptions_name_the_retained_product(self) -> None:
        for where, value in shipped_descriptions().items():
            lowered = value.lower()
            self.assertIn("terminal", lowered, f"{where} must name the terminal product")
            self.assertTrue(
                any(surface in lowered for surface in RETAINED_SURFACE),
                f"{where} must name the retained workspace surface (editor, source control, "
                f"preview): {value!r}",
            )

    def test_the_descriptions_do_not_claim_a_network_or_account(self) -> None:
        # The retained build has no account, no telemetry and no provider endpoint.
        for where, value in shipped_descriptions().items():
            self.assertNotRegex(value, r"\b(sign in|account|cloud)\b", where)


class RoadmapCopyTest(unittest.TestCase):
    def test_the_roadmap_advertises_no_removed_ai_feature_as_current(self) -> None:
        body = ROADMAP.read_text()
        self.assertEqual(
            offending_lines(body),
            [],
            "ROADMAP.md advertises a feature this fork removed; describe the retained product, "
            "or mark the line as upstream/removed",
        )

    def test_the_roadmap_describes_the_external_agent_surface(self) -> None:
        body = ROADMAP.read_text().lower()
        self.assertIn(
            "external coding agent",
            body,
            "the roadmap must describe how agents actually run here: external CLI processes",
        )
        self.assertIn("no built-in", body, "the roadmap must not imply an embedded AI surface")

    def test_the_roadmap_keeps_the_linux_only_commitment(self) -> None:
        body = ROADMAP.read_text()
        self.assertIn("Linux x86-64 only", body)
        self.assertIn("package tool", body)


if __name__ == "__main__":
    unittest.main()
