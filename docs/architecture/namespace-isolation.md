# Namespace isolation (fork identity)

This fork (`dev.terax-workspace.fork`) must be installable and runnable **next to** an
installed upstream Terax without either application reading, importing, overwriting or
deleting the other's state. Changing the Tauri identifier alone does **not** achieve that:
several of the names this application writes are keyed by the product *name* or by a
hardcoded path, not by the bundle identifier.

The identity is **provisional**. Final product name, release owner/URL and signing keys are
ticket #39/#40 inputs; nothing here is shippable identity, and no upstream URL or key is
replaced with an invented one.

## One table

Every name below is derived from `src/modules/identity/namespace.json`:

| Field | Value (provisional) | Used for |
| --- | --- | --- |
| `appIdentifier` | `dev.terax-workspace.fork` | Tauri bundle id → app config/data/cache/state dirs and the WebKit data dir |
| `namespace` | `terax-workspace` | cache directory, shell integration, git refs and ref-adjacent per-user dirs |
| `envPrefix` | `TERAX_WORKSPACE_FORK` | every environment variable the app sets for a child shell |
| `upstream.appIdentifier` | `app.crynta.terax` | the identity this fork refuses to run under or read |
| `upstream.namespace` | `terax` | the directory this fork refuses to write |
| `upstream.envPrefix` | `TERAX` | the variables that identify an upstream-owned shell (`TERAX_CLI`, `TERAX_CONTROL_ADDR`) |

Readers: `src-tauri/src/modules/identity.rs` (Rust app), `src-tauri/crates/terax-cli`
(CLI descriptor lookup), `scripts/linux_profile.py` and `scripts/namespace_sentinels.py`
(runners), `src/modules/identity/namespace.test.ts` (drift checks).

A **rename is one file**, plus `src-tauri/tauri.conf.json`, which `tauri build` forces to be
a literal; tests compare that literal against the table (Rust
`the_tauri_identifier_literal_matches_the_table`, TS `matches the Tauri config literal`).

## Inventory

