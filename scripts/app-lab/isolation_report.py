"""The isolation block every real-app Linux report must carry — built once, validated always.

`scripts/linux_profile.py` refuses an unsafe launch. A report is evidence about that launch, so it
must record the profile the preflight actually accepted (private HOME/XDG, disposable identifier)
and, after the run, that the synthetic installed upstream application was left byte-identical.
Both the resource/stress/workflow runner and the startup runner use `block()` and `finish()`; the
same fields are then checked by `problems()` before a report is written. A report without a valid
block is not written at all, and `scripts/tests/test_isolation_report.py` rejects one.

The block is not defaulted: `block()` re-runs the same `linux_profile.problems()` refusal on the
exact environment it records, so a report can only exist for a launch the preflight accepted.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent.parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import linux_profile  # noqa: E402
import namespace_sentinels  # noqa: E402

REQUIRED_KEYS = (
    "identifier", "home", "profile", "session", "benchIsolated", "profileVerified",
    "preflightProblems", "upstreamSentinels", "upstreamStateUnchanged", "fork",
    "controlDescriptorPublished", "forkRuntimeDirIsNotUpstream",
    "forkDataDirIsIdentifierKeyed", "forkDataDirIsNotUpstream",
)


def block(identifier: str, env: dict[str, str], home: Path, sentinels: dict, root: Path) -> dict:
    """Record the preflight-accepted profile of a launch (raises if the env is unsafe)."""
    found = linux_profile.problems(identifier, env, Path(root), require_isolated=True)
    if found:
        raise ValueError("refusing to report an unsafe run: " + "; ".join(found))
    profile = {name: env.get(name) for name in linux_profile.PROFILE_ENV}
    return {
        "identifier": identifier,
        "home": str(home),
        # Read back from the environment the process was launched with, not recomputed.
        "profile": profile,
        "session": linux_profile.session_env(env),
        "benchIsolated": env.get("TERAX_BENCH_ISOLATED"),
        "profileVerified": True,
        "preflightProblems": [],
        "launchEnvKeys": sorted(key for key in env if key.startswith(("HOME", "XDG_", "TERAX_BENCH_"))),
        "upstreamSentinels": {
            "upstreamIdentifier": sentinels["upstreamIdentifier"],
            "files": len(sentinels["files"]),
            "trees": sorted(sentinels["trees"]),
        },
    }


def finish(isolation: dict, home: Path, sentinels: dict) -> list[str]:
    """Add the post-run coexistence evidence; returns the upstream changes (empty is a pass)."""
    home = Path(home)
    unchanged = namespace_sentinels.verify(home, sentinels)
    fork = namespace_sentinels.fork_state(home)
    upstream_cache = home / ".cache" / linux_profile.UPSTREAM_NAMESPACE
    descriptor = Path(fork["controlDescriptor"])
    if descriptor.is_file():
        published = json.loads(descriptor.read_text())
        fork["descriptorPid"] = published.get("pid")
        fork["descriptorIsInsideProfile"] = descriptor.is_relative_to(home)
    isolation["upstreamStateUnchanged"] = not unchanged
    isolation["upstreamStateChanges"] = unchanged
    isolation["upstreamCacheDirUntouched"] = (upstream_cache / "control.json").is_file()
    isolation["fork"] = fork
    isolation["forkRuntimeDirIsNotUpstream"] = descriptor.parent != upstream_cache
    own_data = [
        entry for entry in fork["dataDirEntries"] if entry != linux_profile.UPSTREAM_IDENTIFIER
    ]
    isolation["forkAppDataDirs"] = own_data
    isolation["forkDataDirIsIdentifierKeyed"] = bool(own_data) and all(
        entry.startswith(f"{linux_profile.PRODUCT_IDENTIFIER}.") for entry in own_data
    )
    isolation["forkDataDirIsNotUpstream"] = all(
        not entry.startswith(linux_profile.UPSTREAM_IDENTIFIER) for entry in own_data
    )
    isolation["controlDescriptorPublished"] = fork["controlDescriptorExists"]
    # A single legible verdict, derived from the evidence above. A false value is recorded — it is
    # a finding about the measured revision (the fixed point predates namespace isolation), not a
    # reason to suppress the report.
    isolation["namespaceIsolation"] = (
        "clean"
        if not unchanged
        and isolation["forkDataDirIsIdentifierKeyed"]
        and isolation["forkDataDirIsNotUpstream"]
        else "violated"
    )
    return unchanged


def problems(report: dict, root: Path | None = None) -> list[str]:
    """Every reason this report's isolation evidence is missing or self-contradictory."""
    isolation = report.get("isolation")
    if not isinstance(isolation, dict) or not isolation:
        return ["isolation block is missing"]

    found: list[str] = []
    missing = [key for key in REQUIRED_KEYS if key not in isolation]
    if missing:
        found.append("isolation block is missing fields: " + ", ".join(missing))

    identifier = isolation.get("identifier")
    if not isinstance(identifier, str) or not identifier:
        found.append("isolation.identifier is missing")
    else:
        if identifier == linux_profile.PRODUCT_IDENTIFIER:
            found.append("isolation.identifier is the product identifier")
        if identifier == linux_profile.UPSTREAM_IDENTIFIER or identifier.startswith(
            f"{linux_profile.UPSTREAM_IDENTIFIER}."
        ):
            found.append("isolation.identifier belongs to upstream Terax")
        if not identifier.startswith(f"{linux_profile.PRODUCT_IDENTIFIER}."):
            found.append("isolation.identifier is outside the fork's identifier namespace")

    profile = isolation.get("profile")
    if not isinstance(profile, dict):
        found.append("isolation.profile is missing")
    else:
        root_path = Path(root).resolve() if root is not None else None
        for name in linux_profile.PROFILE_ENV:
            value = profile.get(name)
            if not value:
                found.append(f"isolation.profile.{name} is missing")
                continue
            path = Path(value)
            if not path.is_absolute():
                found.append(f"isolation.profile.{name} is not absolute")
                continue
            if root_path is not None and not path.resolve().is_relative_to(root_path):
                found.append(f"isolation.profile.{name} is not under the run output")
        cache = profile.get("XDG_CACHE_HOME")
        if cache and Path(cache).resolve() == linux_profile.real_cache_dir().resolve():
            found.append("isolation.profile.XDG_CACHE_HOME is the installed app's cache dir")

    if isolation.get("benchIsolated") != "1":
        found.append("isolation.benchIsolated is not '1'")
    if isolation.get("profileVerified") is not True:
        found.append("isolation.profileVerified is not true")
    if isolation.get("preflightProblems") not in ([], None):
        found.append("isolation.preflightProblems is not empty")

    sentinels = isolation.get("upstreamSentinels")
    if not isinstance(sentinels, dict) or not sentinels.get("files"):
        found.append("isolation.upstreamSentinels has no seeded files")
    else:
        if not sentinels.get("upstreamIdentifier"):
            found.append("isolation.upstreamSentinels.upstreamIdentifier is missing")
        if not sentinels.get("trees"):
            found.append("isolation.upstreamSentinels.trees is empty")

    unchanged = isolation.get("upstreamStateUnchanged")
    if not isinstance(unchanged, bool):
        found.append("isolation.upstreamStateUnchanged is not a boolean")
    changes = isolation.get("upstreamStateChanges")
    if not isinstance(changes, list):
        found.append("isolation.upstreamStateChanges is not a list")
    elif unchanged is False and not changes:
        found.append("isolation.upstreamStateChanges is empty although the upstream state changed")
    isolation_state = isolation.get("namespaceIsolation")
    if isolation_state not in ("clean", "violated"):
        found.append("isolation.namespaceIsolation is not 'clean' or 'violated'")
    for key in ("forkRuntimeDirIsNotUpstream", "forkDataDirIsIdentifierKeyed", "forkDataDirIsNotUpstream"):
        if not isinstance(isolation.get(key), bool):
            found.append(f"isolation.{key} is not a boolean")
    if not isinstance(isolation.get("forkAppDataDirs"), list):
        found.append("isolation.forkAppDataDirs is not a list")
    if not isinstance(isolation.get("controlDescriptorPublished"), bool):
        found.append("isolation.controlDescriptorPublished is not a boolean")

    fork = isolation.get("fork")
    if not isinstance(fork, dict) or not fork.get("controlDescriptor"):
        found.append("isolation.fork.controlDescriptor is missing")
    return found
