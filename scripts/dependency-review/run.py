#!/usr/bin/env python3
"""Reviewed dependency updates and pinned-toolchain monitoring for this fork.

Dependabot owns the bumps it understands; this script proves the configuration still matches the
repository, and monitors the exact pins no ecosystem bot covers.

  ecosystems    every dependency manifest in this repository (pnpm, cargo, GitHub Actions, pip)
                must have a bot pointed at the same directory. A manifest without a bot is a
                dependency change nobody proposes; a bot for an ecosystem this repository does
                not have is noise.
  entry-policy  bots are dependency bumps only: a bounded number of weekly PRs, labelled for
                triage, cooled down so a compromised release surfaces before adoption, and never
                a grouped *major* bump (a major arrives as its own reviewed PR).
  checks        the policy document lists the CI jobs that must pass before a dependency PR can
                merge. Every name must be a real job, every job must be either required or
                explicitly not required with a reason, and the exact check names GitHub reports
                (matrix jobs included) can be emitted as the branch-protection payload.
  monitors      `rust-toolchain.toml`, `.nvmrc`, `package.json#packageManager` and the pinned
                Ghostty source/Zig revision have no ecosystem bot. Each pin needs a declared
                monitor command, and the command must point at a script that exists. The Ghostty
                revision is monitored by `scripts/ghostty-update/run.py` (ticket #32's gate), not
                by a second mechanism.

The policy itself (cadence, security triage, review rules) is
`docs/architecture/dependency-updates.md`; its ```json block is the machine-readable contract this
script enforces, so the document and the checks cannot drift apart.

Usage:

    python3 scripts/dependency-review/run.py                     # offline: verify the configuration
    python3 scripts/dependency-review/run.py --output DIR        # + write dependency-review.json
    python3 scripts/dependency-review/run.py --required-checks   # print the gh api payload
    python3 scripts/dependency-review/run.py --toolchains        # pinned vs latest (needs network)

Nothing here opens, merges or pushes a pull request: the bots propose, the maintainer reviews, and
the required checks above decide whether the proposal is mergeable.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
POLICY_DOC = Path("docs/architecture/dependency-updates.md")
DEPENDABOT = Path(".github/dependabot.yml")
CI = Path(".github/workflows/ci.yml")
REVIEW_LABEL = "dependencies"
PROTECTED_BRANCH = "main"

# The manifests this repository has, with the dependabot `package-ecosystem` that owns each one.
# Order is stable so reports diff cleanly.
MANIFEST_RULES = (
    ("npm", "/", ("pnpm-lock.yaml", "package.json")),
    ("cargo", "/src-tauri", ("src-tauri/Cargo.lock",)),
    ("github-actions", "/", (".github/workflows",)),
    ("pip", "/scripts/tests", ("scripts/tests/requirements.txt",)),
    ("gomod", "/", ("go.mod",)),
    ("docker", "/", ("Dockerfile",)),
)

# Exact pins with no ecosystem bot. A pin is monitored by a command in the policy document.
PIN_FILES = {
    "rust-toolchain.toml": "rust-toolchain.toml",
    ".nvmrc": ".nvmrc",
    "package.json#packageManager": "package.json",
    "packages/ghostty-core/adapted/UPSTREAM.md": "packages/ghostty-core/adapted/UPSTREAM.md",
    "packages/ghostty-core/adapted/wasm/build.zig.zon": "packages/ghostty-core/adapted/wasm/build.zig.zon",
}
ALLOWED_INTERVALS = ("weekly", "monthly")
MAX_OPEN_PR = 10
COOLDOWN_DAYS = 3
GROUP_UPDATE_TYPES = ("minor", "patch")


class Refusal(SystemExit):
    """A configuration decision that must be made deliberately, not inferred."""

    def __init__(self, message: str) -> None:
        super().__init__(f"refusing: {message}")


@dataclasses.dataclass
class GateResult:
    """One decision. `status` is pass or fail - a missing input is a failure, not a pass."""

    name: str
    status: str
    detail: str
    evidence: dict = dataclasses.field(default_factory=dict)


# --------------------------------------------------------------------------- inputs


def read(path: Path) -> str:
    return path.read_text()


def parse_yaml(text_body: str) -> dict:
    try:
        import yaml
    except ImportError as error:  # pragma: no cover - the guard tests install PyYAML
        raise Refusal(
            "PyYAML is required: python3 -m pip install -r scripts/tests/requirements.txt"
        ) from error
    return yaml.safe_load(text_body)


def parse_policy(text_body: str) -> dict:
    """The machine-readable contract inside the policy document."""
    match = re.search(r"```json\n(.*?)\n```", text_body, re.DOTALL)
    if not match:
        raise Refusal(
            f"{POLICY_DOC} has no ```json block: the required checks and pin monitors are not "
            f"machine-readable, so nothing enforces them"
        )
    policy = json.loads(match.group(1))
    for key in ("requiredChecks", "notRequired", "toolchainMonitors"):
        if key not in policy:
            raise Refusal(f"{POLICY_DOC} policy block has no `{key}`")
    return policy


def manifests(root: Path) -> list[dict]:
    """The dependency manifests this checkout actually has, and the bot that must own each."""
    found = []
    for ecosystem, directory, markers in MANIFEST_RULES:
        for marker in markers:
            if (root / marker).exists():
                found.append({"ecosystem": ecosystem, "directory": directory, "manifest": marker})
                break
    return found


def toolchain_pins(root: Path) -> dict:
    """The exact pins, read from the files that produce the builds."""
    pins: dict[str, str] = {}
    toolchain = root / PIN_FILES["rust-toolchain.toml"]
    if toolchain.exists():
        match = re.search(r'^channel\s*=\s*"([^"]+)"', read(toolchain), re.MULTILINE)
        if match:
            pins["rust-toolchain.toml"] = match.group(1)
    nvmrc = root / PIN_FILES[".nvmrc"]
    if nvmrc.exists():
        pins[".nvmrc"] = read(nvmrc).strip()
    package = root / PIN_FILES["package.json#packageManager"]
    if package.exists():
        try:
            manager = json.loads(read(package)).get("packageManager", "")
        except json.JSONDecodeError:
            manager = ""
        match = re.search(r"(pnpm@\d+\.\d+\.\d+)", manager)
        if match:
            pins["package.json#packageManager"] = match.group(1)
    upstream = root / PIN_FILES["packages/ghostty-core/adapted/UPSTREAM.md"]
    if upstream.exists():
        match = re.search(r"^- Ghostty commit: `([0-9a-f]{40})`", read(upstream), re.MULTILINE)
        if match:
            pins["packages/ghostty-core/adapted/UPSTREAM.md"] = match.group(1)
    zon = root / PIN_FILES["packages/ghostty-core/adapted/wasm/build.zig.zon"]
    if zon.exists():
        match = re.search(r'\.minimum_zig_version\s*=\s*"([^"]+)"', read(zon))
        if match:
            pins["packages/ghostty-core/adapted/wasm/build.zig.zon"] = match.group(1)
    return pins


# --------------------------------------------------------------------------- gates


def coverage_gate(declared: list[dict], entries: list[dict]) -> GateResult:
    """Each manifest has a bot at the same directory, and no bot covers an absent ecosystem."""
    have = {(entry.get("package-ecosystem"), entry.get("directory")) for entry in entries}
    problems = []
    for manifest in declared:
        key = (manifest["ecosystem"], manifest["directory"])
        if key not in have:
            problems.append(
                f"{manifest['manifest']} has no dependabot entry for {manifest['ecosystem']} at "
                f"{manifest['directory']}"
            )
    wanted = {(manifest["ecosystem"], manifest["directory"]) for manifest in declared}
    for ecosystem, directory in sorted(have - wanted, key=lambda item: (item[0] or "", item[1] or "")):
        problems.append(
            f"a dependabot entry for {ecosystem} at {directory} has no manifest in this repository"
        )
    if problems:
        return GateResult("ecosystems", "fail", "; ".join(problems), {"entries": sorted(have)})
    return GateResult(
        "ecosystems",
        "pass",
        f"{len(declared)} manifests covered: " + ", ".join(sorted({m['ecosystem'] for m in declared})),
        {"entries": sorted(have)},
    )


def entry_policy_gate(entries: list[dict]) -> GateResult:
    """Bounded, labelled, cooled-down, dependency-bump-only bot configuration."""
    if not entries:
        return GateResult("entry-policy", "fail", "no dependency bots are configured")
    problems = []
    for entry in entries:
        ecosystem = entry.get("package-ecosystem", "?")
        interval = (entry.get("schedule") or {}).get("interval")
        if interval not in ALLOWED_INTERVALS:
            problems.append(f"{ecosystem}: schedule {interval!r} is not one of {ALLOWED_INTERVALS}")
        limit = entry.get("open-pull-requests-limit")
        if not isinstance(limit, int) or not 1 <= limit <= MAX_OPEN_PR:
            problems.append(
                f"{ecosystem}: open-pull-requests-limit {limit!r} is not an integer in 1..{MAX_OPEN_PR}"
            )
        if REVIEW_LABEL not in (entry.get("labels") or []):
            problems.append(f"{ecosystem}: pull requests must carry the {REVIEW_LABEL!r} label")
        cooldown = (entry.get("cooldown") or {}).get("default-days")
        if not isinstance(cooldown, int) or cooldown < COOLDOWN_DAYS:
            problems.append(
                f"{ecosystem}: cooldown.default-days {cooldown!r} is below the {COOLDOWN_DAYS}-day "
                f"adoption delay"
            )
        for name, group in (entry.get("groups") or {}).items():
            update_types = group.get("update-types") or []
            if not update_types:
                problems.append(
                    f"{ecosystem}: group {name!r} does not declare update-types, so it can bundle "
                    f"a major bump"
                )
            for update_type in update_types:
                if update_type not in GROUP_UPDATE_TYPES:
                    problems.append(
                        f"{ecosystem}: group {name!r} includes {update_type!r} updates; a major bump "
                        f"must arrive as its own reviewed pull request"
                    )
    if problems:
        return GateResult("entry-policy", "fail", "; ".join(problems), {"entries": len(entries)})
    return GateResult(
        "entry-policy",
        "pass",
        f"{len(entries)} bots: at most a weekly schedule, grouped minor/patch only, "
        f"labelled {REVIEW_LABEL}, {COOLDOWN_DAYS}-day cooldown, bounded open pull requests",
        {"entries": len(entries)},
    )


def job_names(workflow: dict) -> list[str]:
    return list((workflow.get("jobs") or {}).keys())


def expand_required(required: list[str], workflow: dict) -> list[str]:
    """The check names GitHub reports, with matrix jobs expanded per combination."""
    names: list[str] = []
    jobs = workflow.get("jobs") or {}
    for job_id in required:
        job = jobs.get(job_id, {})
        display = job.get("name", job_id)
        matrix = (job.get("strategy") or {}).get("matrix") or {}
        keys = [key for key, values in matrix.items() if isinstance(values, list)
                and all(isinstance(value, (str, int)) for value in values)]
        if not keys or "${{" not in str(display):
            names.append(display)
            continue
        combinations = [{}]
        for key in keys:
            combinations = [{**combination, key: value} for combination in combinations
                            for value in matrix[key]]
        for combination in combinations:
            rendered = str(display)
            for key, value in combination.items():
                rendered = rendered.replace("${{ matrix." + key + " }}", str(value))
            names.append(rendered)
    return names


def required_checks_gate(policy: dict, workflow: dict) -> GateResult:
    """Every required check is a real CI job; a typo would silently require nothing."""
    required = list(policy["requiredChecks"])
    jobs = set(job_names(workflow))
    missing = [job for job in required if job not in jobs]
    if missing:
        return GateResult(
            "required-checks",
            "fail",
            "required checks that name no CI job: " + ", ".join(missing),
            {"jobs": sorted(jobs)},
        )
    expanded = expand_required(required, workflow)
    return GateResult(
        "required-checks",
        "pass",
        f"{len(required)} jobs required ({len(expanded)} check names): {', '.join(expanded)}",
        {"checks": expanded},
    )


def unrequired_jobs_gate(policy: dict, workflow: dict) -> GateResult:
    """Every CI job is either required or explicitly not required, with a recorded reason."""
    required = set(policy["requiredChecks"])
    not_required = policy.get("notRequired") or {}
    problems = []
    for job_id in job_names(workflow):
        if job_id in required:
            continue
        reason = not_required.get(job_id)
        if not reason:
            problems.append(
                f"{job_id} is neither a required check nor listed in `notRequired` with a reason"
            )
        elif len(str(reason)) < 10:
            problems.append(f"{job_id}: the `notRequired` reason is not an explanation ({reason!r})")
    for job_id in not_required:
        if job_id in required:
            problems.append(f"{job_id} is both required and not required")
        elif job_id not in set(job_names(workflow)):
            problems.append(f"{job_id} is listed in `notRequired` but is not a CI job")
    if problems:
        return GateResult("unrequired-jobs", "fail", "; ".join(problems))
    return GateResult(
        "unrequired-jobs",
        "pass",
        f"{len(job_names(workflow)) - len(required)} job(s) explicitly not required: "
        + ", ".join(sorted(not_required)),
    )


def required_checks_payload(policy: dict, workflow: dict, branch: str = PROTECTED_BRANCH) -> dict:
    """The branch-protection body: the checks, and nothing that needs a second maintainer."""
    return {
        "required_status_checks": {
            "strict": True,
            "contexts": expand_required(policy["requiredChecks"], workflow),
        },
        "enforce_admins": False,
        "required_pull_request_reviews": None,
        "restrictions": None,
        "branch": branch,
    }


def required_checks_command(payload: dict, repo: str = "kevsmir02/terax-ai") -> str:
    """The exact command that applies the policy. Printing it is not applying it."""
    body = {key: value for key, value in payload.items() if key != "branch"}
    pretty = json.dumps(body, indent=2)
    return (
        f"gh api --method PUT repos/{repo}/branches/{payload['branch']}/protection \\\n"
        f"  --input - <<'JSON'\n{pretty}\nJSON"
    )


def monitor_gate(policy: dict, pins: dict, root: Path) -> GateResult:
    """Each exact pin has a declared monitor, and each monitor runs a script that exists."""
    declared = {entry["pin"]: entry["command"] for entry in policy["toolchainMonitors"]}
    problems = []
    for pin in pins:
        if pin not in declared:
            problems.append(
                f"{pin} is pinned in the repository but the policy declares no monitor for it"
            )
    for pin, command in declared.items():
        if pin not in pins:
            problems.append(f"the policy monitors {pin}, but this checkout has no such pin")
        match = re.search(r"python3\s+(\S+)", command)
        if not match:
            problems.append(f"{pin}: the monitor command must run a repository script ({command})")
            continue
        if not (root / match.group(1)).exists():
            problems.append(f"{pin}: the monitor runs {match.group(1)}, which does not exist")
    if problems:
        return GateResult("toolchain-monitors", "fail", "; ".join(problems), {"monitors": declared})
    return GateResult(
        "toolchain-monitors",
        "pass",
        f"{len(declared)} pins monitored: " + ", ".join(sorted(declared)),
        {"monitors": declared},
    )


# --------------------------------------------------------------------------- toolchain report


def toolchain_rows(pins: dict, latest: dict | None) -> list[dict]:
    """Pinned versus latest for each pin, with `unverified` when nothing could be compared."""
    rows = []
    for pin, pinned in pins.items():
        if latest is None or not latest.get(pin):
            rows.append({"pin": pin, "pinned": pinned, "latest": None, "verdict": "unverified"})
            continue
        current = latest[pin]
        verdict = "current" if str(current) == str(pinned) else "update available"
        rows.append({"pin": pin, "pinned": pinned, "latest": current, "verdict": verdict})
    return rows


def fetch_json(url: str, timeout: float = 20) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "terax-dependency-review"})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https URLs
        return json.loads(response.read().decode("utf-8"))


def fetch_text(url: str, timeout: float = 20) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "terax-dependency-review"})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https URLs
        return response.read().decode("utf-8")


def latest_toolchains(fetch_json=fetch_json, fetch_text=fetch_text) -> dict:
    """The current upstream versions of the pins a bot cannot follow.

    Ghostty is absent on purpose: its revision is compared by
    `scripts/ghostty-update/run.py --monitor`, which owns the provenance record.
    """
    latest: dict[str, str | None] = {
        "rust-toolchain.toml": None,
        ".nvmrc": None,
        "package.json#packageManager": None,
    }
    try:
        stable = fetch_text("https://static.rust-lang.org/dist/channel-rust-stable.toml")
        # The manifest's own `[pkg.rust]` block is the toolchain version; other blocks name
        # components and carry unrelated versions.
        match = re.search(r'\[pkg\.rust\][^\[]*?version = "(\d+\.\d+\.\d+)', stable, re.DOTALL)
        latest["rust-toolchain.toml"] = match.group(1) if match else None
    except Exception:  # noqa: BLE001 - an unreachable source is unverified, not a failure
        pass
    try:
        releases = fetch_json("https://nodejs.org/dist/index.json")
        lts = next((entry["version"] for entry in releases if entry.get("lts")), None)
        latest[".nvmrc"] = lts.lstrip("v").split(".")[0] if lts else None
    except Exception:  # noqa: BLE001
        pass
    try:
        latest["package.json#packageManager"] = "pnpm@" + fetch_json(
            "https://registry.npmjs.org/pnpm/latest"
        )["version"]
    except Exception:  # noqa: BLE001
        pass
    return latest


# --------------------------------------------------------------------------- report


def report(root: Path = REPO) -> dict:
    """The offline verdict: does this checkout still have a reviewed dependency-update policy?"""
    gates: list[GateResult] = []
    policy = None
    try:
        policy = parse_policy(read(root / POLICY_DOC))
        gates.append(GateResult("policy", "pass", f"read {POLICY_DOC}"))
    except (OSError, Refusal) as refusal:
        gates.append(GateResult("policy", "fail", str(refusal)))

    # Ecosystem coverage stands alone: it is about the repository's manifests, not about the policy
    # document, so a missing policy must not hide a manifest nobody proposes updates for.
    try:
        entries = parse_yaml(read(root / DEPENDABOT)).get("updates", [])
    except (OSError, Refusal) as error:
        entries = []
        gates.append(GateResult("bot-config", "fail", f"dependabot configuration unreadable: {error}"))
    gates.append(coverage_gate(manifests(root), entries))
    gates.append(entry_policy_gate(entries))

    if policy is not None:
        try:
            workflow = parse_yaml(read(root / CI))
            gates.append(required_checks_gate(policy, workflow))
            gates.append(unrequired_jobs_gate(policy, workflow))
        except (OSError, Refusal) as error:
            gates.append(GateResult("required-checks", "fail", f"{CI} unreadable: {error}"))
        try:
            gates.append(monitor_gate(policy, toolchain_pins(root), root))
        except (OSError, Refusal) as error:
            gates.append(GateResult("toolchain-monitors", "fail", str(error)))
    accepted = all(gate.status == "pass" for gate in gates)
    return {
        "scope": "reviewed dependency updates: ecosystem coverage, bot scope, required checks and "
                 "the monitors for pins no ecosystem tooling understands. Offline: no request is "
                 "made and no pull request is opened, merged or pushed.",
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "policy": str(POLICY_DOC),
        "accepted": accepted,
        "gates": [dataclasses.asdict(gate) for gate in gates],
    }


def write_json(path: Path, value: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        allow_abbrev=False,
    )
    parser.add_argument("--output", type=Path, help="directory for the JSON report")
    parser.add_argument("--required-checks", action="store_true",
                        help="print the branch-protection payload and the command that applies it")
    parser.add_argument("--toolchains", action="store_true",
                        help="compare the exact pins with their current upstream versions")
    args = parser.parse_args()

    if args.required_checks:
        policy = parse_policy(read(REPO / POLICY_DOC))
        workflow = parse_yaml(read(REPO / CI))
        payload = required_checks_payload(policy, workflow)
        print(required_checks_command(payload))
        return 0

    if args.toolchains:
        policy = parse_policy(read(REPO / POLICY_DOC))
        monitors = {entry["pin"]: entry["command"] for entry in policy["toolchainMonitors"]}
        # Only the pins this script can actually compare belong in this table; the Ghostty
        # revision is compared by the ticket #32 gate and would otherwise look "unverified" here.
        pins = {pin: value for pin, value in toolchain_pins(REPO).items()
                if "dependency-review/run.py" in monitors.get(pin, "")}
        rows = toolchain_rows(pins, latest_toolchains())
        for row in rows:
            print(f"{row['verdict']:17} {row['pin']:32} {row['pinned']:12} -> {row['latest'] or 'unknown'}")
        for pin, command in monitors.items():
            if pin not in pins:
                print(f"{'elsewhere':17} {pin:32} {command}")
        print("\nNothing here adopts an update: a toolchain bump is one reviewed change, and the")
        print("Ghostty revision is adopted only by `python3 scripts/ghostty-update/run.py --rebuild`.")
        if args.output:
            print(f"report: {write_json(args.output / 'toolchains.json', {'rows': rows, 'monitors': monitors})}")
        return 0 if all(row["verdict"] in ("current", "update available") for row in rows) else 1

    result = report(REPO)
    for gate in result["gates"]:
        print(f"{gate['status']:5} {gate['name']:20} {gate['detail']}")
    if args.output:
        print(f"report: {write_json(args.output / 'dependency-review.json', result)}")
    print("ACCEPTED" if result["accepted"] else "REFUSED: the dependency policy is not satisfied")
    return 0 if result["accepted"] else 1


if __name__ == "__main__":
    sys.exit(main())
