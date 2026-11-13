# Linux package candidates

Ticket #36 ("Workspace 35") produces *candidate* RPM and DEB artifacts from a recorded revision,
plus an authored Arch recipe, so the updater evaluation (#37) and graphical/package acceptance
(#44) have something concrete to install. A candidate is not a release and this document never
claims package-manager or graphical validation.

## What a version tag does: run the gate, publish nothing

A `v<major>.<minor>.<patch>` tag now starts `.github/workflows/release.yml`. It does not publish,
and this fork has never published. The tag starts a decision made by one script,
`scripts/release_gate.py`, which has no publish path at all — it can only answer and print why:

| Precondition | Refusal codes |
| --- | --- |
| Tag agrees with the application version and is a stable tag | `tag-version-mismatch`, `prerelease-tag`, `application-version-disagreement` |
| Every job `ci.yml` declares is green for *exactly* the tagged commit | `ci-evidence-missing`, `ci-commit-mismatch`, `ci-job-missing`, `ci-job-not-green` |
| Publication identity and signing trust are decided | `publication-provisional`, `publication-endpoint-missing`, `publication-endpoint-upstream`, `signing-trust-missing`, `signing-input-missing` |
| The staged set is the candidate built for that commit | `artifact-commit-mismatch`, `artifact-dirty-build`, `artifact-version-mismatch`, `artifact-missing`, `artifact-extra`, `artifact-checksum-mismatch`, `artifact-manifest-problem` |
| The signed manifest announces this commit, version and artifact set, and every signature verifies under the committed key | `artifact-update-manifest-missing`, `artifact-update-manifest-invalid`, `artifact-update-version-mismatch`, `artifact-update-commit-mismatch`, `artifact-update-channel-mismatch`, `artifact-update-artifact-missing`, `artifact-update-artifact-uncovered`, `artifact-update-checksum-mismatch`, `artifact-signature-missing`, `artifact-signature-mismatch`, `artifact-signature-invalid`, `artifact-signature-key-mismatch`, `artifact-signature-version-mismatch`, `artifact-signature-unverifiable`, `artifact-signing-trust-unreadable` |

The gate runs twice in one job, and the order is the invariant:

1. `--preconditions-only` runs **before** the build, so a tag or dispatch that fails the
   tag/version comparison, the green-CI requirement or the publication-input check fails the job
   **before any artifact exists**;
2. after staging **and signing**, `--candidate linux-packages` binds what would be published to an
   immutable identity: the triggering commit, the tag, the version, the sha256 of every artifact
   and in `SHA256SUMS`, a digest over all of them, and a minisign signature over each signed
   artifact that must verify under `releaseContract.json`'s committed public key. Missing, extra or
   substituted files are refusals, not warnings. The schema and identity rules are the packaging
   runner's own (`packaging.manifest_problems`), not a second copy.

Signing happens between the two stages (`.github/workflows/release.yml`):
`node_modules/.bin/tauri signer sign --app-version <version>` signs the staged `.rpm`, `.deb` and
`PKGBUILD`, and `scripts/release_signing.py` writes `<artifact>.minisig` plus `latest.json`. With no
signing secret in the environment the step refuses (`signing-key-missing` /
`signing-passphrase-missing`) rather than skipping. `docs/architecture/release-trust.md` owns trust,
custody, key replacement and what is *not* promised.

**Release gating status.** Publication identity, the independent minisign trust root (key ID
`94097B75DB498B21`), the GitHub Actions signing secrets, complete candidate assembly (#42),
final whole-app resource budgets (#43), and Fedora 45 KDE Wayland candidate validation (#44;
Fedora 44, Debian 13, and Arch Linux explicitly waived by the primary user on 2026-11-13 as
personal-tool extras) are settled. No stable release is published yet:

| Remaining gate | Owned by |
| --- | --- |
| The first public stable release and its support claims | issue #45 |

The release workflow remains non-publishing (`contents: read`/`checks: read`, no release-upload
action, and `scripts/release_gate.py` still refuses whenever CI evidence is missing, tags disagree,
signatures fail verification under the committed key, or signing secrets are absent).

**Exercising it safely.** No tag and no public release are needed:

```sh
# 1. before a build: the tag/version, CI and publication-input preconditions
python3 scripts/release_gate.py --tag v0.9.0 --commit "$(git rev-parse HEAD)" \
  --ci-status ci-status.json --preconditions-only --dry-run

# 2. sign a staged set and write its manifest (a fixture key here; the release workflow uses
#    `tauri signer sign` and --from-signatures instead)
TERAX_RELEASE_SIGNING_KEY="$(cat fixture-key.json)" \
  python3 scripts/release_signing.py --candidate linux-packages --version 0.9.0 \
  --tag v0.9.0 --commit "$(git rev-parse HEAD)"

# 3. over that staged set: the whole gate, including artifact identity and signatures
python3 scripts/release_gate.py --tag v0.9.0 --commit "$(git rev-parse HEAD)" \
  --ci-status ci-status.json --candidate linux-packages --dry-run \
  --report gate-report.json

# 4. the same thing in CI: dispatch the workflow with `dry_run: true`
```

`--dry-run` prints the decision (JSON on stdout, a human refusal list on stderr, a markdown table
into `$GITHUB_STEP_SUMMARY`) and exits 0 even when it refuses; without it, a refusal exits 3 and
fails the job. Neither mode publishes anything. The signing input is reported as present or
missing and its value is never read into a log, report or summary.

Validated here: the gate's refusals and the identity it binds, unit-tested with fixtures (matching
tag, mismatched tag, prerelease tag, missing/extra/substituted artifact, wrong commit, missing CI
job, non-green CI, missing signing input, unsettled/settled contract, missing or tampered
`latest.json`, and signatures that are missing, from another key, over other bytes or bound to
another version), plus the signer and the provisioning script. The verifier
(`scripts/minisign.py`) is pinned against a signature produced by the real `tauri signer sign` and
against RFC 8032's test vector, and the workflow order is pinned by the guard test. **Not
validated:** a real hosted run of the workflow itself (no tagged release has been run through
GitHub Actions yet), and any publication (that is #45's job).

Updates are never installed by the application. A user installs or upgrades the RPM/DEB with
their package manager (`dnf`, `apt`); the application never downloads, installs or restarts
itself, and no workflow here promises otherwise.


## Package identity (`Codr`)

The fork's publication identity lives in one table, `src/modules/identity/namespace.json`
(see [namespace isolation](namespace-isolation.md)). Its `packaging` block is the single source
of the package identity; the Tauri bundle metadata is aligned with it:

| Field | Value | Where it lands |
| --- | --- | --- |
| `productName` | `Codr` | window/bundle product name -> kebab package name `codr` |
| `vendor` | `kevsmir02` | deb `Maintainer` / rpm `Vendor` |
| `packageName` | `codr` | rpm/deb `Name`, `mainBinaryName`, `/usr/bin/codr` |
| `cliBinaryName` | `codr-cli` | installed sidecar `/usr/bin/codr-cli` |
| `appIdentifier` | `io.github.kevsmir02.codr` | Tauri identifier (storage/WebKit namespace) |

The names deliberately differ from upstream `Terax` / `Crynta` / `app.crynta.terax` and from the
upstream package paths `/usr/bin/terax`, `/usr/bin/terax-cli`, so a package can be installed
next to an upstream build without owning the same files.

The *CLI command* exposed inside terminal sessions is still `terax`
(documented deferral in [namespace isolation](namespace-isolation.md)); only the installed
sidecar file moved.

## Reproduce

```sh
pnpm package:candidate:dry-run   # effective config + planned artifact names, no build
pnpm package:candidate           # build rpm+deb, write dist-packages/<pkg>-<ver>-<rev>/
```

`.github/workflows/release.yml` runs `python3 scripts/package-candidate/run.py` — on a `v*` tag
and on `workflow_dispatch` — so a candidate built in CI and a candidate built locally come from
the same code path and carry the same identity. Either trigger still passes the publication gate
above before anything is built.

The runner (`scripts/package-candidate/run.py`) refuses to start when any of these is true:

- the host is not Linux/x86_64 (no `aarch64`, macOS or Windows output);
- it runs as root, or `rpm` is missing (the artifact could not be verified back);
- the working tree is dirty (artifacts must correspond to a recorded commit);
- the identity is an upstream name, the product name does not derive the declared package name,
  the bundle targets are not exactly `rpm`+`deb` (no AppImage/NSIS/MSI/DMG),
  `createUpdaterArtifacts` is not `false`, or the effective updater endpoint/pubkey does not
  follow the fork-owned release contract (`src/modules/updater/releaseContract.json`) or points
  at upstream's feed;
- the deb/rpm dependency lists lack WebKitGTK or GTK3;
- the Arch recipe's `pkgver`/`pkgname`/`arch`/`_commit`/`depends` do not line up;
- the output directory already holds a completed candidate (outputs are immutable).

The runner builds with `pnpm tauri build --target x86_64-unknown-linux-gnu --bundles rpm,deb` and a
generated overlay (`inputs/tauri.candidate.conf.json`) so the base config's resources, CSP, icons
and file associations are inherited rather than duplicated. Tauri CLI appends the Linux runtime
dependencies itself (`libwebkit2gtk-4.1-0` plus `libgtk-3-0` for deb, the matching sonames for
rpm), so the bundle config does not repeat them — repeating one produced a duplicated control
field in the first real build. The rpm config also names the Fedora packages
`webkit2gtk4.1`/`gtk3`. Debian 13's time_t transition renamed GTK to `libgtk-3-0t64`, which
Provides `libgtk-3-0`, so the appended dependency resolves there; the guard refuses a config that
repeats the injected names. The dependency lists were not resolved by dnf/apt here.

It never installs a package, never calls `sudo`/`dnf`/`apt`, and executes only the packaged CLI —
with a disposable `HOME`/`XDG` profile under the run output.

## What a candidate records

`dist-packages/<package>-<version>-<shortrev>/` contains:

- `codr-<version>-<release>.x86_64.rpm`, `codr_<version>_amd64.deb`
  (read-only, stable names, never rewritten);
- `SHA256SUMS`;
- `manifest.json` — the machine-readable record: revision, host, toolchain, hashed build inputs,
  artifact hashes/sizes, declared and observed dependencies, every packaged file with role/mode/
  sha256, the bundled binaries, resource/licence inventory, and the validation status of each
  stage;
- `build.log`, `evidence/` (deb control fields, `rpm -qip`, `rpm -qlp`), `inputs/` (the overlay),
  `sources/` (a `git archive` tarball of the revision) and `arch/PKGBUILD` (the recipe pinned to
  that revision and source hash).

A candidate directory is not a release. The release job stages the two packages, `manifest.json`,
`SHA256SUMS` and `arch/PKGBUILD` into `linux-packages/`, signs them (`<artifact>.minisig`) and
writes `latest.json`; it adds no build log, evidence or source tarball to the published set.

A failed run still writes `manifest.json`, with `validation.build.status = "failed"`, the failing
stage, exit code and the log tail. A missing directory is therefore not the failure signal.

## Proven and not proven

Proven by candidate build and Fedora 45 validation (`82af7938d3df`, `dist-packages/codr-1.0.0-82af7938d3df/`):

- Both artifacts built cleanly from clean revision `82af7938d3df`: `codr-1.0.0-1.x86_64.rpm` (`9,613,139` bytes, sha256 `d45e93355698b0c3a4869f47dda8d6b7d35064b6cc8a8152f375b60b363095e8`) and `codr_1.0.0_amd64.deb` (`9,611,640` bytes, sha256 `604bbad2792cb57eeb755c7ef552785166572650a53e6c3545204c65eef5aabc`), plus pinned `arch/PKGBUILD` and `SHA256SUMS`.
- Deb control fields (`Package: codr`, `Version: 1.0.0`, `Architecture: amd64`, `Depends: libwebkit2gtk-4.1-0, libgtk-3-0`) and RPM headers agree with the candidate identity; both extracted payloads carry identical file paths and hashes (apart from the main binary's Tauri bundle-type marker); license resources are present.
- Fedora 45 host RPM resolution (`scripts/package-candidate/validate_fedora.py`): all non-`rpmlib` RPM requirements (`webkit2gtk4.1`, `gtk3`, `libwebkit2gtk-4.1.so.0()(64bit)`, `libgtk-3.so.0()(64bit)`) resolve to installed Fedora 45 packages (`webkit2gtk4.1-2.54.2-1.fc45.x86_64`, `gtk3-3.24.52-6.fc45.x86_64`), `rpm -K` confirms `digests OK` (unsigned RPM, as native repo signing is deferred), and `rpm -ql terax` vs `rpm -qlp codr-1.0.0-1.x86_64.rpm` confirms 11/11 paths are disjoint from the installed `terax-0.9.0-1.x86_64` package.
- Live Fedora 45 KDE Wayland packaged smoke (`validate_fedora.py`): extracted `/usr/bin/codr` launches in an isolated profile on `wayland-1`, publishes `$XDG_CACHE_HOME/codr/control.json`, spawns a PTY (`pty opened id=1`), responds to packaged `/usr/bin/codr-cli` (`identify`, `--version`, `ping`, `capabilities`, `open` at line 2) with exit 0 and `ok: true`, and leaves all seeded upstream `terax` sentinel files untouched (`sentinelProblems: []`).
- Clean Fedora 45 container transaction check (`validate_fedora.py --container` on `registry.fedoraproject.org/fedora:45`): `dnf -y --disablerepo='*' install` refuses installation due to missing `webkit2gtk4.1` and `gtk3`, RPM 6 rejects unsigned `rpm -ivh --nodeps` (`does not verify: no signature`), and `rpm -ivh --nodeps --nosignature`, `codr-cli --version`, `rpm -Uvh --replacepkgs --nodeps --nosignature`, and `rpm -e codr` all succeed cleanly.
- Real-app WebKitGTK acceptance on `82af7938d3df` (Fedora 45 KDE Wayland): `app-lab` `--scenario candidate` (`12/12`), `--scenario preview` (`44/44`, PDF reader + web preview teardown), `--scenario images` (`14/14`, PNG/JPEG/GIF/WebP/BMP/ICO/AVIF + refusals), and `--scenario media` (`24/24`, MP4/M4A/MOV/WebM/OGG/WAV/MP3/FLAC/AAC + unsupported refusal), all with `coexistence PASS`; `TERAX_VISUAL_SOFTWARE=1 TERAX_VISUAL_RENDERERS=webgl` scaling check passed at DPR 1, 1.25, 1.5, and 2 (`0` differing pixels); bash/zsh/fish shell integration tests passed on Fedora 45.

Not proven or waived:

- Fedora 44, Debian 13 (graphical WebKitGTK), and dated clean Arch (`makepkg`/`pacman`) were explicitly waived by the primary user on 2026-11-13 as personal-tool extras beyond Fedora 45; no `.deb` install or Arch build was executed here.
- Host-root `sudo dnf install/upgrade/remove` of `codr-1.0.0-1.x86_64.rpm`, native DNF/APT repository GPG signing (artifacts use `.minisig` instead; see [release trust](release-trust.md)), updater discovery/handoff against a published release (#45), physical keyboard/IME/OS clipboard round-trip, and live vendor CLI turn/hook-trust certification remain unverified or manual checks.

## Arch recipe

`packaging/arch/PKGBUILD` builds the same source revision and version (`pkgver` matches Tauri,
package.json and Cargo.toml) and installs the same paths as the RPM/DEB candidates. It is
**authored, not built**: this host has no `makepkg`, and Arch validation was waived for this personal tool. The packaging runner writes a revision-pinned copy
(with the real source-archive hash) next to the artifacts.

## Known gaps

- Update discovery (issue #37) now points at the settled `kevsmir02/terax-ai` stable release feed
  with provisioned minisign trust root (`94097B75DB498B21`). Candidates keep
  `bundle.createUpdaterArtifacts=false` because the bundler's updater payloads are not this fork's
  release artifacts; authenticity comes from the post-build minisign step
  (`scripts/release_signing.py`). The tagged-release gate (`scripts/release_gate.py`) verifies all
  signatures against that committed public key; publishing the first release is issue #45.
- Native DNF/APT repository signing remains deferred: packages carry `.minisig` signatures rather
  than RPM/APT repository metadata signatures (see [release trust](release-trust.md)).

## Evidence and checks

- `scripts/tests/test_packaging.py` guards the identity, target set, dependency lists, manifest
  schema, deb reader (no `dpkg`) and Arch recipe alignment.
- `scripts/tests/test_release_gate.py` exercises every refusal of the publication gate and the
  identity it binds, with fixtures for a matching tag, a mismatched tag, a prerelease tag, a
  missing/extra/substituted artifact, a wrong commit, missing and non-green CI, and the
  provisional and settled release contract.
- `scripts/tests/test_validate_fedora.py` guards the Fedora 45 RPM dependency-resolution parser,
  upstream path-disjointness check, signature parser, and CLI probe evaluator;
  `scripts/package-candidate/validate_fedora.py` runs the live Fedora 45 RPM and Wayland graphical
  smoke checks.
- `scripts/packaging.py` holds the derivation, inspectors and manifest schema;
  `scripts/package-candidate/run.py` is the runner.