| Surface | Upstream name | Fork name | Why it had to move |
| --- | --- | --- | --- |
| Tauri/bundle identifier | `app.crynta.terax` | `dev.terax-workspace.fork` | selects `app_config_dir`/`app_data_dir`/`app_local_data_dir`/`app_cache_dir` and the WebKit data directory (`tauri-runtime-wry` sets `data_directory = app_local_data_dir`) |
| App data dir (secrets file, AI session records) | `$XDG_DATA_HOME/app.crynta.terax` | `$XDG_DATA_HOME/dev.terax-workspace.fork` | identifier-derived; holding the same identifier would make both applications share one secrets file |
| WebKit/webview data (localStorage, IndexedDB, cookies, caches) | identifier-derived | identifier-derived | same directory as above; the `terax:*` localStorage keys are private to the webview once the directory differs |
| App config dir (window state, settings) | identifier-derived | identifier-derived | `tauri-plugin-window-state` writes here; shared identifier = two windows fighting over one file |
| App cache/state dirs | identifier-derived | identifier-derived | updater/webview caches |
| Control descriptor | `$XDG_CACHE_HOME/terax/control.json` | `$XDG_CACHE_HOME/terax-workspace/control.json` | **product-name keyed**, not identifier keyed: a dev run overwrote the installed app's live descriptor (ticket #2, risk 2) |
| Per-pid CLI launcher | `$XDG_CACHE_HOME/terax/run/<pid>/bin/terax` | `$XDG_CACHE_HOME/terax-workspace/run/<pid>/bin/terax` | same directory; also the stale-launcher sweep must not delete the other app's launchers. The launcher *file name* stays `terax` (the CLI command name, packaging identity, #39) but only ever exists inside the fork's own directory |
| Agent-read denylist | `$XDG_CACHE_HOME/terax` | fork dir **and** upstream dir refused | ticket #5 flagged this list as needing to stay in sync with the control module; both now come from the identity table, and upstream's credential file stays unreadable |
| Shell integration root | `~/.cache/terax/shell-integration` | `~/.cache/terax-workspace/shell-integration` | generated rc files; writing them over upstream's would change the other app's shell behaviour |
| fish integration file | `~/.config/fish/conf.d/terax.fish` | `~/.config/fish/conf.d/terax-workspace.fish` | shared `conf.d`: our file must not shadow or rewrite upstream's |
| Shell-side markers (`TERAX_TERMINAL`, `TERAX_BLOCKS`, `TERAX_USER_ZDOTDIR`) | `TERAX_*` | `TERAX_WORKSPACE_FORK_*` | upstream's generated scripts gate on `TERAX_TERMINAL`; setting it would activate the *other* application's integration inside our shells |
| Control/env handshake (`TERAX_CONTROL_ADDR`, `TERAX_CONTROL_TOKEN`, `TERAX_PANE_ID`) | `TERAX_*` | `TERAX_WORKSPACE_FORK_*` | cross-process: a fork CLI reading an upstream address/token would talk to the other app's server |
| CLI variable (`TERAX_CLI`) | `TERAX_CLI` | `TERAX_WORKSPACE_FORK_CLI` | persisted inside shared agent configs; setting it would make upstream's installed hooks invoke whichever CLI is on `PATH` |
| Hook ownership markers | `$TERAX_CLI … hook …`, `notify;Terax;`, `terax;notify`, `__terax_notify` | only commands containing `TERAX_WORKSPACE_FORK_CLI` are ours | the ownership predicate used to claim upstream's commands, so uninstall removed the *other* application's hooks. Upstream commands are now foreign and are never rewritten or removed |
| Hook tuning (`TERAX_HOOK_TIMEOUT`, `TERAX_HOOK_WAIT`, `TERAX_HOOK_DEBUG`) | `TERAX_HOOK_*` | `TERAX_WORKSPACE_FORK_HOOK_*` | read from the child shell's environment; a user value set for the other installation must not silently retune this one |
| Gemini hook label | `"name": "terax"` | `"name": "terax-workspace"` | label written into a shared settings file |
| Pi extension | `.pi/agent/extensions/terax-notifications.ts`, header `// terax-pi-notifications-v2` | `<ns>-notifications.ts`, header `// <ns>-pi-notifications-v<version>` | shared extensions directory; the stale-version check must only consider our own family, and foreign content at our path is refused instead of overwritten |
| OSC 777 notification marker | `ESC ]777;notify;Terax;<agent>;<event>` | same sequence, parsed read-only | written into terminal output by hook configs the user may still have from upstream. Reading it is interop, writing nothing; no state is touched |
| Git refs | `refs/terax/checkpoints/*`, `refs/terax/tasks/*` | `refs/terax-workspace/*` | refs live in the user's repository; a shared namespace lets cleanup/prune delete the other installation's checkpoints |
| Task worktree state | `~/.terax/worktrees/...`, `~/.terax/task-worktrees.json` | `~/.terax-workspace/...` | both applications would otherwise share one registry and one directory tree |
| Branch prefix default | `terax/` | `terax-workspace/` | new branches created by the fork must not collide with upstream's convention |
| Project config `.terax/project.toml` | `.terax/project.toml` | **unchanged** | user-owned project file, read-only for both applications; sharing the *file* is the point of the format |
| Child env shared with project scripts (`TERAX_TASK`, `TERAX_PORT*`, `TERAX_WORKSPACE_PATH`, `TERAX_ROOT_PATH`) | unchanged | unchanged | `~/.terax/project.toml` scripts (shared with upstream projects) reference them; they are a contract, not fork-owned state. `identity.rs` asserts the fork prefix never shadows them |
| Shell history (`~/.zsh_history`, `~/.bash_history`, fish history) | user-owned | unchanged, read-only | the completion index is in memory; this application writes no history file, so there is nothing to isolate — but it also must not be mistaken for fork state |
| Dev/bench/smoke identifiers | `app.crynta.terax.<lab>-<hex>` | `<fork identifier>.<lab>-<hex>` | runners derive them from the table; the preflight refuses the fork product identifier, any identifier under it that is not disposable, and **any upstream identifier** (which would share the upstream profile) |
| Update channel (endpoint + minisign key) | upstream `latest.json` + upstream key | **not yet isolated** — deferred | release identity/trust is #39/#40 (discovery #36). This fork must not be published, and a publication claim stays blocked, until those land: today the Linux update check still queries upstream's release feed, which is a publication gate, not a data-mutation path |
| macOS FSEvents queue label | `app.crynta.terax.fsevents` | identifier-derived | hardcoded copy of the identifier; macOS is out of scope (#33) but the label now follows the table |
| Bundle `productName`, publisher, binary/desktop entry names | `Terax`, `Crynta` | unchanged | packaging identity, not runtime state: installing two packages that ship the same binary name is a #39/#40 (and #33 distribution) decision, not a coexistence bug for a dev run |
| Build-time CLI target (`TERAX_CLI_TARGET`) | `TERAX_CLI_TARGET` | **unchanged** | read by `scripts/build-cli.mjs` and set by `.github/workflows/release.yml`; a build input for the release pipeline, not runtime state. Its rename belongs with the release pipeline in #39/#40, not with namespace isolation |

## Refusal instead of migration

There is deliberately **no import, migration or adoption path**. Upstream state is not
discovered, copied, renamed or deleted:

- the CLI resolves only the fork's descriptor and refuses outright when the shell carries
  upstream's `TERAX_CONTROL_ADDR`/`TERAX_CLI` ("belongs to a different Terax installation");
- hook install/uninstall treats upstream command groups as foreign content;
- a foreign file at one of our paths (e.g. a Pi extension that is not ours) is refused, never
  replaced;
- an upstream identifier in a lab/bench run is refused by both the runner preflight and the
  bench runtime guard.

Any future import has to be an explicit, user-initiated action (spec "Fork identity").

## Evidence

- Rust native seam: `modules::control` (descriptor + launcher directory + stale sweep leave an
  upstream cache tree byte identical), `modules::pty::shell_init` (integration files, and a
  child shell that exposes only fork variables), `modules::agent` (upstream hook groups and the
  upstream Pi file survive install *and* uninstall; foreign content is refused),
  `modules::git::refs` (upstream refs do not parse as ours).
- Runners: `scripts/tests/test_linux_profile.py`, `scripts/tests/test_namespace_sentinels.py`,
  and the sentinel checker's own failure mode in `scripts/app-lab/run.py --self-test`.
- Real application: `scripts/app-lab/run.py` seeds a synthetic upstream installation into the
  disposable profile before launch and re-hashes it after exit
  (`isolation.upstreamStateUnchanged`, `isolation.fork.*` in the manifest).

## See also

- [Security model](security-model.md)
- [app-lab](app-lab.md) — the real-app runner and its isolated profile
- [CLI/control](cli-control.md) — descriptor, token handshake, CLI
