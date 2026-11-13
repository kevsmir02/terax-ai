# Testing

This guide elaborates on `TERAX.md` and `CONTRIBUTING.md`. If anything conflicts with those files, they win.

## Running checks locally

The canonical commands are what CI runs (`.github/workflows/ci.yml`):

```bash
pnpm lint
pnpm check-types
pnpm test

cd src-tauri
cargo clippy --all-targets --locked -- -D warnings
cargo nextest run --locked        # CI uses nextest
```

If you do not have `cargo-nextest` installed, `cargo test --locked` is the local fallback. Install nextest with `cargo install cargo-nextest`.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`. This fork builds and
distributes Linux x86-64 only, so every job runs on a Linux runner and there is no per-platform
matrix:

| Job | What it runs |
| --- | --- |
| `frontend` | `pnpm lint`, `pnpm check-types`, `pnpm test`, `pnpm build`, `pnpm check:dist` (sourcemapped build into `dist-graph/`: startup dependency graph **and** duplicate-version packages), `pnpm size`, plus advisory `pnpm audit`/`react-compiler-healthcheck`/`pnpm knip` |
| `rust` | `cargo check/clippy/nextest --locked` on Linux, a locked dependency-graph check, advisory `cargo fmt --check` and `cargo machete`, fish/bash/zsh shell integration |
| `terminal-linux` | the whole terminal strategy on Linux: the Vitest terminal suite, the sustained-output soak, the adapted-core benchmark and the Playwright pixel parity gate against the WebGL fallback |
| `coverage` | `cargo llvm-cov nextest --locked` |
| `repo-guards` | `python3 -m unittest discover -s scripts/tests` |

The Windows/macOS `terminal-platforms` and Windows/macOS/arm `rust-platforms` matrices were
removed with the platform narrowing (ticket #34). Their Linux halves are `terminal-linux` and
`rust`, which already ran the same commands, so no Linux coverage was dropped; the one check that
did not move is the WebGPU half of the pixel gate, which is an existing named gap
(`docs/architecture/terminal-checks.md`) rather than a removal.

`repo-guards` is the contract job: `scripts/tests` holds the disposable-profile invariants of the
real-app runners **and** `scripts/tests/test_ci_workflows.py`, which fails if a workflow stops
pinning the Rust toolchain, reads a Node version from anywhere but `.nvmrc`, installs without
`--frozen-lockfile`/`--locked`, adds an auto-merge or release publish step to `ci.yml`, runs on a
runner outside the supported Linux set, re-adds a removed platform's build or distribution step,
lets the release workflow stage a format `tauri.conf.json` does not declare, or lets a README
advertise a platform this fork does not build. Run it locally before touching `.github/`:

```bash
python3 -m pip install -r scripts/tests/requirements.txt   # PyYAML: validates the workflow YAML
python3 -m unittest discover -s scripts/tests -v
```

The YAML validation fails rather than skips when PyYAML is missing, and both workflows that run
these tests install `scripts/tests/requirements.txt` first, so a green run always means the workflow
files were actually parsed.

`pnpm check:dist` is not a pass over whatever `dist/` happens to exist: it builds a production
build with sourcemaps into the gitignored `dist-graph/` and checks both halves of the built graph -
the startup graph forbidden chunks/packages, and packages bundled in more than one version (which
needs the sourcemaps). It exits non-zero if the build produced no sourcemaps, so the duplicate half
cannot silently stop running.

Dependency updates and upstream imports have their own contracts, both enforced inside
`scripts/tests`: `docs/architecture/dependency-updates.md` (every manifest has a bounded,
major-free bot; every required check names a real CI job; every exact pin has a monitor) and
`docs/architecture/upstream-imports.md` (the two remotes stay distinct, only upstream commits are
imported, an import runs its gates and never pushes).

Toolchains are pinned in `rust-toolchain.toml` (exact `1.99.1`, with `clippy` and `rustfmt`) and
`.nvmrc` (Node major, bare file — no comments, because `setup-node` reads the whole thing) for
local `rustc`, `nvm` and `fnm`. `actions/setup-node` reads `.nvmrc` directly, so Node cannot drift;
Rust has no equivalent action input, so each workflow passes the channel explicitly as
`toolchain: "1.99.1"` and the guard test fails when any of them disagrees with the file. The Node
major is pinned rather than the patch release so CI picks up Node security updates with the runner
image; `package.json` `engines` still promises `>=22` for local work. A toolchain bump is therefore
one reviewed change. `pnpm` itself is pinned exactly by `packageManager` in `package.json`, and
both lockfiles are enforced (`--frozen-lockfile`, `--locked`, and `git diff --exit-code --
Cargo.lock` after `cargo metadata --locked`).

`cargo fmt --all --check` is advisory: the tree is not rustfmt-clean, so making it blocking needs
its own reformatting change first. `pnpm analyze:eager` is not a CI step because
`src/app/eager-budget.test.ts` (inside `pnpm test`) already fails on an eager-graph regression.

Ordinary CI never publishes or merges: no release upload, no auto-merge, read-only permissions.
Publishing stays on `release.yml` and tag pushes.

### Linux real-app smoke job

`.github/workflows/linux-app-smoke.yml` runs the real WebKitGTK application through
`scripts/app-lab/run.py --scenario workflow --profile debug` on Xvfb + openbox, after proving the
disposable-profile refusals with `--self-test`. It is **evidence, not a required check**: it runs
nightly (05:17 UTC), on demand (`workflow_dispatch`), and on pull requests that carry the
`linux-smoke` label, and a PR without the label skips it before a runner is provisioned. It has a
45-minute job timeout and a 20-minute smoke step, one attempt per run (the runner retries a lost
launch itself, `MAX_ATTEMPTS = 3`), so it cannot become a hanging or flaky gate. Do not add it to
branch protection until it has been observed green on a hosted runner. It runs the same
`scripts/tests` invariants as `repo-guards` before it builds anything.

On failure - and on success, for the record - it uploads `report.json`, `page.log`, `app.log`,
`build.log` and `openbox.log` as the `linux-app-smoke` artifact. Every launch uses
`--identifier io.github.kevsmir02.codr.app-lab-ci` (a disposable profile under the fork identifier
in `src/modules/identity/namespace.json`; upstream's `app.crynta.terax.*` is refused), a private
`HOME` and private `XDG_*` tree under the output directory, and the app-lab preflight plus the
bench binary's own guard refuse anything else, so the job cannot touch a production profile even
on a self-hosted machine with one installed.
Reproduce locally with `pnpm profile:app:linux` (needs a real Fedora Wayland session; see
`docs/architecture/app-lab.md`).

## What must have a test

`CONTRIBUTING.md` requires a test for any change that touches behavior in these load-bearing paths:

- Shell / terminal spawn (what shell launches, with which cwd, env, and login flags)
- Workspace authorization (both the allow and deny side)
- Git command layer (repo-root resolution, pathspec/argument guards, status parsing)
- Filesystem mutation (atomic writes, symlink handling, no-data-loss on partial failure)
- IPC command surface and AI tool surface
- Pure logic with wide reach (cwd inheritance, tab/split tree transforms, OSC/prompt parsing, command guard)

The bar is real coverage of the contract, not a placeholder. Test the edge, the deny path, the "what happens one level above home".

## What does not need a test

UI rendering, themes, syntax-highlight tables, and anything the type-checker already guarantees do not need tests.

## Writing a good test

A good test locks the invariant you are relying on. Examples from the codebase:

- `src-tauri/src/modules/workspace.rs` `auth_tests` verify that an authorized path, a subdir of an authorized root, an unauthorized path, a missing path, and a symlink escape all behave correctly.
- `src-tauri/src/modules/pty/job.rs` tests verify that dropping the Job Object kills the assigned process tree on Windows.
- `src-tauri/src/modules/pty/session.rs` tests verify that dropping a `Session` kills the child process.
- `src-tauri/src/modules/pty/shell_init.rs` tests verify shell classification and WSL fish launch specs.
- `src/modules/ai/lib/security.ts` is exercised by tests that assert specific paths are refused and that canonicalization catches symlink traversal.

## Cross-platform PTY tests

Platform-specific behavior must be gated:

```rust
#[cfg(unix)]
fn shell_has_children(shell_pid: u32) -> bool { ... }

#[cfg(windows)]
fn shell_has_children(shell_pid: u32) -> bool { ... }
```

Tests for ConPTY/Job Object belong behind `#[cfg(windows)]`; tests for Unix PTY lifecycle belong behind `#[cfg(unix)]`. Do not assume a helper that works on one platform works on the other.

## Security function tests

When testing `src/modules/ai/lib/security.ts` or the Rust equivalents, cover:

1. The literal path is refused.
2. The canonicalized path is re-refused (symlink case).
3. Case variants match on case-insensitive filesystems.
4. NTFS alternate data streams and trailing dot/space variants are normalized.
5. Write-only deny prefixes block writes but allow reads where appropriate.

## Invariants

- A local fix with global blast radius must be caught by a test; review alone is not enough.
- Test the deny path and the edge, not just the happy path.
- Keep platform-specific tests behind the right `#[cfg(...)]` gate.

## See also

- [`TERAX.md`](../../TERAX.md) - the architecture source of truth
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) - quality bar, project layout, how to contribute
- [`docs/README.md`](../README.md) - index of contributor guides
