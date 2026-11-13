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

**Release gating status.** Publication identity and the independent minisign trust root (key ID
`94097B75DB498B21`) are settled in `src/modules/updater/releaseContract.json` (`"provisional": false`)
and `src/modules/identity/namespace.json`. No stable release is published yet:

| Remaining gate | Owned by |
| --- | --- |
| Upload signing secrets (`TERAX_RELEASE_SIGNING_KEY` and passphrase) into GitHub Actions secrets | Maintainer before tagging |
| A candidate validated on Fedora, Debian and Arch | issue #44 |
| A complete candidate with the retained workflows verified | issue #42 |
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

Proven by a run: both artifacts exist at the recorded revision and hash; the deb control fields
(`Package`, `Version`, `Architecture`, `Depends`) and the rpm header agree with the candidate
identity; the extracted payloads carry the same paths and hashes in both formats; the installed
CLI executes (`--help`) from the extracted deb; the licence resources are present.

Not proven — recorded in `manifest.json` under `notValidated`: install/upgrade/remove with a real
package manager, the graphical application started from a package on Fedora 44 KDE Wayland,
Debian 13 WebKitGTK behaviour, dependency resolution by dnf/apt/pacman, native package/repository
signature trust (the artifacts carry minisign signatures, which `dnf`/`apt` do not consume; see
[release trust](release-trust.md)), updater discovery and installation (#37), and coexistence with
an installed upstream build. Package extraction is not runtime certification.

## Arch recipe

`packaging/arch/PKGBUILD` builds the same source revision and version (`pkgver` matches Tauri,
package.json and Cargo.toml) and installs the same paths as the RPM/DEB candidates. It is
**authored, not built**: this host has no `makepkg`, and the spec requires a dated clean Arch
environment that records package versions. The packaging runner writes a revision-pinned copy
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
- `scripts/packaging.py` holds the derivation, inspectors and manifest schema;
  `scripts/package-candidate/run.py` is the runner.
