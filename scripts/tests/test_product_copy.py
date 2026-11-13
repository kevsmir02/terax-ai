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

The install section makes a second promise a reader acts on: the packaged install/upgrade path
is not validated yet. `DistroValidationReferenceTest` reads the owning ticket from
`docs/architecture/linux-packages.md` and requires the README and all 11 translations to cite
that issue, so the promise cannot quietly point at unrelated work.
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
LINUX_PACKAGES = REPO / "docs/architecture/linux-packages.md"

# A line that makes the packaged-path validation promise, and an issue reference on it.
VALIDATION_WORD = re.compile(r"validat", re.IGNORECASE)
ISSUE_REF = re.compile(r"#(\d+)")

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
    "no built-in",
    "there is no",
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


def offending_lines(body: str, name: str = ROADMAP.name) -> list[str]:
    found: list[str] = []
    for number, line in enumerate(body.splitlines(), start=1):
        if not any(pattern.search(line) for pattern in REMOVED_AI_CLAIMS):
            continue
        if any(qualifier in line.lower() for qualifier in ROADMAP_QUALIFIERS):
            continue
        found.append(f"{name}:{number}: {line.strip()}")
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


class TranslatedReadmeCopyTest(unittest.TestCase):
    """The 11 translated READMEs are upstream snapshots, not this build's copy.

    They describe the AI-native product that ticket #12/#14 removed, and a
    translation cannot be kept in step with every wording change here. The
    honest form is a banner on each file that names the authoritative copy, so a
    reader cannot mistake an upstream AI screenshot or a "Settings -> AI" step
    for something this build ships. The marker is ASCII and language-neutral so
    this test can find it in every translation.
    """

    MARKER = "<!-- fork-copy: upstream translation"

    def translations(self) -> list[Path]:
        return sorted((REPO / "docs/readme").glob("README.*.md"))

    def test_every_translation_is_marked_as_an_upstream_snapshot(self) -> None:
        files = self.translations()
        self.assertEqual(len(files), 11, f"expected the 11 translations, found {len(files)}")
        for path in files:
            body = path.read_text()
            self.assertTrue(
                body.startswith(self.MARKER),
                f"{path} does not start with the upstream-translation marker",
            )
            self.assertIn(
                "../../README.md",
                body.split("\n\n")[0] + body.split("\n\n")[1],
                f"{path} must point the reader at the authoritative README",
            )

    def test_the_authoritative_readme_advertises_no_removed_ai_feature(self) -> None:
        # The banner's promise is only honest while the copy it points at is
        # clean; this is the reason a reader is told to prefer it.
        self.assertEqual(
            offending_lines((REPO / "README.md").read_text(), "README.md"),
            [],
            "README.md advertises a surface this fork removed, or must mark the line "
            "as upstream/removed",
        )

    def test_the_authoritative_readme_names_what_the_editor_and_terminal_are(self) -> None:
        # Two surfaces this fork replaced or deleted: the terminal model moved to
        # libghostty (no xterm.js dependency) and language servers were removed
        # with ticket #11 (editing keeps highlighting, find and vim mode). The
        # upstream note may still say xterm was replaced, so the patterns name an
        # advertised feature rather than a bare product name.
        body = (REPO / "README.md").read_text().lower()
        self.assertNotIn(
            "xterm.js with",
            body,
            "README.md still advertises xterm.js as the renderer; the terminal runs libghostty",
        )
        self.assertNotIn(
            "language server support",
            body,
            "README.md still advertises language servers; ticket #11 removed them",
        )
        self.assertIn("libghostty", body)
        self.assertIn("linux x86-64 only", body)


class DistroValidationReferenceTest(unittest.TestCase):
    """The packaged install/upgrade promise must point at the ticket that owns it.

    `docs/architecture/linux-packages.md` names the ticket that accepts the candidate on the
    three distributions; the READMEs repeat that promise. A reference to a different issue is
    a reader following the wrong work, so the number is read from the architecture document
    instead of being restated here.
    """

    def readmes(self) -> list[Path]:
        return [REPO / "README.md"] + sorted(
            (REPO / "docs/readme").glob("README.*.md")
        )

    def expected_issue(self) -> str:
        match = re.search(
            r"acceptance\s+\(#(\d+)\)", LINUX_PACKAGES.read_text(encoding="utf-8")
        )
        if not match:
            raise AssertionError(
                f"{LINUX_PACKAGES} no longer names the distribution-validation ticket"
            )
        return match.group(1)

    def validation_issue_refs(self, body: str) -> list[str]:
        refs: list[str] = []
        for line in body.splitlines():
            if VALIDATION_WORD.search(line):
                refs.extend(ISSUE_REF.findall(line))
        return refs

    def test_every_readme_points_the_packaged_path_at_the_validation_ticket(self) -> None:
        expected = self.expected_issue()
        for path in self.readmes():
            refs = self.validation_issue_refs(path.read_text(encoding="utf-8"))
            self.assertTrue(
                refs,
                f"{path.name} no longer states which ticket validates the packaged "
                "install/upgrade path",
            )
            self.assertEqual(
                sorted(set(refs)),
                [expected],
                f"{path.name} points the packaged-path validation promise at the wrong "
                f"issue; it belongs to #{expected}",
            )


SECURITY = REPO / "SECURITY.md"
ISSUE_TEMPLATES = REPO / ".github/ISSUE_TEMPLATE"
FORK_REPO = "kevsmir02/terax-ai"

