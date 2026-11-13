# Release trust: identity, signing key and verification

Status: **procedure and wiring implemented; no key is provisioned by this change.** The release
workflow can sign, the gate verifies signatures and refuses when they are missing, and the
maintainer has a script to generate the offline key. What does not exist yet is the key itself, so
`src/modules/updater/releaseContract.json` stays `"provisional": true` with an empty
`trust.publicKey` and the tagged-release gate keeps refusing every release. Provisioning the key is
a maintainer action, not a code change (issue #40 / breakdown ticket 39).

Nothing here enables a download or an install. Artifact authenticity is separate from native
package trust; the application still discovers a release and hands the transaction to the package
tool (`update-handoff.md`).

## What is trusted, and for what

| Item | Value | Where it lives |
| --- | --- | --- |
| Product name | `Terax Workspace` (unofficial fork of Terax) | `src/modules/identity/namespace.json` |
| Release owner / repository | `kevsmir02/terax-ai` | `releaseContract.json` (`endpoints`, ADR 0010) |
| Update endpoint | `https://github.com/kevsmir02/terax-ai/releases/latest/download/` | `releaseContract.json` |
| First stable line | `1.0.0` | `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` |
| Signing algorithm | minisign (Ed25519), envelope `Ed` or prehashed `ED` | this document |
| Trust root | one minisign **public** key: key id + fingerprint | `releaseContract.json` `trust.publicKey` |
| Secret key | passphrase-protected minisign secret, offline | maintainer custody, never this repository |

The fork publishes stable only. ADR
[0010](../adr/0010-publish-under-own-identity-and-trust.md) records why this identity and this key
model were chosen rather than upstream's or a managed package repository.

## What a version tag does

A `v<major>.<minor>.<patch>` tag starts `.github/workflows/release.yml`, which runs the gate twice
around a build:

1. **Before the build** — `scripts/release_gate.py --preconditions-only`: the tag agrees with the
   application version and is stable, every job `ci.yml` declares is green for exactly the tagged
   commit, and publication identity plus signing trust are decided.
2. **Build and stage** — `scripts/package-candidate/run.py` builds the RPM and DEB; the job stages
   them, the packaging `manifest.json`, `SHA256SUMS` and the Arch-facing `PKGBUILD` in
   `linux-packages/`.
3. **Sign** — `tauri signer sign` signs the exact staged bytes with the release key, and
   `scripts/release_signing.py` writes one `<artifact>.minisig` per artifact plus `latest.json`.
   With no key in the environment the step refuses by name (`signing-key-missing` /
   `signing-passphrase-missing`) instead of skipping.
4. **After signing** — `scripts/release_gate.py --candidate linux-packages` verifies the manifest
   and every signature against the staged hashes and the triggering commit.
5. **Upload** — the signed set leaves as a run-scoped workflow artifact.

There is no publication code path in this repository: no release object, no upload-to-release
action, no write permission while the contract is provisional. Creating the draft release and a
human publishing it belong to the release ticket (#45); the gate only decides.

## The signed set and the manifest

`latest.json` is `latest.json`-style (one schema for clients) and binds, for every artifact:

```json
{
  "version": "1.0.0",
  "channel": "stable",
  "notes": "…",
  "pub_date": "2026-11-13T00:00:00Z",
  "tag": "v1.0.0",
  "commit": "<40-hex triggering commit>",
  "signing": { "keyId": "D0E48EC629BB2484", "fingerprint": "sha256:…", "algorithm": "minisign" },
  "platforms": {
    "linux-x86_64":      { "url": "…/…_amd64.deb", "signature": "…", "size": 123, "sha256": "…", "format": "deb" },
    "linux-x86_64-rpm":  { "url": "…/….x86_64.rpm", "signature": "…", "size": 456, "sha256": "…", "format": "rpm" },
    "linux-x86_64-arch": { "url": "…/PKGBUILD",     "signature": "…", "size": 789, "sha256": "…", "format": "arch" }
  }
}
```

- `linux-x86_64` is the key the application's discovery reads and carries the DEB; the RPM and the
  Arch recipe are announced explicitly so no format is silently missing.
- Each `signature` is the minisign signature **file text** (the four-line envelope `minisign -S`
  writes), not a base64 wrap. Tauri's signer writes `<artifact>.sig` as base64; the signing script
  normalises it into `.minisig` and removes the wrap, so the published file is the one a user can
  check with the `minisign` tool.
- The trusted comment carries `file:<name>` and `version:<version>`. The version is signed, so a
  tampered manifest cannot announce a newer version over older signed bytes.
- Every entry is bound to the artifact's **sha256 and size**, and the gate checks them against the
  staged bytes *and* against the packaging runner's `manifest.json`.
- `latest.json` itself is not signed. Discovery trust is therefore structural, as
  `update-discovery.md` says: the signature proves the artifact bytes, and the gate only publishes a
  set whose manifest matches those bytes. Verifying the artifact at install time is a later,
  separate path; nothing here claims it exists.

The gate refuses, by name: `artifact-update-manifest-missing`, `-invalid`,
`artifact-update-version-mismatch`, `-commit-mismatch`, `-channel-mismatch`,
`artifact-update-artifact-missing`, `-artifact-uncovered`, `-checksum-mismatch`,
`artifact-signature-missing`, `-mismatch`, `-invalid`, `-key-mismatch`, `-version-mismatch`,
`-unverifiable`. Each one fails closed; none is a warning.

## Custody

The secret key is a **minisign** secret key file, passphrase-protected, generated offline:

- it never lives in this repository, in CI configuration, in a log, in a build cache or in an issue
  body; `scripts/tests/test_ci_workflows.py` scans every tracked file for a minisign secret key
  header;
- the maintainer holds the only copy, plus one encrypted offline backup whose location is recorded
  in their own password manager (not here);
- the passphrase is not stored with the key and is not a repository secret in its own right until
  the release job needs it;
- at release time the key and passphrase are injected as two repository secrets,
  `TERAX_RELEASE_SIGNING_KEY` and `TERAX_RELEASE_SIGNING_KEY_PASSPHRASE`, only for the signer step.
  `tauri signer sign` reads them; the key material is never echoed, never written into the
  checkout, and the workflow logs only the public key id and the artifact hashes;
- only the **public** key, its key id and its fingerprint are committed — in
  `releaseContract.json` (`trust.publicKey`, `trust.provisioned`) once provisioned. That file is the
  single source: the gate reads it, the signing script reads it and the application's contract reads
  it.

The cryptographic verification in the gate is `scripts/minisign.py`, a standard-library
implementation pinned in tests against a signature produced by the real `tauri signer sign` and
against the RFC 8032 test vector, so the verifier is not leaf-testing itself.

## Provisioning procedure (maintainer, once)

Run this on a machine you control, outside any checkout of this repository:

```sh
python3 scripts/provision_signing_key.py --directory ~/.config/terax-workspace/release-keys
```

What it does and refuses:

- generates a passphrase-protected minisign keypair with `minisign -G` (the standard format the
  release workflow's signer already reads) and sets the directory `0700`, the secret key `0600`;
- **refuses** a destination inside the repository (`destination-inside-repository`);
- **refuses** to overwrite an existing key (`key-already-exists`); there is no `--force`;
- **refuses** when `minisign` is missing (`provisioning-tool-missing`);
- prints only public material — public key file, key id, `sha256:` fingerprint — and never reads or
  prints the secret.

Then, as separate reviewed changes:

1. Commit the trust root: in `src/modules/updater/releaseContract.json` set
   `trust.provisioned = true` and `trust.publicKey` to the public key (the base64 value on the line
   after `untrusted comment:`, or base64 of the whole `.pub` file — both are accepted). Flipping
   `provisional` to `false` belongs to the same change, together with the endpoint decision it
   stands for.
2. Add the two repository secrets named above (release-time only).
3. Store the encrypted offline copy; record its location outside this repository.
4. Re-run the gate locally against a staged set to see `publishable: true` with your key.

`python3 scripts/provision_signing_key.py --inspect path/to/key.pub` reprints the key id and
fingerprint, which is what a reviewer compares against the committed value.

## Verification

A user, or a reviewer, verifies a downloaded artifact with the committed public key:

```sh
minisign -Vm terax-workspace_1.0.0_amd64.deb -p terax-workspace-release.pub
# or, from the manifest's signature text:
minisign -Vm PKGBUILD -x PKGBUILD.minisig -P <base64 public key>
```

What the gate verifies, in addition: the manifest names the triggering commit and application
version, every announced target points at a staged file, its sha256 and size match the staged bytes
(and the packaging record), the signature verifies under `trust.publicKey`, the key id matches the
committed one, the signed version matches the announced one, and the published `.minisig` is the same
signature as the manifest entry.

What the application verifies: structure and a provisioned trust root only
(`src/modules/updater/releaseSignature.ts`). With no provisioned key it reports
`check-failed (signature)` rather than offering a release. Install-time cryptographic verification
does not exist, because no install path exists.

## Offline recovery

The key is not derived from anything in this repository, so recovery means restoring the secret key
from its offline backup:

1. Restore the passphrase-protected key file and the passphrase from custody.
2. `python3 scripts/provision_signing_key.py --inspect key.pub` and compare the key id and
   fingerprint with `releaseContract.json`. **The key id must not change**: a changed id is a new
   trust root, not a recovery.
3. Confirm the key material by signing a throwaway file and verifying it with the committed public
   key (`minisign -Vm file -p key.pub`). Do not commit the throwaway signature.
4. Resume the release procedure. Nothing in the repository needs to change.

## Key loss and compromise

**Loss** (no copy of the secret survives): the current key can no longer sign. A release cannot be
published under it; the gate has nothing to verify against and refuses. Recovery is a **replacement**,
not a bypass:

1. Generate a new keypair with `provision_signing_key.py`.
2. Publish the new public key and fingerprint in a reviewed change to `releaseContract.json`
   (`trust.publicKey`, `trust.provisioned: true`), naming the old key id and the reason.
3. Tell readers in the release notes and the advisory surface that releases after `<version>` are
   signed by the new key id. Already-published artifacts stay verifiable under the old key, whose
   public key remains in the release history.
4. Never re-sign already-published bytes under a new key without saying so; a signature is a claim
   about who published those bytes.

**Compromise** (the secret or its passphrase leaked):

1. Stop publishing; treat every artifact signed after the earliest plausible compromise as
   untrusted.
2. Generate a replacement key, publish its public key as above, and state the compromise, the date
   and the key ids in the advisory.
3. Do not remove the old public key from history and do not add a fallback: verification of the old
   key must keep working for old artifacts, and nothing may silently accept a signature from the
   compromised key for new ones.
4. If an artifact was published by an attacker, say so; a signature that verifies under the old key
   is not evidence the maintainer published it.

Verification failure is never resolved by skipping the check: the gate refuses, the application
reports a signature failure, and the answer is a new signed release, not a bypass.

## What is not promised

- **Native package/repository trust.** No GPG-signed DNF/APT repository exists; managed repositories
  stay deferred. A valid minisign signature over an `.rpm` proves which bytes this project published,
  not that `dnf`/`apt` will trust or install them.
- **Install, upgrade, removal, dependency resolution or signature rejection by a package manager.**
  Those need real transactions on disposable systems (`update-handoff.md` lists what is unmeasured).
- **Build provenance.** A signature says the maintainer's key signed these bytes; it does not attest
  the CI runner, the toolchain, or that the source tree was clean beyond what the packaging manifest
  records.
- **The Arch recipe is built.** `PKGBUILD` is signed and announced as the Arch-facing artifact, but it
  is authored, not built: no `makepkg` run is claimed, here or in `linux-packages.md`.
- **Discovery-time authenticity.** The application's check is structural until an install path
  exists; only the artifact bytes carry a cryptographic claim.
- **A published release.** This change adds signing and verification. It publishes nothing, and no
  hosted run of the release workflow exists.

## The refusal that stays until the key exists

`releaseContract.json` is provisional, so `scripts/release_gate.py` refuses with
`publication-provisional`, `signing-trust-missing` and `signing-input-missing` before a build, and,
over a staged set, with `artifact-signature-unverifiable` because no trust root is provisioned.
Flipping the contract is the deliberate, reviewed change that lifts the first refusal; the gate still
requires a provisioned public key, a present signing input and signatures that verify. Until then the
tagged-release gate refuses, and that refusal is the correct behaviour rather than a missing feature.
