# Dependency updates, upstream imports and the maintenance review

This is the maintenance policy this fork actually follows. It exists because the fork keeps a
working Linux application on a moving upstream: exact pins, lockfiles and required checks make a
dependency change reviewable, and the pin that no ecosystem tooling understands has to be
monitored by the procedure that already owns it.

Scope: dependencies (pnpm, cargo, GitHub Actions, pip), the exact toolchain pins
(`rust-toolchain.toml`, `.nvmrc`, `packageManager`), the pinned Ghostty source revision, and the
monthly review that reads all of it. The upstream-import procedure itself is
[upstream-imports.md](upstream-imports.md).

Enforced by `scripts/dependency-review/run.py`, which reads the JSON block below and the real
`.github/dependabot.yml` / `.github/workflows/ci.yml`. `scripts/tests/test_dependency_review.py`
fails when a manifest loses its bot, a bot gains a major-bump group, a required check stops naming
a real CI job, or an exact pin loses its monitor.

## What the bots propose

Dependabot is the only automation. It proposes version bumps in the four ecosystems that exist in
this repository, and it proposes nothing else - no refactors, no releases, no merges:

| Ecosystem | Directory | Manifest |
| --- | --- | --- |
| npm (pnpm) | `/` | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` |
| cargo | `/src-tauri` | `src-tauri/Cargo.lock` |
| GitHub Actions | `/` | `.github/workflows/*.yml` |
| pip | `/scripts/tests` | `scripts/tests/requirements.txt` (the guard tests' PyYAML) |

Each entry is bounded (at most five open pull requests), labelled `dependencies`, held for a
three-day cooldown so a compromised release surfaces before adoption, and grouped for
**minor and patch updates only**. A major bump always arrives as its own pull request: a grouped
major bump is a single, unreviewable change of several packages across a lockfile, which is
exactly the "unsolicited refactor" this configuration must not produce.

Lockfiles are never regenerated from a bot PR without review: CI installs with
`--frozen-lockfile`, cargo runs with `--locked`, and `cargo metadata --locked` plus
`git diff --exit-code -- Cargo.lock` prove the graph did not resolve itself. Those guards are in
`scripts/tests/test_ci_workflows.py`.

`.github/CODEOWNERS` and `docs/agents/` describe *who reviews* and *how issues are tracked*; they
are not dependency policy.

## Required checks before merge

A dependency pull request is mergeable when the CI checks below pass. Since ticket #34 the fork
builds one platform, so every named job is a single check rather than a matrix; the exact names
are emitted by `python3 scripts/dependency-review/run.py --required-checks`, which also prints the
`gh api` command that applies them to the protected branch. A job that stops existing (as
`terminal-platforms` and `rust-platforms` did) has to leave this list in the same change: the
script refuses a required check that names no workflow job.

Apply with (this is a deliberate maintainer action, not part of ordinary CI):

```sh
python3 scripts/dependency-review/run.py --required-checks | bash
```

The rest of this section is the machine-readable contract the script enforces.

```json
{
  "requiredChecks": [
    "frontend",
    "rust",
    "terminal-linux",
    "repo-guards"
  ],
  "notRequired": {
    "coverage": "uploads an lcov artifact for the same tests `rust` already gates; there is no coverage threshold to enforce"
  },
  "toolchainMonitors": [
    {
      "pin": "rust-toolchain.toml",
      "command": "python3 scripts/dependency-review/run.py --toolchains"
    },
    {
      "pin": ".nvmrc",
      "command": "python3 scripts/dependency-review/run.py --toolchains"
    },
    {
      "pin": "package.json#packageManager",
      "command": "python3 scripts/dependency-review/run.py --toolchains"
    },
    {
      "pin": "packages/ghostty-core/adapted/UPSTREAM.md",
      "command": "python3 scripts/ghostty-update/run.py --monitor"
    },
    {
      "pin": "packages/ghostty-core/adapted/wasm/build.zig.zon",
      "command": "python3 scripts/ghostty-update/run.py --monitor"
    }
  ]
}
```

`strict` is set, so a dependency pull request also has to be up to date with the protected branch
before merging; that is what makes a lockfile merge a re-check rather than a guess. Review
approval is *not* enforced by GitHub on this repository - it has one maintainer - so the review
below is policy, and the checks are the hard gate. `linux-app-smoke` stays out of this list
deliberately: it is evidence, and `docs/contributing/testing.md` explains why it cannot be a
required check yet.

## The pins no bot understands

Dependabot cannot follow a Rust toolchain file, `.nvmrc`, the `packageManager` field, or a Zig
`build.zig.zon` fetch. Those are monitored explicitly:

- **Rust / Node / pnpm** - `python3 scripts/dependency-review/run.py --toolchains` prints each pin,
  the current upstream version and a verdict (`current`, `update available`, `unverified`). A
  network failure is `unverified`, never "up to date". A toolchain bump is one reviewed change
  that touches `rust-toolchain.toml`/`.nvmrc` *and* every workflow that names the channel, because
  `scripts/tests/test_ci_workflows.py` refuses a workflow that installs anything else.
- **Ghostty source revision** - `python3 scripts/ghostty-update/run.py --monitor` reports the pinned
  commit, the current `ghostty-org/ghostty` head and how many commits the pin is behind. This is
  the same gate ticket #32 introduced, extended with a drift check; there is no second mechanism
  and no assumption that Zig tooling can be a dependency bot. Adopting a revision still means
  rebuilding both artifacts and passing the identity, compatibility, soak, benchmark and
  whole-app resource gates (`docs/architecture/terminal-checks.md`).

## Monthly review, and prompt security triage

Once a month, in one sitting, the maintainer runs the review below and records the outcome in the
issue tracker (`docs/agents/issue-tracker.md`, label `ready-for-agent` for the follow-up work).
The cadence is monthly because the fork is personal-use-first; it makes **no maintenance-hour**
commitment, and this policy does not create one.

1. `python3 scripts/upstream-import/run.py --verify --fetch --output <evidence>` - record the
   upstream head, merge base and how many upstream commits are not imported. Read
   `git log --oneline HEAD..upstream/main` and decide, per commit, whether to
   [import it](upstream-imports.md).
2. `python3 scripts/dependency-review/run.py --output <evidence>` - confirm every ecosystem still
   has a bot and every exact pin still has a monitor.
3. `python3 scripts/dependency-review/run.py --toolchains` - note any `update available`, and open
   the ordinary dependency pull requests the bots did not (the toolchains).
4. `python3 scripts/ghostty-update/run.py --monitor` - note the drift since the pinned Ghostty
   revision. Adopt or defer, and record why.
5. Review the open `dependencies` pull requests: read the release notes of a major bump, the
   lockfile diff of a minor/patch group, and the CI result of each. Merge only with the required
   checks green.
6. `python3 scripts/dependency-review/run.py` and `python3 -m unittest discover -s scripts/tests`
   after any policy or configuration edit.

**Security fixes** are triaged as soon as they are known - not on the monthly cadence. Triage means
answering three questions and recording the answers: is the advisory reachable from a code path
this application actually ships, is a fixed version available in the ecosystem, and does the fix
need a major bump or a bridge change (Ghostty, Tauri)? If it is reachable, the fix is imported
through the same procedure as any other dependency change and lands as soon as the required checks
pass. If it is not reachable, the deferral and its reason are recorded. Triage has no promised
response time: "prompt" means before the next scheduled review, and the decision rule above is
what keeps it from being forgotten.

**Advisory CI steps are not gates.** `pnpm audit --prod` and `cargo machete` report without
blocking, because a new advisory is not a reason to block an unrelated change. A security fix
enters through triage, not through a red advisory step.

No new automation is created by this policy: no scheduled workflow, no auto-merge, no bot that
opens an issue or a refactor. The proposal comes from dependabot, the decision stays with the
maintainer.

## Reproducibility this policy preserves

The Linux build, the terminal core and the packages keep their provenance and rebuild inputs:

- `LICENSE` (Apache-2.0), `packages/ghostty-core/adapted/UPSTREAM.md` (Ghostty and Restty source
  revisions, Zig version, artifact sizes and SHA-256), and
  `docs/architecture/linux-packages.md` (package identity and runtime dependencies) are the
  provenance record. An artifact update and its provenance are one change.
- `pnpm-lock.yaml` and `src-tauri/Cargo.lock` are committed; every CI install is frozen/locked.
- `rust-toolchain.toml`, `.nvmrc` and `package.json#packageManager` are the only toolchain pins.
- The terminal artifacts are reproduced by `packages/ghostty-core/adapted/UPSTREAM.md`'s rebuild
  commands and accepted only by `pnpm ghostty:update --rebuild`, never by "the tests still pass".
- Removing a platform does not remove its useful tests: `docs/architecture/terminal-checks.md`
  inventories every check and where it runs.
