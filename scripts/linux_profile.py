"""Disposable Linux profile and preflight checks for the real-app runners.

`scripts/pty-smoke` and `scripts/app-lab` both launch the real Tauri application. On Linux the
application resolves its identity, storage and the control descriptor from the environment. The
control descriptor is keyed by the fork's namespace directory, not by the application
identifier (`$XDG_CACHE_HOME/terax-workspace/control.json`, plus a per-pid launcher under
`.../run/<pid>/bin/terax`), so a run that inherits the real cache directory would write the
*installed* application's live descriptor. The only safe shape is therefore a private `HOME`
**and** a private `XDG_*` tree under the run's output directory, while the display and session
bus keep coming from the live session.

Every name comes from the shared identity table (`src/modules/identity/namespace.json`, read by
the Rust application too); a runner may never hardcode a product identifier or a namespace.

`preflight()` is the refusal: it runs before a build/launch and returns every reason the run
would not be disposable — including an identifier that is this fork's product identifier *or*
one of upstream Terax's, which would share the installed application's profile. `--self-test`
of both runners feeds it deliberately unsafe environments and asserts they are refused.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
from pathlib import Path

_IDENTITY_FILE = Path(__file__).resolve().parent.parent / "src/modules/identity/namespace.json"


def _identity() -> dict:
    return json.loads(_IDENTITY_FILE.read_text(encoding="utf-8"))


IDENTITY = _identity()
# This fork's provisional product identifier (final branding: ticket #39/#40).
PRODUCT_IDENTIFIER = IDENTITY["appIdentifier"]
# The directory token the control descriptor, shell integration and CLI launcher use.
NAMESPACE = IDENTITY["namespace"]
UPSTREAM_IDENTIFIER = IDENTITY["upstream"]["appIdentifier"]
UPSTREAM_NAMESPACE = IDENTITY["upstream"]["namespace"]


def home_state_dir_name() -> str:
    """This fork's private per-user directory (task worktrees and their registry)."""
    return f".{NAMESPACE}"
