# Update discovery (fork-owned, no install)

Status: **discovery and package-tool handoff implemented; release endpoint and trust root
provisioned (`Codr` / `94097B75DB498B21`).** Nothing here downloads a package, installs one,
prompts for privilege or relaunches the application (`update-handoff.md`).

## What this build is allowed to do

Discovery only, enforced in two independent places:

| Layer | Today |
| --- | --- |
| Code | `checkForUpdate` GETs the manifest endpoint with `fetch`; `requestDownload` requires approval and returns `not-implemented` (ticket #39). |
| Tauri capability | `src-tauri/capabilities/desktop.json` grants **no** `updater:` permission, so no window can call the plugin's `check`, `download`, `install` or `download_and_install` command. |

The updater plugin is still initialized in `src-tauri/src/lib.rs`, and its blanket set
(`updater:default`) expands to `allow-check`, `allow-download`, `allow-install` and
`allow-download-and-install` (the crate's own `permissions/default.toml`). Granting that set
exposes an install command that no gated path can justify, so the shipped capability does not
carry it. `scripts/tests/test_capabilities.py` parses the capability files and the plugin's
permission list and fails if any window is granted an updater command again — including a
`updater:allow-check` grant, because discovery does not use the native plugin at all.

Removing the grant is not a substitute for #39. When the readiness recheck, package-tool handoff
and privilege interval exist, #39 adds the one narrow permission that path needs *and* updates
that test in the same change; the test is what makes a re-grant a deliberate, reviewed decision.

## Release contract

`src/modules/updater/releaseContract.json` is the single source of the fork's release channel:

- `endpoints`: `https://github.com/kevsmir02/terax-ai/releases/latest/download/latest.json`;
- `channel`: `stable` only;
- `trust.provisioned`: `true` with Codr's minisign public key (`keyId` `94097B75DB498B21`,
  `fingerprint` `sha256:a02fd6ac492d1f070919bde106c20c0a376fbcdb6db8bc4c17ca0efd68197487`);
- upstream's feed (`crynta/terax-ai` releases) is recorded only so code and tests can refuse it.
  `src-tauri/tauri.conf.json` mirrors this contract (`endpoints` and `pubkey`) without using the
  native updater plugin at runtime (discovery does not call `plugin-updater`).

`src/modules/updater/contract.ts` resolves the contract. In a development build only, the
`VITE_CODR_UPDATE_ENDPOINT` environment variable can point the check at an isolated fixture
endpoint, and only a loopback endpoint is accepted. Production builds ignore it.
`pnpm dev:update-fixtures` serves `src/modules/updater/fixtures` on `127.0.0.1:8787`
(`/stable.json`, `/stable-current.json`, `/stable-bad-signature.json`, `/stable-prerelease.json`,
plus `/rate-limited`, `/offline`, `/malformed` failure routes). No route serves a package.

## Tagged releases: a gate that refuses, not a publish

`src/modules/updater/releaseContract.json` is also the gate's only source for publication identity
and trust. `.github/workflows/release.yml` is started by a `v<major>.<minor>.<patch>` tag or by
`workflow_dispatch`, and its first step is `scripts/release_gate.py --preconditions-only`: tag
agrees with the application version (stable only), every job `ci.yml` declares is green for that
exact commit, and publication identity plus signing trust are decided. Only then does the job
build, sign the staged artifacts with the maintainer's minisign key, write the stable `latest.json`,
and run the second gate stage, which binds the staged artifacts to the triggering commit, their
sha256 and a signature that must verify under the committed public key.

Today the third precondition cannot hold, so a tag fails loudly before any artifact is produced
and nothing is published anywhere — the workflow has no write permission, no release-upload action
and no way to publish, and the gate has no publish code path. The one secret it reads is the
release signing key, injected for the signer step only; without it the signer refuses by name
(`signing-key-missing`). The refusal names each missing input and the ticket that supplies it;
`docs/architecture/linux-packages.md` carries the full table; trust, custody, verification and key
replacement are `docs/architecture/release-trust.md`:

| Missing input | Ticket |
| --- | --- |
| Release owner/URL, final identity, signing key and its trust root | #40 (breakdown ticket 39) |
| Candidate validated on Fedora, Debian and Arch | #44 |
| Complete candidate with retained workflows verified | #42 |
| First public stable release, support claims | #45 |

The gate and its refusals are implemented and unit-tested (`scripts/tests/test_release_gate.py`);
the workflow's own hosted run and any publication are not, and are not claimed. Flipping
`provisional` to `false` in the contract is the deliberate change that relaxes the guard test in
`scripts/tests/test_ci_workflows.py` — after which the gate still refuses a placeholder endpoint,
an unprovisioned trust root or a missing signing input.

## Check behavior

`checkForUpdate` GETs only the manifest endpoint, with:

- an 8 s timeout per attempt (contract `check.timeoutMs`);
- at most 3 attempts (contract `check.attempts`);
- exponential backoff capped at 8 s, and `Retry-After` capped at 30 s;
- no retry for payload, channel, target, signature or non-429 4xx failures.

It settles into one of three outcomes:

| Outcome | Meaning |
| --- | --- |
| `no-update` | The stable manifest is not newer than the running version. |
| `available` | A newer stable release exists, its envelope passed inspection and an explicit verifier accepted it. |
| `failed` | Check failed: `offline`, `timeout`, `rate-limited`, `server-error`, `bad-payload`, `unsupported-channel`, `unsupported-target`, `signature`, `no-endpoint`, `misconfigured`. |

Artifact trust at discovery time checks structure and key identity: a valid minisign envelope,
a trusted comment that names the announced version, a provisioned trust root, and an 8-byte key ID
matching `trust.publicKey`. Because discovery never downloads the artifact bytes, full Ed25519/
BLAKE2b verification over the package payload happens in `scripts/release_gate.py` before
publication (and offline via `minisign -Vm` before manual installation). Production discovery fails
closed (`check-failed: signature`) on unprovisioned keys, malformed envelopes, version mismatches,
or mismatched key IDs. A development build against loopback fixtures labels releases
`fixture-unverified`, and the UI says so.

Release *production*, unlike discovery, does verify cryptographically: the release gate checks every
announced artifact's signature against the committed public key before a release could be published
(`docs/architecture/release-trust.md`). A published `latest.json` and its `.minisig` files are what
that gate accepted; the application still never downloads the payload itself.

Automatic checks run at most once per `check.intervalMs` (6 h), tracked under the fork's
namespaced key (`codr:updater:last-check`). An explicit user check bypasses the throttle. The hook
never blocks the UI and never downloads.

## Install handoff (implemented; the app still never installs)

The supported upgrade path is the accepted **package-tool handoff after safe closure**;
`docs/architecture/update-handoff.md` records that decision, what it does and does not
guarantee, and how issue #39 consumes it.

The app discovers the release and stops. `requestDownload` still requires explicit
approval and returns `not-implemented` for a download: no capability grants `updater:*`,
nothing imports `@tauri-apps/plugin-process`, and no path reaches a native install
command. The handoff instead runs entirely on state the app already has:

1. The person approves (`Update with package tool`).
2. The app reads the live state **at that moment** — unsaved editor buffers from the editor
   handles' own answers, a foreground-process probe per terminal leaf, and the agent phases
   the terminals reported (`working`/`attention`) — and binds the approval to that
   snapshot (`src/modules/updater/handoffReadiness.ts`,
   `handoffWork.ts`).
3. It re-reads the same evidence immediately before handing off. Work that appeared in
   between — a buffer that went dirty, a new process, an agent that started — invalidates
   the approval instead of being handed off over.
4. Any work in the way blocks the handoff (`handoff-blocked`), names it by file, process or
   agent, and offers to focus it. The app never saves, closes, stops or interrupts
   anything: that stays the person's decision, and a fresh approval is required after
   they resolve it.
5. A clear check ends at `handed-off`: the artifact name and the package-tool command
   (apt/dnf, pacman/makepkg/AUR for Arch), plus the explicit statements that Terax did not
   download, install or verify anything and cannot confirm the result.

There is no `installed`/`ready` state, and no success claim anywhere in the copy.
Cancellation, package locks and failed transactions are the package tool's outcomes: the
dialog says that nothing is rolled back by Terax, that closing Terax first and running the
command again is the recovery path, and that Terax cannot tell whether a transaction
finished. Nothing relaunches the app.

A window that cannot read the workspace's live state (the settings window) does not hand
off; it falls back to `handoff-unavailable` and points at the main window's dialog.

## Not claimed

- No live fork release endpoint, owner URL or signing key exists yet. A version tag therefore
  publishes nothing: the gate refuses (see above), and no hosted run of the release workflow exists.
- No tagged release, signing, upload or public artifact discovery has been exercised end to end;
  those are release-only claims owned by #40/#44/#45.
- No RPM/DEB/Arch install, upgrade, signature rejection or package-lock behavior has been
  validated. That needs the packaged-app seam with real artifacts on a disposable system.
- The readiness check is unit- and component-tested, but a real package-tool run — hand off,
  run the command, start the new binary — has not been observed in this repository; that run is
  the human check named in #39.
- No privilege interval, in-app transaction or rollback exists, by decision rather than as an
  unfinished gap.
