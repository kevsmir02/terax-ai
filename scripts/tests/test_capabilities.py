"""The shipped window capabilities must not grant a capability the application does not use.

Run with: `python3 -m unittest discover -s scripts/tests`

Update discovery is the only update behaviour this build has: `src/modules/updater/checkForUpdate.ts`
reads the release manifest with `fetch`, and `src/modules/updater/requestDownload.ts` returns
`not-implemented` because the gated download/privilege/install handoff is ticket #39. The Tauri
updater plugin's blanket permission set (`updater:default`) expands to `allow-check`,
`allow-download`, `allow-install` and `allow-download-and-install`, so granting it would let the
webview install a package that no gated path produced.

These guards read the capability files the app ships and the updater plugin's own permission
sets, so a later capability edit cannot silently re-grant the install path: it fails here first.
Ticket #39 owns the change, and it has to update this test together with the capability.
"""

from __future__ import annotations

import json
import os
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
CAPABILITIES = REPO / "src-tauri/capabilities"
CARGO_LOCK = REPO / "src-tauri/Cargo.lock"
UPDATE_DOC = REPO / "docs/architecture/update-discovery.md"

# Every updater command the plugin exposes to a webview. Discovery is a plain `fetch` in the
# frontend, so this build needs none of them.
UPDATER_COMMANDS = ("check", "download", "install", "download_and_install")
UPDATER_PERMISSION = re.compile(r"^updater:")


def capability_files() -> list[Path]:
    return sorted(CAPABILITIES.glob("*.json"))


def granted_permissions() -> list[tuple[str, str]]:
    """Every `(capability file, permission identifier)` a window is granted."""
    grants: list[tuple[str, str]] = []
    for path in capability_files():
        document = json.loads(path.read_text(encoding="utf-8"))
        for permission in document.get("permissions", []):
            if isinstance(permission, str):
                grants.append((path.name, permission))
            elif isinstance(permission, dict) and "identifier" in permission:
                grants.append((path.name, str(permission["identifier"])))
    return grants


def locked_updater_version() -> str:
    """The updater plugin version `Cargo.lock` pins, so the right crate is parsed."""
    match = re.search(
        r'\[\[package\]\]\nname = "tauri-plugin-updater"\nversion = "([^"]+)"',
        CARGO_LOCK.read_text(encoding="utf-8"),
    )
    if not match:
        raise AssertionError(f"{CARGO_LOCK} no longer pins tauri-plugin-updater")
    return match.group(1)


def updater_default_permissions() -> set[str] | None:
    """The updater plugin's own `default` permission set, or None without the crate source.

    The crate lives in the cargo registry (it is not vendored in this repository), so a guard
    job that never builds Rust may not have it. The contract these tests pin is the capability
    file, which is repository state and always checked; this set is what proves *why* the
    blanket grant is refused.
    """
    version = locked_updater_version()
    cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
    for source in cargo_home.glob("registry/src/*/tauri-plugin-updater-*"):
        if source.name != f"tauri-plugin-updater-{version}":
            continue
        default = source / "permissions" / "default.toml"
        if not default.is_file():
            continue
        text = default.read_text(encoding="utf-8")
        block = re.search(r"^permissions = \[(.*?)\]", text, re.MULTILINE | re.DOTALL)
        if not block:
            raise AssertionError(f"{default} has no `permissions = [...]` set")
        return {name.strip().strip('"') for name in block.group(1).split(",") if name.strip()}
    return None


class UpdateCapabilityTest(unittest.TestCase):
    def test_no_window_is_granted_an_updater_command(self) -> None:
        # `updater:default` is the blanket set that includes install; `updater:allow-install`
        # and friends grant it directly. Discovery needs neither.
        granted = [
            f"{capability}: {permission}"
            for capability, permission in granted_permissions()
            if UPDATER_PERMISSION.match(permission)
        ]
        self.assertEqual(
            granted,
            [],
            "this build discovers updates with `fetch` and has no gated download/install path "
            "(ticket #39), so no window may call an updater command: " + ", ".join(granted),
        )

    def test_the_blanket_updater_set_is_the_install_grant_this_build_refuses(self) -> None:
        permissions = updater_default_permissions()
        if permissions is None:
            self.skipTest(
                "the updater plugin source is not in this machine's cargo registry "
                f"(tauri-plugin-updater {locked_updater_version()}); the capability contract "
                "above is still enforced"
            )
        # The hazard is real, not hypothetical: the blanket set grants download and install.
        self.assertIn("allow-download", permissions)
        self.assertIn("allow-install", permissions)
        # And no capability may name any set member wholesale or one command at a time.
        blanket = {f"updater:{name}" for name in permissions}
        for capability, permission in granted_permissions():
            self.assertNotIn(
                permission,
                blanket,
                f"{capability} grants {permission!r}, which reaches an updater command "
                "with no gated install path",
            )
            if UPDATER_PERMISSION.match(permission):
                # `updater:default` is not one command: it is the set above.
                command = permission.split(":", 1)[1].removeprefix("allow-").replace("-", "_")
                self.assertIn(
                    command,
                    UPDATER_COMMANDS,
                    f"{capability} grants {permission!r}, which is not a single updater command: "
                    "a `:default` set reaches download and install",
                )

    def test_the_update_doc_says_what_the_webview_may_not_do(self) -> None:
        # The capability is a security boundary, so the document that describes discovery has
        # to name it: a reader must learn that install is unreachable, not only unimplemented.
        doc = UPDATE_DOC.read_text(encoding="utf-8")
        self.assertIn(
            "src-tauri/capabilities/desktop.json",
            doc,
            "docs/architecture/update-discovery.md must name the capability file that would "
            "grant the install path",
        )
        self.assertIn("scripts/tests/test_capabilities.py", doc)
        self.assertIn("updater:", doc)


class CapabilityShapeTest(unittest.TestCase):
    def test_every_capability_file_is_json_with_an_identifier(self) -> None:
        self.assertTrue(capability_files(), "the app ships at least one capability file")
        for path in capability_files():
            document = json.loads(path.read_text(encoding="utf-8"))
            self.assertTrue(document.get("identifier"), f"{path.name} has no identifier")
            self.assertIsInstance(document.get("permissions"), list, f"{path.name}")

    def test_the_desktop_capability_still_covers_the_windows_that_need_it(self) -> None:
        # The updater grant is removed, not the rest of the desktop capability: autostart,
        # window-state and process remain what the settings window and quit flow use.
        document = json.loads((CAPABILITIES / "desktop.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(document["windows"]), ["main", "settings"])
        for retained in ("autostart:default", "window-state:default", "process:default"):
            self.assertIn(retained, document["permissions"])


if __name__ == "__main__":
    unittest.main()