# Hosts and counters that belong to the upstream project or its community. Naming upstream as the
# upstream project is honest; sending a reader there for this fork's releases, security reports or
# support is not. Matched against prose and YAML.
UPSTREAM_ROUTES = (
    re.compile(r"security@terax\.app", re.IGNORECASE),
    re.compile(r"https?://terax\.app", re.IGNORECASE),
    re.compile(r"discord\.gg", re.IGNORECASE),
    re.compile(r"youtube\.com/@crynta", re.IGNORECASE),
    re.compile(r"shields\.io/github/(v/release|downloads)/crynta/", re.IGNORECASE),
    re.compile(r"crynta/terax-ai/releases", re.IGNORECASE),
)


def upstream_route_lines(body: str, name: str) -> list[str]:
    found: list[str] = []
    for number, line in enumerate(body.splitlines(), start=1):
        if any(pattern.search(line) for pattern in UPSTREAM_ROUTES):
            found.append(f"{name}:{number}: {line.strip()}")
    return found


class SecurityPolicyCopyTest(unittest.TestCase):
    """`SECURITY.md` must describe this fork's own disclosure route and its real trust state.

    Upstream's address accepted reports for a product this fork does not ship, and the inherited
    claim "Signed releases. Updates are verified before they're applied." was false here: no signing
    key is provisioned and the tagged-release gate refuses publication until one is. A security
    policy that overstates either sends reporters to the wrong maintainer or promises a check that
    does not run.
    """

    def test_the_policy_says_this_is_an_unofficial_candidate_build(self) -> None:
        # Prose wraps: compare collapsed whitespace, or a reflow breaks the assertion.
        body = " ".join(SECURITY.read_text(encoding="utf-8").lower().split())
        self.assertIn("unofficial", body)
        self.assertIn("not affiliated", body)
        self.assertIn("candidate build", body)

    def test_the_policy_routes_reports_to_this_repository(self) -> None:
        body = SECURITY.read_text(encoding="utf-8")
        self.assertIn(f"github.com/{FORK_REPO}/security/advisories/new", body)
        self.assertIn("Report a vulnerability", body)

    def test_the_policy_does_not_route_reports_upstream(self) -> None:
        body = SECURITY.read_text(encoding="utf-8")
        self.assertEqual(
            upstream_route_lines(body, "SECURITY.md"),
            [],
            "SECURITY.md sends a reporter to an upstream route this fork does not own",
        )

    def test_the_policy_does_not_claim_signing_that_is_not_provisioned(self) -> None:
        body = SECURITY.read_text(encoding="utf-8")
        self.assertNotRegex(
            body,
            re.compile(r"signed releases?[^.]{0,40}verified", re.IGNORECASE),
            "SECURITY.md claims releases are signed and verified; no key is provisioned",
        )
        self.assertIn("no key is provisioned", body.lower())

    def test_the_policy_states_the_no_install_boundary(self) -> None:
        body = SECURITY.read_text(encoding="utf-8").lower()
        self.assertIn("never downloads, installs or restarts itself", body)
        self.assertIn("handoff", body)


class IssueTemplateCopyTest(unittest.TestCase):
    """The templates ask for what this fork builds and routes security upstream-free."""

    def templates(self) -> dict[str, str]:
        return {
            path.name: path.read_text(encoding="utf-8")
            for path in sorted(ISSUE_TEMPLATES.glob("*.yml"))
        }

    def test_the_bug_form_asks_for_a_fork_package_and_platform(self) -> None:
        body = self.templates()["bug_report.yml"].lower()
        self.assertIn("rpm", body)
        self.assertIn("deb", body)
        self.assertIn("webkitgtk", body)
        self.assertIn("distribution and desktop", body)

    def test_no_template_lists_an_unsupported_platform_as_an_option(self) -> None:
        for name, body in self.templates().items():
            for foreign in ("macos", "windows", "appimage"):
                self.assertNotIn(
                    foreign,
                    body.lower(),
                    f"{name} still asks about {foreign}, which this fork does not build",
                )

    def test_no_template_routes_to_an_upstream_surface(self) -> None:
        for name, body in self.templates().items():
            self.assertEqual(
                upstream_route_lines(body, name),
                [],
                f"{name} still points a reporter at an upstream surface",
            )


class ReadmeBadgeCopyTest(unittest.TestCase):
    """The README's release/download counters must not read as this fork's numbers."""

    def test_the_readme_carries_no_upstream_release_counter(self) -> None:
        body = (REPO / "README.md").read_text(encoding="utf-8")
        self.assertEqual(
            upstream_route_lines(body, "README.md"),
            [],
            "README.md still shows an upstream counter or sends the reader to upstream's "
            "releases, downloads, community or website",
        )

    def test_the_readme_keeps_the_platform_badge_and_says_nothing_is_published(self) -> None:
        body = (REPO / "README.md").read_text(encoding="utf-8")
        self.assertIn("platform-Linux%20x86_64", body)
        self.assertIn("none%20published%20yet", body)

    def test_the_install_section_names_this_repository_and_no_release_yet(self) -> None:
        body = (REPO / "README.md").read_text(encoding="utf-8")
        self.assertIn(f"github.com/{FORK_REPO}/releases", body)
        self.assertIn("No release is published yet", body)


if __name__ == "__main__":
    unittest.main()
