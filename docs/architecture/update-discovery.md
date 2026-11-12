# Update discovery (fork-owned, no install)

Status: **planned scope implemented for discovery only.** Nothing here downloads a package,
installs one, prompts for privilege or relaunches the application. Those are ticket #39
(install/readiness handoff) and #40/#39 (final identity and release trust) inputs.

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

- No live fork release endpoint, owner URL or signing key exists yet.
- No RPM/DEB/Arch install, upgrade, signature rejection or package-lock behavior has been
  validated. That needs the packaged-app seam with real artifacts.
- No readiness interval, privilege interval or failed-transaction recovery is implemented
  (ticket #39).
