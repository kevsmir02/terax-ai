"""Upstream-state sentinels for the fork's coexistence runs.

An ordinary run of this fork must coexist with an installed upstream Terax: it may not read,
import, overwrite or delete the other application's settings, data, control descriptor, shell
integration or agent-hook groups. Asserting that from the outside is only possible if the other
installation's state actually exists while this one runs.

`seed()` writes a synthetic "upstream installation" into a disposable profile: every file the
upstream application would own, with content that names the upstream identity. `verify()`
re-hashes them after the run and reports every file that changed, disappeared or was created
inside an upstream-owned directory. The real-app runner (`scripts/app-lab/run.py`) seeds before
launch and verifies after it exits, so a single namespace collision fails the run.

Names come from the shared identity table (`src/modules/identity/namespace.json`), never from a
literal here: the upstream names are the ones the fork must refuse.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import linux_profile

UPSTREAM_ID = linux_profile.UPSTREAM_IDENTIFIER
UPSTREAM_NS = linux_profile.UPSTREAM_NAMESPACE
FORK_ID = linux_profile.PRODUCT_IDENTIFIER
FORK_NS = linux_profile.NAMESPACE

# Upstream hook commands, exactly as the other installation writes them into shared agent
# configuration. This fork must treat them as foreign and never rewrite or remove them.
_UPSTREAM_CLI = f"{linux_profile.UPSTREAM_ENV_PREFIX}_CLI"
_UPSTREAM_HOOK = (
    f'[ -n "${_UPSTREAM_CLI}" ] && "${_UPSTREAM_CLI}" hook claude Stop || printf \'{{}}\''
)
_UPSTREAM_PI = "// terax-pi-notifications-v2\nexport default function () {}\n"


def _upstream_files(home: Path) -> dict[Path, str]:
    """Every path the upstream installation owns, with its sentinel content."""
    config = home / ".config" / UPSTREAM_ID
    data = home / ".local" / "share" / UPSTREAM_ID
    state = home / ".local" / "state" / UPSTREAM_ID
    cache = home / ".cache" / UPSTREAM_NS
    return {
        # Tauri app config / data / state of the other installation (identifier keyed).
        config / "settings.json": json.dumps(
            {"theme": "upstream-theme", "identity": UPSTREAM_ID}, indent=2
        )
        + "\n",
        config / "window-state.json": '{"main":{"width":1200,"height":800}}\n',
        data / "secrets.json": '{"provider":"upstream-only"}\n',
        data / "ai-sessions" / "index.json": '{"sessions":["upstream-session"]}\n',
        data / "logs" / "main.log": "upstream log line\n",
        state / "state.json": '{"lastRun":"upstream"}\n',
        # Control descriptor + per-pid CLI launcher (product-name keyed, not identifier keyed).
        cache / "control.json": json.dumps(
            {
                "protocol": 1,
                "address": "127.0.0.1:9",
                "token": "up" * 32,
                "pid": 4242,
                "app_version": "9.9.9",
            }
        )
        + "\n",
        cache / "run" / "4242" / "bin" / "terax": "#!/bin/sh\necho upstream cli\n",
        # Shell integration of the other installation.
        cache / "shell-integration" / "zsh" / ".zshenv": "# upstream zshenv\n",
        cache / "shell-integration" / "zsh" / ".zshrc": "# upstream zshrc\n",
        cache / "shell-integration" / "bash" / "bashrc": "# upstream bashrc\n",
        cache / "shell-integration" / "fish" / "init.fish": "# upstream fish init\n",
        home / ".config" / "fish" / "conf.d" / f"{UPSTREAM_NS}.fish": "# upstream fish conf.d\n",
        # Hook groups the other installation owns inside shared agent configuration.
        home / ".claude" / "settings.json": json.dumps(
            {
                "model": "opus",
                "hooks": {
                    "Stop": [
                        {"hooks": [{"type": "command", "command": _UPSTREAM_HOOK}]},
                        {"hooks": [{"type": "command", "command": "notify-send done"}]},
                    ]
                },
            },
            indent=2,
        )
        + "\n",
        home / ".codex" / "hooks.json": json.dumps(
            {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": _UPSTREAM_HOOK}]}]}},
            indent=2,
        )
        + "\n",
        home / ".gemini" / "settings.json": json.dumps(
            {
                "hooks": {
                    "AfterAgent": [
                        {
                            "matcher": "*",
                            "hooks": [
                                {"type": "command", "name": UPSTREAM_NS, "command": _UPSTREAM_HOOK}
                            ],
                        }
                    ]
                }
            },
            indent=2,
        )
        + "\n",
        home / ".pi" / "agent" / "extensions" / "terax-notifications.ts": _UPSTREAM_PI,
    }


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _tree_digest(directory: Path) -> dict[str, str]:
    if not directory.exists():
        return {}
    return {
        str(path.relative_to(directory)): _digest(path)
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    }


def _upstream_dirs(home: Path) -> list[Path]:
    """Upstream-owned directories that must gain no file at all during a fork run."""
    return [
        home / ".config" / UPSTREAM_ID,
        home / ".local" / "share" / UPSTREAM_ID,
        home / ".local" / "state" / UPSTREAM_ID,
        home / ".cache" / UPSTREAM_NS,
    ]


def seed(home: Path) -> dict:
    """Writes the upstream sentinel tree into `home`; returns the manifest to verify later."""
    home = Path(home)
    files = _upstream_files(home)
    for path, body in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    return {
        "upstreamIdentifier": UPSTREAM_ID,
        "forkIdentifier": FORK_ID,
        "files": {str(path.relative_to(home)): _digest(path) for path in files},
        "trees": {
            str(directory.relative_to(home)): _tree_digest(directory)
            for directory in _upstream_dirs(home)
        },
    }


def verify(home: Path, manifest: dict) -> list[str]:
    """Every way the upstream installation's state changed during the run (empty is a pass)."""
    home = Path(home)
    problems: list[str] = []
    for relative, digest in manifest["files"].items():
        path = home / relative
        if not path.exists():
            problems.append(f"{relative} was deleted")
        elif _digest(path) != digest:
            problems.append(f"{relative} was modified")
    for relative, tree in manifest["trees"].items():
        changed = _tree_digest(home / relative)
        for name, digest in tree.items():
            if name not in changed:
                problems.append(f"{relative}/{name} was deleted")
            elif changed[name] != digest:
                problems.append(f"{relative}/{name} was modified")
        for name in changed:
            if name not in tree:
                problems.append(f"{relative}/{name} was created inside an upstream directory")
    return problems


def _entries(directory: Path) -> list[str]:
    if not directory.exists():
        return []
    return sorted(path.name for path in directory.iterdir())


def fork_state(home: Path) -> dict:
    """What the fork's own namespaces look like after a run (evidence, not an assertion)."""
    home = Path(home)
    cache = home / ".cache" / FORK_NS
    data = home / ".local" / "share" / FORK_ID
    return {
        "namespace": FORK_NS,
        "cacheDir": str(cache),
        "controlDescriptor": str(cache / "control.json"),
        "controlDescriptorExists": (cache / "control.json").is_file(),
        "dataDir": str(data),
        "dataDirExists": data.is_dir(),
        "shellIntegration": str(cache / "shell-integration"),
        "shellIntegrationExists": (cache / "shell-integration").is_dir(),
        "isUpstreamCacheDir": cache.name == UPSTREAM_NS,
        "dataDirEntries": _entries(home / ".local" / "share"),
        "configDirEntries": _entries(home / ".config"),
        "cacheDirEntries": _entries(home / ".cache"),
        "stateDir": str(home / linux_profile.home_state_dir_name()),
        "hookEnvPrefix": linux_profile.IDENTITY["envPrefix"],
    }
