#!/usr/bin/env python3
"""Validate a built Codr Linux RPM candidate on Fedora 45 KDE Wayland (issue #44)."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import linux_profile  # noqa: E402
import namespace_sentinels  # noqa: E402
import packaging  # noqa: E402


def parse_rpm_requires_resolution(pairs: list[tuple[str, str]]) -> dict:
    """Classify RPM requirements resolved via `rpm -q --whatprovides`."""
    satisfied: list[dict[str, str]] = []
    rpmlib: list[str] = []
    missing: list[str] = []
    for requirement, provider_output in pairs:
        req = requirement.strip()
        out = provider_output.strip()
        if not req:
            continue
        if req.startswith("rpmlib("):
            rpmlib.append(req)
        elif out.startswith("no package provides ") or not out:
            missing.append(req)
        else:
            satisfied.append({"requirement": req, "provider": out})
    return {
        "ok": len(missing) == 0,
        "satisfied": satisfied,
        "rpmlib": rpmlib,
        "missing": missing,
    }


def check_package_path_disjointness(
    candidate_paths: list[str],
    upstream_paths: list[str],
) -> dict:
    """Ensure the candidate RPM shares zero filesystem paths with upstream `terax`."""
    cand_set = {line.strip() for line in candidate_paths if line.strip()}
    up_set = {line.strip() for line in upstream_paths if line.strip()}
    overlapping = sorted(cand_set & up_set)
    return {
        "disjoint": len(overlapping) == 0,
        "overlappingPaths": overlapping,
        "candidateCount": len(cand_set),
        "upstreamCount": len(up_set),
    }


def parse_rpm_signature_check(output: str) -> dict:
    """Parse `rpm -K` verification output."""
    text = output.strip()
    lower = text.lower()
    digests_ok = "digests" in lower and "digests not ok" not in lower
    signed = "signatures ok" in lower and "signatures not ok" not in lower
    return {
        "digestsOk": digests_ok,
        "signed": signed,
        "raw": text,
    }


def evaluate_cli_probes(probes: list[dict]) -> dict:
    """Verify packaged `codr-cli` probes exited 0 and returned `ok: true` when JSON."""
    failures: list[dict] = []
    for probe in probes:
        args = probe.get("args", [])
        rc = probe.get("exitCode")
        stdout = (probe.get("stdout") or "").strip()
        stderr = (probe.get("stderr") or "").strip()
        if rc != 0:
            failures.append({"args": args, "exitCode": rc, "stderr": stderr, "stdout": stdout})
            continue
        if "--json" in args:
            try:
                parsed = json.loads(stdout)
            except json.JSONDecodeError as error:
                failures.append({"args": args, "error": f"invalid JSON: {error}", "stdout": stdout})
                continue
            if not isinstance(parsed, dict) or parsed.get("ok") is not True:
                failures.append({"args": args, "parsed": parsed})
    return {
        "ok": len(failures) == 0,
        "count": len(probes),
        "failures": failures,
    }


def _run_capture(command: list[str], **kwargs) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, **kwargs)


def inspect_host_rpm(rpm_path: Path) -> dict:
    requires_out = _run_capture(["rpm", "-qp", "--requires", str(rpm_path)], check=True).stdout
    pairs: list[tuple[str, str]] = []
    for req in requires_out.splitlines():
        req = req.strip()
        if not req:
            continue
        provider = _run_capture(["rpm", "-q", "--whatprovides", req]).stdout
        pairs.append((req, provider))
    resolution = parse_rpm_requires_resolution(pairs)

    sig_proc = _run_capture(["rpm", "-K", str(rpm_path)])
    signature = parse_rpm_signature_check(sig_proc.stdout + sig_proc.stderr)

    cand_files = _run_capture(["rpm", "-qlp", str(rpm_path)], check=True).stdout.splitlines()
    upstream_installed = _run_capture(["rpm", "-q", "terax"]).returncode == 0
    upstream_files = (
        _run_capture(["rpm", "-ql", "terax"], check=True).stdout.splitlines()
        if upstream_installed
        else []
    )
    coexistence = {
        "upstreamTeraxInstalled": upstream_installed,
        **check_package_path_disjointness(cand_files, upstream_files),
    }
    return {
        "dependencies": resolution,
        "signature": signature,
        "coexistence": coexistence,
    }


def run_packaged_graphical_smoke(rpm_path: Path, timeout_s: float = 25.0) -> dict:
    """Launch the extracted `/usr/bin/codr` on Wayland under an isolated profile."""
    with tempfile.TemporaryDirectory(prefix="codr-fedora-smoke-") as tmp_str:
        tmp = Path(tmp_str)
        pkg_root = tmp / "pkgroot"
        packaging.extract_rpm(rpm_path, pkg_root)
        codr_bin = pkg_root / "usr" / "bin" / "codr"
        cli_bin = pkg_root / "usr" / "bin" / "codr-cli"

        workspace = tmp / "workspace"
        workspace.mkdir(parents=True, exist_ok=True)
        sample_file = workspace / "smoke-target.txt"
        sample_file.write_text("line 1\nline 2 target\nline 3\n", encoding="utf-8")

        home = tmp / "home"
        linux_profile.prepare(home, tmp)
        env = {**os.environ, **linux_profile.profile_env(home)}
        sentinels = namespace_sentinels.seed(home)

        proc = subprocess.Popen(
            [str(codr_bin)],
            cwd=str(workspace),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        control_path = Path(env["XDG_CACHE_HOME"]) / "codr" / "control.json"
        deadline = time.monotonic() + timeout_s
        try:
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    out = proc.stdout.read() if proc.stdout else ""
                    raise RuntimeError(f"codr exited early ({proc.returncode}): {out}")
                if control_path.is_file():
                    break
                time.sleep(0.1)
            if not control_path.is_file():
                raise TimeoutError(f"control.json did not appear within {timeout_s}s")

            identify_probe: dict | None = None
            while time.monotonic() < deadline:
                res = _run_capture([str(cli_bin), "identify", "--json"], env=env, timeout=10)
                identify_probe = {
                    "args": ["identify", "--json"],
                    "exitCode": res.returncode,
                    "stdout": res.stdout,
                    "stderr": res.stderr,
                }
                if res.returncode == 0:
                    break
                time.sleep(0.2)
            if identify_probe is None or identify_probe["exitCode"] != 0:
                raise TimeoutError(f"codr frontend did not become ready: {identify_probe}")

            probes = [identify_probe]
            for args in (
                ["--version"],
                ["ping", "--json"],
                ["capabilities", "--json"],
                ["open", str(sample_file), "--line", "2", "--json"],
            ):
                res = _run_capture([str(cli_bin), *args], env=env, timeout=10)
                probes.append(
                    {
                        "args": args,
                        "exitCode": res.returncode,
                        "stdout": res.stdout,
                        "stderr": res.stderr,
                    }
                )
            time.sleep(1.0)
        finally:
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
        output_tail = (proc.stdout.read() if proc.stdout else "").splitlines()[-20:]
        sentinel_problems = namespace_sentinels.verify(home, sentinels)
        fstate = namespace_sentinels.fork_state(home)
        probe_eval = evaluate_cli_probes(probes)
        return {
            "ok": probe_eval["ok"] and len(sentinel_problems) == 0,
            "probes": probe_eval,
            "probeDetails": probes,
            "sentinelProblems": sentinel_problems,
            "forkState": fstate,
            "outputTail": output_tail,
        }


def run_fedora_container_dnf(candidate_dir: Path, rpm_name: str) -> dict:
    """Exercise RPM dependency/signature refusal, install, reinstall, and removal in Fedora 45."""
    script = f"""
