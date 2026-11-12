# Linux package candidates

Ticket #36 ("Workspace 35") produces *candidate* RPM and DEB artifacts from a recorded revision,
plus an authored Arch recipe, so the updater evaluation (#37) and graphical/package acceptance
(#44) have something concrete to install. A candidate is not a release and this document never
claims package-manager or graphical validation.

## Private candidate identity

The fork's working identity lives in one table, `src/modules/identity/namespace.json`
(see [namespace isolation](namespace-isolation.md)). Its `packaging` block is the single source
of the candidate identity; the Tauri bundle metadata is generated from it:

| Field | Candidate value | Where it lands |
| --- | --- | --- |
| `productName` | `Terax Workspace` | window/bundle product name → kebab package name `terax-workspace` |
| `vendor` | `Terax Workspace Candidate` | deb `Maintainer` fallback / rpm `Vendor` |
| `packageName` | `terax-workspace` | rpm/deb `Name`, `mainBinaryName`, `/usr/bin/terax-workspace` |
| `cliBinaryName` | `terax-workspace-cli` | installed sidecar `/usr/bin/terax-workspace-cli` |
| `appIdentifier` | `dev.terax-workspace.fork` | Tauri identifier (storage/WebKit namespace) |

The names deliberately differ from upstream `Terax` / `Crynta` / `app.crynta.terax` and from the
upstream package paths `/usr/bin/terax`, `/usr/bin/terax-cli`, so a candidate can be installed
next to an upstream build without owning the same files. Final branding, release owner and keys
remain tickets #39/#40; the table is marked `provisional`.

The *CLI command* exposed inside terminal sessions is still `terax`
(documented deferral in [namespace isolation](namespace-isolation.md)); only the installed
sidecar file moved.

## Reproduce

```sh
pnpm package:candidate:dry-run   # effective config + planned artifact names, no build
pnpm package:candidate           # build rpm+deb, write dist-packages/<pkg>-<ver>-<rev>/
```

The runner (`scripts/package-candidate/run.py`) refuses to start when any of these is true:

- the host is not Linux/x86_64 (no `aarch64`, macOS or Windows output);
- it runs as root, or `rpm` is missing (the artifact could not be verified back);
- the working tree is dirty (artifacts must correspond to a recorded commit);
- the identity is an upstream name, the product name does not derive the declared package name,
  the bundle targets are not exactly `rpm`+`deb` (no AppImage/NSIS/MSI/DMG),
  `createUpdaterArtifacts` is not `false`, or the overlay does not strip the upstream updater
  endpoint/pubkey;
- the deb/rpm dependency lists lack WebKitGTK or GTK3;
- the Arch recipe's `pkgver`/`pkgname`/`arch`/`_commit`/`depends` do not line up;
- the output directory already holds a completed candidate (outputs are immutable).

The runner builds with `pnpm tauri build --target x86_64-unknown-linux-gnu --bundles rpm,deb` and a
generated overlay (`inputs/tauri.candidate.conf.json`) so the base config's resources, CSP, icons
and file associations are inherited rather than duplicated. Runtime dependencies live in the base
config (`src-tauri/tauri.conf.json`): `webkit2gtk4.1`/`gtk3` for rpm and
`libwebkit2gtk-4.1-0`/`libgtk-3-0t64 | libgtk-3-0` for deb (Debian 13's time_t transition renamed
GTK; the alternative covers Debian 12 as well). The overlay deliberately does not repeat arrays,
because Tauri's config merge concatenates them — listing `depends` twice produced a duplicated
control field. The dependency lists were not resolved by dnf/apt here.

It never installs a package, never calls `sudo`/`dnf`/`apt`, and executes only the packaged CLI —
with a disposable `HOME`/`XDG` profile under the run output.

## What a candidate records

`dist-packages/<package>-<version>-<shortrev>/` contains:

- `terax-workspace-<version>-<release>.x86_64.rpm`, `terax-workspace_<version>_amd64.deb`
  (read-only, stable names, never rewritten);
- `SHA256SUMS`;
- `manifest.json` — the machine-readable record: revision, host, toolchain, hashed build inputs,
  artifact hashes/sizes, declared and observed dependencies, every packaged file with role/mode/
  sha256, the bundled binaries, resource/licence inventory, and the validation status of each
  stage;
- `build.log`, `evidence/` (deb control fields, `rpm -qip`, `rpm -qlp`), `inputs/` (the overlay),
  `sources/` (a `git archive` tarball of the revision) and `arch/PKGBUILD` (the recipe pinned to
  that revision and source hash).

A failed run still writes `manifest.json`, with `validation.build.status = "failed"`, the failing
stage, exit code and the log tail. A missing directory is therefore not the failure signal.

## Proven and not proven

Proven by a run: both artifacts exist at the recorded revision and hash; the deb control fields
(`Package`, `Version`, `Architecture`, `Depends`) and the rpm header agree with the candidate
identity; the extracted payloads carry the same paths and hashes in both formats; the installed
CLI executes (`--help`) from the extracted deb; the licence resources are present.

Not proven — recorded in `manifest.json` under `notValidated`: install/upgrade/remove with a real
package manager, the graphical application started from a package on Fedora 44 KDE Wayland,
Debian 13 WebKitGTK behaviour, dependency resolution by dnf/apt/pacman, signature/trust, updater
discovery and installation (#37), and coexistence with an installed upstream build. Package
extraction is not runtime certification.

## Arch recipe

`packaging/arch/PKGBUILD` builds the same source revision and version (`pkgver` matches Tauri,
package.json and Cargo.toml) and installs the same paths as the RPM/DEB candidates. It is
**authored, not built**: this host has no `makepkg`, and the spec requires a dated clean Arch
environment that records package versions. The packaging runner writes a revision-pinned copy
(with the real source-archive hash) next to the artifacts.

## Known gaps

- The frontend Linux update check still queries upstream's GitHub release feed in this revision;
  fork-owned discovery is issue #37. Candidate builds strip the updater plugin's endpoint and
  pubkey and use `createUpdaterArtifacts=false`, so a candidate can neither fetch upstream's
  release feed nor verify/install an artifact with the upstream key.
- The deb `Maintainer` field is derived by the bundler from the Cargo authors (upstream credit),
  not from the candidate vendor; final maintainer identity belongs to #39/#40.

## Evidence and checks

- `scripts/tests/test_packaging.py` guards the identity, target set, dependency lists, manifest
  schema, deb reader (no `dpkg`) and Arch recipe alignment.
- `scripts/packaging.py` holds the derivation, inspectors and manifest schema;
  `scripts/package-candidate/run.py` is the runner.
