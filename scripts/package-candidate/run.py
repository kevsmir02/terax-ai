#!/usr/bin/env python3
"""Build the immutable Linux package candidates for this fork.

Usage:
    python3 scripts/package-candidate/run.py            # build + record the manifest
    python3 scripts/package-candidate/run.py --dry-run  # print the effective config, build nothing

The run is deliberately narrow and non-interactive:

* it refuses to run as root, on a non-Linux or non-x86_64 host, from a dirty tree, or when the
  requested output directory already holds a completed candidate;
* it builds with an explicit `x86_64-unknown-linux-gnu` target and only the `rpm`/`deb` bundles,
  using a generated Tauri config overlay derived from the shared identity table;
* it never installs a package, never calls sudo/dnf/apt, and executes only the packaged CLI with
  a scratch HOME/XDG profile so no real user state is touched;
* it copies the artifacts into `dist-packages/<package>-<version>-<shortrev>/`, marks them
  read-only, records hashes plus an inspection manifest, and refuses to overwrite them later.

A failed build is recorded too: the manifest carries the exact failing stage and the tail of the
build log, so an environment failure is visible instead of a missing directory.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import linux_profile  # noqa: E402
import packaging  # noqa: E402

PROFILE = "release"
BUNDLE_DIR = REPO_ROOT / "src-tauri" / "target" / packaging.TARGET_TRIPLE / PROFILE / "bundle"


def fail(message: str) -> None:
    print(f"refusing: {message}", file=sys.stderr)
    raise SystemExit(2)


def preflight(allow_dirty: bool) -> dict:
    """Every reason this run would not produce a private, reproducible candidate."""
    problems = packaging.target_problems()
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        problems.append("running as root: the candidate build must not own root-only state")
    if packaging.which_or_none("rpmbuild") is None:
        problems.append("rpmbuild is missing: the rpm bundle cannot be produced")
    if packaging.which_or_none("rpm") is None:
        problems.append("rpm is missing: artifact metadata could not be verified")
    problems.extend(packaging.identity_problems())
    problems.extend(packaging.package_name_problems())
    problems.extend(packaging.config_problems())
    problems.extend(packaging.arch_problems())
    revision = packaging.git_state()
    if revision["dirty"] and not allow_dirty:
        problems.append(
            "the working tree is dirty: candidates must be built from a recorded revision "
            "(commit first, then build)"
        )
    if problems:
        fail("\n  - " + "\n  - ".join(problems))
    return revision


def output_directory(revision: dict) -> Path:
    identity = packaging.candidate()
    return packaging.OUTPUT_ROOT / (
        f"{identity.slug}-{identity.version}-{revision['commit'][:12]}"
    )


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def build(output: Path, overlay: dict) -> None:
    config_path = output / "inputs" / "tauri.candidate.conf.json"
    write_json(config_path, overlay)
    log_path = output / "build.log"
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("TAURI_SIGNING_")
    }
    command = [
        "pnpm",
        "tauri",
        "build",
        "--target",
        packaging.TARGET_TRIPLE,
        "--bundles",
        ",".join(packaging.BUNDLE_TARGETS),
        "--config",
        str(config_path),
    ]
    print("building:", " ".join(command))
    with log_path.open("wb") as log:
        result = subprocess.run(command, cwd=REPO_ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        tail = log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-40:]
        raise BuildFailure("pnpm tauri build", result.returncode, tail)


class BuildFailure(RuntimeError):
    def __init__(self, stage: str, code: int, tail: list[str]) -> None:
        super().__init__(f"{stage} exited {code}")
        self.stage = stage
        self.code = code
        self.tail = tail


def locate_bundles() -> tuple[Path, Path]:
    rpm = sorted(BUNDLE_DIR.joinpath("rpm").glob("*.rpm"))
    deb = sorted(BUNDLE_DIR.joinpath("deb").glob("*.deb"))
    if len(rpm) != 1 or len(deb) != 1:
        raise BuildFailure(
            "locate bundles",
            1,
            [
                f"expected exactly one rpm and one deb under {BUNDLE_DIR.relative_to(REPO_ROOT)}",
                f"found rpm={[path.name for path in rpm]} deb={[path.name for path in deb]}",
            ],
        )
    return rpm[0], deb[0]


def inspect_deb(deb: Path, scratch: Path) -> dict:
    control = packaging.deb_control(deb)
    extracted = packaging.extract_deb(deb, scratch / "deb")
    layout = packaging.install_layout(extracted)
    return {
        "format": "deb",
        "arch": control.get("Architecture", ""),
        "fileName": deb.name,
        "sizeBytes": deb.stat().st_size,
        "sha256": packaging.sha256_file(deb),
        "packageName": control.get("Package", ""),
        "version": control.get("Version", ""),
        "depends": [
            part.strip()
            for part in control.get("Depends", "").split(",")
            if part.strip()
        ],
        "section": control.get("Section", ""),
        "priority": control.get("Priority", ""),
        "maintainer": control.get("Maintainer", ""),
        "description": control.get("Description", ""),
        "installedSizeKiB": control.get("Installed-Size", ""),
        "files": extracted,
        "binaries": layout["binaries"],
        "licenses": layout["licenses"],
        "resources": layout["resources"],
        "control": control,
    }


def inspect_rpm(rpm: Path, scratch: Path) -> dict:
    metadata = packaging.rpm_metadata(rpm)
    extracted = packaging.extract_rpm(rpm, scratch / "rpm")
    layout = packaging.install_layout(extracted)
    return {
        "format": "rpm",
        "arch": metadata.get("arch", ""),
        "fileName": rpm.name,
        "sizeBytes": rpm.stat().st_size,
        "sha256": packaging.sha256_file(rpm),
        "packageName": metadata.get("name", ""),
        "version": "-".join(
            part for part in (metadata.get("version"), metadata.get("release")) if part
        ),
        "depends": metadata["requires"],
        "vendor": metadata.get("vendor", ""),
        "license": metadata.get("license", ""),
        "summary": metadata.get("summary", ""),
        # Extracted payload (comparable with the deb) plus the header's own file list.
        "files": extracted,
        "headerFiles": packaging.rpm_files(rpm),
        "binaries": layout["binaries"],
        "licenses": layout["licenses"],
        "resources": layout["resources"],
        "header": metadata,
    }


def run_cli(binary: Path, output: Path) -> dict:
    """Execute the packaged CLI with a disposable HOME/XDG, never the real profile."""
    home = packaging.disposable_install_root(output) / "cli-home"
    linux_profile.prepare(home, packaging.disposable_install_root(output))
    environment = {
        **os.environ,
        **linux_profile.profile_env(home),
        "TERAX_WORKSPACE_FORK_BENCH_ISOLATED": "1",
    }
    result = subprocess.run(
        [str(binary), "--help"],
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return {
        "command": f"{binary.name} --help",
        "exitCode": result.returncode,
        "stdoutFirstLine": (result.stdout.strip().splitlines() or [""])[0],
        "stderr": result.stderr.strip()[:2000],
        "profile": "disposable (HOME/XDG under the run output)",
    }


def single(entries: list[dict], kind: str) -> dict | None:
    return next((entry for entry in entries if entry["kind"] == kind), None)


def cross_format(files: dict[str, list[dict]]) -> dict:
    """Do both formats carry the same payload bytes?"""
    lists = {name: {entry["path"]: entry["sha256"] for entry in entries} for name, entries in files.items()}
    rpm, deb = lists.get("rpm", {}), lists.get("deb", {})
    return {
        "samePaths": sorted(rpm) == sorted(deb),
        "onlyInRpm": sorted(set(rpm) - set(deb)),
        "onlyInDeb": sorted(set(deb) - set(rpm)),
        "differingHashes": sorted(
            path for path in set(rpm) & set(deb) if rpm[path] != deb[path]
        ),
    }


def revision_record(revision: dict) -> dict:
    return {
        "commit": revision["commit"],
        "branch": revision["branch"],
        "describe": revision["describe"],
        "dirty": revision["dirty"],
        "recordedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def input_files(output: Path, archive: Path) -> list[dict]:
    paths = [
        packaging.IDENTITY_FILE,
        packaging.TAURI_CONFIG,
        REPO_ROOT / "src-tauri" / "Cargo.lock",
        REPO_ROOT / "pnpm-lock.yaml",
        REPO_ROOT / "rust-toolchain.toml",
        REPO_ROOT / "scripts" / "build-cli.mjs",
        REPO_ROOT / "scripts" / "packaging.py",
        REPO_ROOT / "scripts" / "package-candidate" / "run.py",
        packaging.PKGBUILD,
        output / "inputs" / "tauri.candidate.conf.json",
        archive,
    ]
    return [
        {
            "path": str(path.relative_to(REPO_ROOT)) if path.is_relative_to(REPO_ROOT) else str(path),
            "sha256": packaging.sha256_file(path),
            "sizeBytes": path.stat().st_size,
        }
        for path in paths
    ]


def source_archive(output: Path, revision: dict) -> Path:
    identity = packaging.candidate()
    destination = output / "sources" / f"{identity.slug}-{identity.version}.tar.gz"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as archive:
        subprocess.run(
            [
                "git",
                "-C",
                str(REPO_ROOT),
                "archive",
                "--format=tar.gz",
                f"--prefix={identity.slug}-{identity.version}/",
                revision["commit"],
            ],
            stdout=archive,
            check=True,
        )
    return destination


def replace_field(text: str, name: str, value: str) -> str:
    """Replace a single `name=...` PKGBUILD field (values here are simple, single-line)."""
    pattern = re.compile(rf"^{re.escape(name)}=.*$", re.MULTILINE)
    if not pattern.search(text):
        raise ValueError(f"PKGBUILD has no {name!r} field")
    return pattern.sub(lambda _match: f"{name}={value}", text, count=1)


def render_pkgbuild(output: Path, revision: dict, archive: Path) -> Path:
    """A copy of the Arch recipe pinned to this revision and source hash."""
    identity = packaging.candidate()
    text = packaging.PKGBUILD.read_text(encoding="utf-8")
    text = replace_field(text, "pkgver", identity.version)
    text = replace_field(text, "pkgname", identity.slug)
    text = replace_field(text, "_commit", revision["commit"])
    text = replace_field(text, "sha256sums", f"('{packaging.sha256_file(archive)}')")
    destination = output / "arch" / "PKGBUILD"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(text, encoding="utf-8")
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the effective candidate config and artifact names without building",
    )
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="allow an uncommitted tree (the manifest records dirty=true; never for evidence)",
    )
    args = parser.parse_args()

    revision = preflight(args.allow_dirty)
    output = output_directory(revision)
    identity = packaging.candidate()
    overlay = packaging.candidate_config()

    if args.dry_run:
        print(json.dumps({
            "output": str(output.relative_to(REPO_ROOT)),
            "revision": revision,
            "candidate": overlay,
            "artifacts": {
                "deb": f"{identity.slug}_{identity.version}_{packaging.DEB_ARCH}.deb",
                "rpm": f"{identity.slug}-{identity.version}-1.{packaging.RPM_ARCH}.rpm",
            },
        }, indent=2))
        return 0

    completed = output / "manifest.json"
    if completed.is_file():
        try:
            existing = json.loads(completed.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = {}
        if existing.get("validation", {}).get("build", {}).get("status") == "complete":
            fail(
                f"{output.relative_to(REPO_ROOT)} already holds a completed candidate; "
                "candidate outputs are immutable, use another revision or remove it deliberately"
            )

    output.mkdir(parents=True, exist_ok=True)
    host = packaging.host_record()
    toolchain = packaging.toolchain_record()
    validation: dict = {
        "build": {"status": "in-progress", "command": "pnpm tauri build --bundles rpm,deb"},
        "extraction": {"status": "not-run"},
        "cliExecution": {"status": "not-run"},
        "crossFormat": {"status": "not-run"},
        "install": {"status": "not-run", "reason": "no package transaction is run by this ticket"},
        "graphicalSmoke": {"status": "not-run", "reason": "packaged-app seam (#44)"},
        "debianEnvironment": {"status": "not-run", "reason": "Debian 13 not available on this host"},
        "archBuild": {"status": "not-run", "reason": "makepkg is not installed on this host"},
        "signatureTrust": {"status": "not-run", "reason": "trust provisioning is #39/#40"},
        "updater": {"status": "not-run", "reason": "update discovery/install is #37"},
    }
    artifacts: list[dict] = []
    dependencies = {
        "declared": {
            "deb": list(packaging.DEB_DEPENDS),
            "rpm": list(packaging.RPM_DEPENDS),
            "arch": list(packaging.ARCH_DEPENDS),
        },
        "observedElf": [],
        "unresolvedOnHost": [],
    }
    try:
        build(output, overlay)
        rpm_path, deb_path = locate_bundles()
        validation["build"] = {"status": "complete", "command": "pnpm tauri build --bundles rpm,deb"}
        scratch = output / "work"
        deb = inspect_deb(deb_path, scratch)
        rpm = inspect_rpm(rpm_path, scratch)
        artifacts = [rpm, deb]

        # Stable names: the bundler writes the product name with spaces.
        for artifact in artifacts:
            if artifact["format"] == "rpm":
                stable = f"{identity.slug}-{artifact['version']}.{packaging.RPM_ARCH}.rpm"
            else:
                stable = f"{identity.slug}_{artifact['version']}_{packaging.DEB_ARCH}.deb"
            destination = output / stable
            source = rpm_path if artifact["format"] == "rpm" else deb_path
            shutil.copyfile(source, destination)
            destination.chmod(0o444)
            artifact["fileName"] = stable
            artifact["path"] = str(destination.relative_to(REPO_ROOT))
            artifact["sha256"] = packaging.sha256_file(destination)

        validation["extraction"] = {
            "status": "verified",
            "method": "deb: ar + tar via stdlib; rpm: rpm2cpio + cpio",
            "deb": {"files": len(deb["files"]), "controlFields": sorted(deb["control"])},
            "rpm": {"files": len(rpm["files"])},
        }
        cross = cross_format({artifact["format"]: artifact["files"] for artifact in artifacts})
        validation["crossFormat"] = {
            "status": "verified" if not (cross["onlyInDeb"] or cross["onlyInRpm"] or cross["differingHashes"]) else "mismatch",
            **cross,
        }

        app_binary = next(
            entry for entry in deb["binaries"] if entry["kind"] == "binary"
        )
        extracted_binary = scratch / "deb" / app_binary["path"].lstrip("/")
        dependencies["observedElf"] = packaging.elf_needed(extracted_binary)
        dependencies["unresolvedOnHost"] = packaging.unresolved_libraries(extracted_binary)

        cli_entry = next(entry for entry in deb["binaries"] if entry["kind"] == "cli")
        cli = scratch / "deb" / cli_entry["path"].lstrip("/")
        cli_result = run_cli(cli, output)
        validation["cliExecution"] = {
            "status": "verified" if cli_result["exitCode"] == 0 else "failed",
            **cli_result,
        }

        archive = source_archive(output, revision)
        pkgbuild = render_pkgbuild(output, revision, archive)
        packaging_paths = {
            "deb": str((output / artifacts[1]["fileName"]).relative_to(REPO_ROOT)),
            "rpm": str((output / artifacts[0]["fileName"]).relative_to(REPO_ROOT)),
        }
        validation["archBuild"] = {
            "status": "not-run",
            "reason": "makepkg is not installed on this host",
            "recipe": str(packaging.PKGBUILD.relative_to(REPO_ROOT)),
            "recordedRecipe": str(pkgbuild.relative_to(REPO_ROOT)),
        }
        document = packaging.manifest_document(
            revision=revision_record(revision),
            host=host,
            toolchain=toolchain,
            inputs=input_files(output, archive),
            artifacts=artifacts,
            dependencies=dependencies,
            validation=validation,
        )
        document["outputs"] = packaging_paths
        problems = packaging.manifest_problems(document)
        if problems:
            raise RuntimeError("manifest schema problems: " + "; ".join(problems))
        write_json(output / "manifest.json", document)
        (output / "SHA256SUMS").write_text(
            packaging.sha256sums(artifacts), encoding="utf-8"
        )
        evidence = output / "evidence"
        evidence.mkdir(exist_ok=True)
        (evidence / "deb-control.txt").write_text(
            "\n".join(f"{key}: {value}" for key, value in deb["control"].items()) + "\n",
            encoding="utf-8",
        )
        (evidence / "rpm-qip.txt").write_text(
            packaging.rpm_query(rpm_path, "-qip"), encoding="utf-8"
        )
        (evidence / "rpm-qlp.txt").write_text(
            packaging.rpm_query(rpm_path, "-qlp"), encoding="utf-8"
        )
        packaging_dir = output / "work"
        shutil.rmtree(packaging_dir, ignore_errors=True)
        print(f"candidate written to {output.relative_to(REPO_ROOT)}")
        for artifact in artifacts:
            print(f"  {artifact['fileName']}  {artifact['sizeBytes']} bytes  {artifact['sha256']}")
        return 0
    except (BuildFailure, RuntimeError, OSError, ValueError) as error:
        validation["build"] = {
            "status": "failed",
            "stage": getattr(error, "stage", "inspection"),
            "exitCode": getattr(error, "code", None),
            "message": str(error),
            "logTail": getattr(error, "tail", []),
        }
        document = packaging.manifest_document(
            revision=revision_record(revision),
            host=host,
            toolchain=toolchain,
            inputs=[],
            artifacts=artifacts,
            dependencies=dependencies,
            validation=validation,
        )
        write_json(output / "manifest.json", document)
        print(f"candidate build FAILED at {validation['build']['stage']}: {error}", file=sys.stderr)
        for line in validation["build"]["logTail"]:
            print(f"  {line}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