set -euo pipefail
echo "=== dnf dependency enforcement refusal ==="
if dnf -y --disablerepo='*' install /pkg/{rpm_name}; then
  echo "UNEXPECTED: dnf installed without webkit2gtk4.1/gtk3"
  exit 1
fi
echo "EXPECTED_DEP_REFUSAL"
echo "=== rpm unsigned package refusal ==="
if rpm -ivh --nodeps /pkg/{rpm_name}; then
  echo "UNEXPECTED: rpm 6 installed unsigned package without --nosignature"
  exit 1
fi
echo "EXPECTED_SIG_REFUSAL"
echo "=== rpm install/upgrade/remove (--nosignature --nodeps) ==="
rpm -ivh --nodeps --nosignature /pkg/{rpm_name}
rpm -q codr
codr-cli --version
rpm -Uvh --replacepkgs --nodeps --nosignature /pkg/{rpm_name}
rpm -e codr
if rpm -q codr >/dev/null 2>&1; then
  echo "UNEXPECTED: codr still installed after remove"
  exit 1
fi
echo "REMOVED_CLEANLY"
"""
    proc = _run_capture(
        [
            "podman",
            "run",
            "--rm",
            "-v",
            f"{candidate_dir.resolve()}:/pkg:ro,Z",
            "registry.fedoraproject.org/fedora:45",
            "bash",
            "-lc",
            script,
        ],
        timeout=120,
    )
    return {
        "ok": (
            proc.returncode == 0
            and "EXPECTED_DEP_REFUSAL" in proc.stdout
            and "EXPECTED_SIG_REFUSAL" in proc.stdout
            and "REMOVED_CLEANLY" in proc.stdout
        ),
        "exitCode": proc.returncode,
        "stdoutTail": proc.stdout.splitlines()[-30:],
        "stderrTail": proc.stderr.splitlines()[-20:],
    }


def _find_rpm(candidate_dir: Path) -> Path:
    rpms = sorted(candidate_dir.glob("*.rpm"))
    if len(rpms) != 1:
        raise SystemExit(f"expected exactly one .rpm in {candidate_dir}, found {rpms}")
    return rpms[0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True, help="candidate directory under dist-packages/")
    parser.add_argument("--container", action="store_true", help="also run real dnf install/remove in fedora:45 podman")
    parser.add_argument("--output", type=Path, help="optional JSON report output path")
    args = parser.parse_args()

    rpm_path = _find_rpm(args.candidate)
    host_check = inspect_host_rpm(rpm_path)
    smoke = run_packaged_graphical_smoke(rpm_path)
    report: dict = {
        "candidateDir": str(args.candidate),
        "rpm": rpm_path.name,
        "rpmSha256": packaging.sha256_file(rpm_path),
        "host": packaging.host_record(),
        "hostRpm": host_check,
        "graphicalSmoke": smoke,
        "waivedEnvironments": [
            "Fedora 44 (validated on maintainer's Fedora 45 KDE Wayland host)",
            "Debian 13 (explicitly waived by maintainer on 2026-11-13 as personal-tool extra)",
            "Arch Linux (explicitly waived by maintainer on 2026-11-13 as personal-tool extra)",
        ],
    }
    if args.container:
        report["containerDnf"] = run_fedora_container_dnf(args.candidate, rpm_path.name)

    ok = (
        host_check["dependencies"]["ok"]
        and host_check["signature"]["digestsOk"]
        and host_check["coexistence"]["disjoint"]
        and smoke["ok"]
        and (not args.container or report["containerDnf"]["ok"])
    )
    report["ok"] = ok

    rendered = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
