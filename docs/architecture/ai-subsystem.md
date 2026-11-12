# Built-in AI subsystem (removed)

This guide elaborates on `TERAX.md`. If anything here conflicts with `TERAX.md`, `TERAX.md` wins.

## Status

The built-in AI product surfaces were removed in ticket #12 (user story 4 of the
personal Linux workspace spec): chat panel, composer, mini-window, conversation
sessions and their startup hydration, provider/model selection, API-key
management, prompt snippets, sub-agents and managed review. The client no longer
ships the AI SDK, zod or any of the supporting UI, and `App.tsx` performs no
conversation or session restore.

The native AI stack has not been contracted yet: the Rust commands
(`ai_*`, `shell_*`, `net::ai_http_*`, `secrets_*`, `ai_sessions`) still compile
and are covered by their existing integration tests, but nothing in the client
calls them. Ticket #14 removes them. Until then:

- Do not add frontend consumers. The client is agent-terminal-only: external
  agents are launched into PTYs and observed through the PTY/OSC/hook signals
  described in `TERAX.md`.
- Do not read, migrate or delete upstream Terax conversations, credentials or
  keychain entries. Namespace isolation is described in
  [`namespace-isolation.md`](namespace-isolation.md).
- Do not treat the presence of a command in the native command table as a
  supported product feature.

## Guards

- `src/app/chat-removal.test.ts` asserts that chat cannot be opened (keymap,
  command palette, settings deep links, status bar), that no built-in
  conversation/AI-session hydration or persistence path remains, that the AI SDK
  and its client-only helpers are gone from the manifest, and that the startup
  graph contains none of the removed modules.
- `src/modules/markdown/ownership.test.ts` keeps rendered Markdown independent
  of the removed AI element aliases; Streamdown remains a Markdown dependency.

## See also

- [`TERAX.md`](../../TERAX.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Two-process model](two-process-model.md) - IPC boundary and command catalog
- [Security model](security-model.md) - the boundaries every retained command must respect