# Everything the application must resolve inside the run's output directory. XDG_CACHE_HOME is
# the one that matters most: the control descriptor is shared with the installed app otherwise.
PROFILE_ENV = ("HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME")
# Inherited from the live session: the Wayland/X11 display and the session bus live here.
SESSION_ENV = ("XDG_RUNTIME_DIR", "WAYLAND_DISPLAY", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS")


class UnsafeProfile(RuntimeError):
    """The run would touch the installed application's identity, storage or cache."""


def profile_env(home: Path) -> dict[str, str]:
    """The private environment of a disposable profile rooted at `home`."""
    home = Path(home)
    return {
        "HOME": str(home),
        "XDG_DATA_HOME": str(home / ".local/share"),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "XDG_STATE_HOME": str(home / ".local/state"),
    }


def session_env(environ: dict[str, str] | None = None) -> dict[str, str]:
    """The display and bus variables the app needs from the live session (never redirected)."""
    environ = os.environ if environ is None else environ
    return {name: environ[name] for name in SESSION_ENV if name in environ}


def disposable_identifier(lab: str, token: str | None = None) -> str:
    """A per-run identifier inside this fork's namespace, never the product identifier."""
    suffix = token or os.urandom(6).hex()
    return f"{PRODUCT_IDENTIFIER}.{lab}-{suffix}"


def real_cache_dir(environ: dict[str, str] | None = None) -> Path:
    """Where the installed app's control descriptor would live outside a disposable profile."""
    environ = os.environ if environ is None else environ
    return Path(environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")


def problems(
    identifier: str,
    env: dict[str, str],
    root: Path,
    *,
    require_isolated: bool,
) -> list[str]:
    """Every reason this launch is not an isolated, disposable run (empty when it is)."""
    found: list[str] = []
    if identifier == PRODUCT_IDENTIFIER:
        found.append(
            f"identifier is the product identifier {PRODUCT_IDENTIFIER}: a run would share the "
            "installed app's profile"
        )
    elif identifier == UPSTREAM_IDENTIFIER or identifier.startswith(
        f"{UPSTREAM_IDENTIFIER}."
    ):
        found.append(
            f"identifier {identifier!r} belongs to upstream Terax ({UPSTREAM_IDENTIFIER}): a run "
            "would share the installed upstream application's profile"
        )
    elif not identifier.startswith(f"{PRODUCT_IDENTIFIER}."):
        found.append(
            f"identifier {identifier!r} is outside the {PRODUCT_IDENTIFIER}.* namespace"
        )
    if require_isolated and env.get("TERAX_BENCH_ISOLATED") != "1":
        found.append(
            "TERAX_BENCH_ISOLATED=1 is missing: a bench build only starts inside a declared "
            "isolated environment"
        )
    root = Path(root).resolve()
    cache = Path(env.get("XDG_CACHE_HOME", "")) if env.get("XDG_CACHE_HOME") else None
    for name in PROFILE_ENV:
        value = env.get(name)
        if not value:
            found.append(f"{name} is not set: the profile is not disposable")
            continue
        path = Path(value)
        if not path.is_absolute():
            found.append(f"{name}={value!r} is not absolute")
            continue
        if not path.resolve().is_relative_to(root):
            found.append(f"{name}={value!r} is not under the run output {str(root)!r}")
    if cache is not None and cache.resolve() == real_cache_dir().resolve():
        found.append(
            f"XDG_CACHE_HOME={str(cache)!r} is the installed app's cache dir; its "
            f"{NAMESPACE}/control.json and {NAMESPACE}/run launchers would be overwritten"
        )
    return found


def preflight(
    identifier: str,
    env: dict[str, str],
    root: Path,
    *,
    require_isolated: bool,
) -> None:
    """Raises `UnsafeProfile` with every problem; returns only for a disposable launch."""
    found = problems(identifier, env, root, require_isolated=require_isolated)
    if found:
        raise UnsafeProfile(
            "refusing an unsafe run:\n  " + "\n  ".join(found)
        )


def prepare(home: Path, root: Path) -> None:
    """Creates an empty profile directory after checking it belongs to this run."""
    home = Path(home).resolve()
    root = Path(root).resolve()
    if not home.is_relative_to(root):
        raise UnsafeProfile(f"profile {str(home)!r} is not under the run output {str(root)!r}")
    shutil.rmtree(home, ignore_errors=True)
    home.mkdir(parents=True, exist_ok=True)


def cleanup(home: Path, root: Path) -> None:
    """Removes a profile directory; refuses anything outside the run's output."""
    home = Path(home).resolve()
    root = Path(root).resolve()
    if not home.is_relative_to(root):
        raise UnsafeProfile(f"refusing to remove {str(home)!r}: not under {str(root)!r}")
    shutil.rmtree(home, ignore_errors=True)


# ---------------------------------------------------------------------------------------------
# Host stack: what the run was measured/validated on (recorded in the report, never asserted)
# ---------------------------------------------------------------------------------------------


def _read(path: str) -> str:
    try:
        return Path(path).read_text(errors="replace")
    except OSError:
        return ""


def _command(*command: str) -> str:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def _package_version(*names: str) -> str:
    for name in names:
        version = _command("rpm", "-q", "--qf", "%{VERSION}-%{RELEASE}", name)
        if version and "not installed" not in version:
            return version
        version = _command("dpkg-query", "-W", "-f=${Version}", name)
        if version:
            return version
    return ""


def _pkg_config(module: str) -> str:
    return _command("pkg-config", "--modversion", module)


def _memory_bytes() -> int:
    for line in _read("/proc/meminfo").splitlines():
        if line.startswith("MemTotal:"):
            try:
                return int(line.split()[1]) * 1024
            except (IndexError, ValueError):
                return 0
    return 0


def _cpu_model() -> str:
    for line in _read("/proc/cpuinfo").splitlines():
        if line.startswith("model name"):
            return line.partition(":")[2].strip()
    return platform.processor()


def _os_release() -> str:
    for line in _read("/etc/os-release").splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.partition("=")[2].strip().strip('"')
    return platform.platform()


def host_stack() -> dict:
    """Software/display stack of the host, Linux-shaped (the macOS runner probes sysctl/sw_vers)."""
    return {
        "os": _os_release(),
        "kernel": platform.release(),
        "arch": platform.machine(),
        "session": os.environ.get("XDG_SESSION_TYPE", ""),
        "desktop": os.environ.get("XDG_CURRENT_DESKTOP", ""),
        "display": {
            "waylandDisplay": os.environ.get("WAYLAND_DISPLAY", ""),
            "display": os.environ.get("DISPLAY", ""),
            "gdkScale": os.environ.get("GDK_SCALE", ""),
            "gdkDpiScale": os.environ.get("GDK_DPI_SCALE", ""),
            "textScalingFactor": _command(
                "gsettings", "get", "org.gnome.desktop.interface", "text-scaling-factor"
            ),
            "fonts": {
                "monospace": _command("fc-match", "monospace", "--format=%{family} %{size}"),
                "sans": _command("fc-match", "sans-serif", "--format=%{family} %{size}"),
            },
        },
        "webkit2gtk": _package_version("webkit2gtk4.1", "libwebkit2gtk-4.1-0")
        or _pkg_config("webkit2gtk-4.1"),
        "gtk3": _package_version("gtk3", "libgtk-3-0") or _pkg_config("gtk+-3.0"),
        "cpu": _cpu_model(),
        "logicalCpus": len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count(),
        "memoryBytes": _memory_bytes(),
        "loadAverageStart": [round(value, 2) for value in os.getloadavg()],
    }
