# Upstream imports: the remote layout, the procedure and its refusals

The fork keeps a working Linux application while upstream Terax keeps moving. Fixes arrive by
**selective import** - one reviewed upstream commit at a time - not by merging an unrelated branch
wholesale, which is the decision recorded in
[ADR 0002](../adr/0002-linux-scope-with-selective-upstream-imports.md). Removing non-Linux
platform support does not remove the compatibility seams that keep an import cheap.

`scripts/upstream-import/run.py` is the procedure. `scripts/tests/test_upstream_import.py` runs the
refusals against two scratch repositories (a real cherry-pick, a real conflict), so the behaviour
does not depend on this machine. The maintenance cadence that calls it is
[dependency-updates.md](dependency-updates.md).

## The remote layout

| Remote | URL | Role |
| --- | --- | --- |
| `origin` | `git@github.com:kevsmir02/terax-ai.git` | this fork. `git push` lands here |
| `upstream` | `https://github.com/crynta/terax-ai.git` | the upstream project. Fetch and import only |

Both must exist and must be **different projects**. The procedure refuses:

- a missing `upstream` remote (it is added by the procedure, never guessed);
- an `upstream` that points at the fork: importing from your own fork looks like an upstream
  import and brings nothing upstream;
- an `origin` that *is* the upstream project: a `git clone` of `crynta/terax-ai` has no fork to
  push to, and a push from this checkout would publish to someone else's project;
- an existing `upstream` with a different URL. It is reported, never rewritten: changing a remote
  is a deliberate act, and this procedure is not the place to hide it.

`origin` is only ever read. Setting up the upstream remote is additive and idempotent:

```sh
python3 scripts/upstream-import/run.py --setup-upstream --fetch
python3 scripts/upstream-import/run.py --verify --fetch --output <evidence-dir>
```

A remote is never trusted because it is configured. `--verify` asks `git ls-remote` for the
upstream branch head, records the merge base with the current branch and how many upstream commits
have not been imported, and writes `upstream-verify.json`. If the remote cannot be reached, the
connectivity gate is **unverified** and the run does not report success - an unreachable remote is
not the same as an unchanged one.

## Verified against the real upstream (2026-11-12)

```sh
python3 scripts/upstream-import/run.py --setup-upstream --fetch   # added upstream, fetched main
python3 scripts/upstream-import/run.py --verify --output <evidence-dir>
```

```
origin   : kevsmir02/terax-ai
upstream : crynta/terax-ai (https://github.com/crynta/terax-ai.git)
pass       upstream     upstream crynta/terax-ai, fork origin kevsmir02/terax-ai
pass       connectivity `git ls-remote --heads upstream main` returned b2ddeecca0783b0bdbe090c9f31fb81c773ed46d
pass       drift        merge base cb48a34, 135 commits ahead, 2 upstream commits not imported
report: upstream-verify.json
VERIFIED
```

The two upstream commits not imported at that revision were both dependency bumps
(`build(deps): bump the github-actions group ... (#1462)` and
`build(deps): bump the cargo group ... (#1463)`); they are read in the monthly review like any
other upstream change. Recording the range is the point: "we are on upstream" is not evidence, a
revision, a merge base and a count are.

## The procedure

1. **Setup** - `--setup-upstream --fetch`. Additive; the fork's `origin` is never modified.
2. **Fetch** - `git fetch --no-tags upstream main`.
3. **Review** - `git log --oneline HEAD..upstream/main`, then `git show <sha>` for each candidate.
   Import the fixes this fork needs, not a whole branch.
4. **Import** - `python3 scripts/upstream-import/run.py --import <sha>`. It creates
   `upstream-import/<short sha>`, then runs `git cherry-pick -x <sha>`, so the imported commit
   records the upstream commit it came from.
5. **Conflict** - the run stops with exit status 3, lists the conflicted paths and leaves the
   cherry-pick in progress. Resolve by hand against this fork's scope, then
   `git add <paths> && git cherry-pick --continue`, or `git cherry-pick --abort` to return to the
   pre-import branch. A conflict is never resolved by taking one side wholesale: that is how a
   Linux narrowing is silently undone.
6. **Gates** - types, lint, format check, the frontend suite, the repository guards, and the pinned
   Ghostty revision check (`scripts/ghostty-update/run.py --check`, ticket #32). A change under
   `src-tauri/` adds `cargo nextest run --locked` and
   `cargo clippy --all-targets --locked -- -D warnings`; a change under `packages/ghostty-core/`
   **rebuilds both artifacts** with `scripts/ghostty-update/run.py --rebuild`, which also re-runs
   the compatibility, soak, benchmark and whole-app resource gates.
7. **Rebuild** - a terminal-core import is not a drop-in binary update. The rebuild gate is what
   proves the artifacts still come from the pinned source; the provenance in `UPSTREAM.md` and the
   artifact bytes change in the same reviewed change.
8. **Land** - review the branch, merge it locally, delete the import branch. The procedure never
   pushes anything: a test asserts that no `git push` (and no `--force`) is executed by an import,
   and publishing stays a deliberate maintainer action.

## Refusals worth knowing

| Situation | Behaviour |
| --- | --- |
| Uncommitted changes | refused; the paths are named. An import branch must not carry work that is not part of the imported commit |
| Commit not reachable from `upstream/main` | refused; only upstream commits are imported, not local or fork commits |
| Commit already imported | refused; `-x` provenance makes a duplicate visible |
| Import branch already exists | refused; finish, merge or delete it first |
| Conflict | stopped with the paths listed, cherry-pick left in progress |
| Unreachable `upstream` | `--verify` reports unverified, never "checked" |
| `upstream` pointing at the fork, or `origin` pointing at upstream | refused before anything is mutated |

## Demonstrated on a real upstream commit (2026-11-12)

`e6a3480` (`build(deps): bump the github-actions group ... (#1462)`) was imported into a throwaway
clone of this branch. The cherry-pick applied cleanly to the fork's rewritten `.github/workflows/ci.yml`
(4 lines: `actions/cache` v5 to v6, `taiki-e/install-action` 2.87.30 to 2.90.1), the commit message
carries `(cherry picked from commit e6a34806362144750045c7cf3501786ce2c8589a)`, and the run ended
`refused` because the **format** gate failed - `src/` has 20 files that are not biome-format-clean
at the integration tip, unrelated to the import. That is the pipeline working: an import does not
merge because it applied, only because the gates pass. `pnpm format` is deliberately never run
here (it would rewrite ~119 files); that drift needs its own change before an import can land.

The other upstream commit at this revision (`b2ddeec`, a cargo group bump) also applied cleanly and
then exercised the `src-tauri/` tier: `cargo nextest` is not installed on this workstation (CI
installs it), and `cargo clippy --all-targets --locked -- -D warnings` fails on two pre-existing
`needless_borrows_for_generic_args` errors in `src-tauri/src/modules/identity.rs` at the tip as
well, so a Rust import is gated on that fix rather than on the import. Both clones were deleted;
no import branch was pushed or merged into this branch.

## What an import must not do

- It must not bring non-Linux platform support back (that is what the retained seams are for: an
  inert adapter stays portable, a workflow matrix does not).
- It must not remove a retained feature because upstream moved it. The removed-feature boundary is
  the spec's, not upstream's.
- It must not land unreviewed: the gates above run before the branch is merged, and a terminal-core
  import additionally re-records the soak/benchmark/resource evidence.
- It must not push, force or rewrite history anywhere: an import must never push a branch, a tag or
  a ref, and the procedure has no push step at all.
