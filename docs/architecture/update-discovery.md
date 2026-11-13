# Update discovery (fork-owned, no install)

Status: **planned scope implemented for discovery only.** Nothing here downloads a package,
installs one, prompts for privilege or relaunches the application. Those are ticket #39
(install/readiness handoff) and #40/#39 (final identity and release trust) inputs.

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

`src/modules/updater/releaseContract.json` is the single source of the fork's release
channel. It is provisional and non-live on purpose:

- endpoint host is under `.invalid` (RFC 2606), so a build cannot query a live feed by
  accident;
- channel is `stable` only;
- `trust.provisioned` is `false` with an empty `publicKey`, because no fork signing key
  exists yet;
- upstream's feed (`crynta/terax-ai` releases) is recorded only so code and tests can
  refuse it. The inherited `src-tauri/tauri.conf.json` endpoint and upstream minisign key
  have been removed; the Tauri updater config now mirrors this contract with an empty key
  and is inert (discovery does not call the native updater plugin).

`src/modules/updater/contract.ts` resolves the contract. In a development build only, the
`VITE_TERAX_WORKSPACE_UPDATE_ENDPOINT` environment variable can point the check at an
isolated fixture endpoint, and only a loopback endpoint is accepted. Production builds
ignore it. `pnpm dev:update-fixtures` serves `src/modules/updater/fixtures` on
`127.0.0.1:8787` (`/stable.json`, `/stable-current.json`, `/stable-bad-signature.json`,
`/stable-prerelease.json`, plus `/rate-limited`, `/offline`, `/malformed` failure routes).
No route serves a package.

## Tagged releases: a gate that refuses, not a publish

`src/modules/updater/releaseContract.json` is also the gate's only source for publication identity
and trust. `.github/workflows/release.yml` is started by a `v<major>.<minor>.<patch>` tag or by
`workflow_dispatch`, and its first step is `scripts/release_gate.py --preconditions-only`: tag
agrees with the application version (stable only), every job `ci.yml` declares is green for that
exact commit, and publication identity plus signing trust are decided. Only then does the job
build, and a second gate stage binds the staged artifacts to the triggering commit and their
sha256.

Today the third precondition cannot hold, so a tag fails loudly before any artifact is produced
and nothing is published anywhere — the workflow has no write permission, no release-upload action
and no signing secret, and the gate has no publish code path. The refusal names each missing input
and the ticket that supplies it; `docs/architecture/linux-packages.md` carries the full table:

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

Artifact trust at discovery time is **structural only**: a valid minisign envelope, a
trusted comment that names the announced version, and a provisioned trust root. A check
that does not download the artifact cannot cryptographically verify it, so the production
verifier fails closed (`check-failed: signature`) until #39 provisions keys. A development
build against loopback fixtures labels releases `fixture-unverified`, and the UI says so.

Automatic checks run at most once per `check.intervalMs` (6 h), tracked under the fork's
namespaced key (`terax-workspace:updater:last-check`). An explicit user check bypasses the
throttle. The hook never blocks the UI and never downloads.

## Install handoff (deliberately unimplemented)

`requestDownload` requires explicit approval and returns `not-implemented` with ticket
#39. The state machine has no `installed`/`ready` state: `handoff-unavailable` is the
furthest a user request goes. Arch guidance (pacman/makepkg/AUR helper) and the deb/rpm
package-tool handoff text are shown in the dialog; Terax never executes those commands and
never requests privilege.

## Not claimed

- No live fork release endpoint, owner URL or signing key exists yet. A version tag therefore
  publishes nothing: the gate refuses (see above), and no hosted run of the release workflow exists.
- No tagged release, signing, upload or public artifact discovery has been exercised end to end;
  those are release-only claims owned by #40/#44/#45.
- No RPM/DEB/Arch install, upgrade, signature rejection or package-lock behavior has been
  validated. That needs the packaged-app seam with real artifacts.
- No readiness interval, privilege interval or failed-transaction recovery is implemented
  (ticket #39).
