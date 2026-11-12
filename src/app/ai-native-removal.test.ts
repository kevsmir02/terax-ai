import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The built-in AI native stack was contracted in ticket #14 (issue #14, user
// stories 4 and 5): providers, API-key storage, the AI transport, conversation
// files, AI read/search tools and the agent shell/subagent process surfaces are
// gone, while the shared contracts they used (file policies, formatter shell
// execution, Git, control, hooks, notifications, PTY) stay. This guard keeps the
// command table and the native module tree honest after the deletion, so a
// reintroduced registration or a dead command fails here instead of shipping.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const srcRoot = path.join(repoRoot, "src");
const rustSrc = path.join(repoRoot, "src-tauri/src");
const rustCrates = path.join(repoRoot, "src-tauri/crates");

/** Every command the client is no longer allowed to call. */
const REMOVED_COMMANDS = [
  "ai_read_file",
  "ai_read_dir",
  "ai_grep",
  "ai_glob",
  "fs_read_project_memory",
  "shell_session_open",
  "shell_session_run",
  "shell_session_close",
  "shell_bg_spawn",
  "shell_bg_logs",
  "shell_bg_kill",
  "shell_bg_list",
  "secrets_get",
  "secrets_set",
  "secrets_delete",
  "secrets_get_all",
  "lm_ping",
  "ai_http_stream",
  "ai_http_cancel",
  "ai_http_ack",
  "ai_session_load",
  "ai_session_save",
  "ai_session_delete",
  "ai_session_finish_migration",
  "ai_session_prune_backup",
];

/** Native files the contraction deleted; they must not come back. */
const REMOVED_PATHS = [
  "src-tauri/src/modules/net.rs",
  "src-tauri/src/modules/net/clients.rs",
  "src-tauri/src/modules/net/ip.rs",
  "src-tauri/src/modules/net/stream.rs",
  "src-tauri/src/modules/secrets.rs",
  "src-tauri/src/modules/ai_sessions.rs",
  "src-tauri/src/modules/ipc_body.rs",
  "src-tauri/src/modules/fs/ai.rs",
  "src-tauri/src/modules/fs/project_memory.rs",
  "src-tauri/src/modules/shell/session.rs",
  "src-tauri/src/modules/shell/background.rs",
  "src-tauri/src/modules/shell/ringbuffer.rs",
  "src-tauri/tests/shell_background.rs",
];

/** Rust symbols and module paths that only the removed AI stack owned. */
const REMOVED_RUST_NAMES = [
  "AiStreamState",
  "SecretsState",
  "SessionFilesState",
  "modules::ai_sessions",
  "modules::secrets",
  "modules::net",
  "modules::ipc_body",
  "super::ipc_body",
  "fs::ai",
  "fs::project_memory",
];

/** Comment prose that described the still-present compatibility layer. */
const REMOVED_RUST_PROSE = [
  /\bAI-only\b/,
  /\bAI-owned\b/,
  /\bAI-tool\b/,
  /\bAI reads?\b/,
];

/**
 * Registered commands with no client caller. Retained on purpose: they are
 * native contracts with their own coverage, not part of the removed AI stack.
 */
const RETAINED_NATIVE_ONLY: Record<string, string> = {
  pty_has_foreground_job: "terminal process detection contract",
  pty_shell_name: "terminal shell detection contract",
  fs_list_files: "covered by src-tauri/tests/fs_search.rs",
  fs_glob: "covered by src-tauri/tests/fs_search.rs",
  wsl_default_distro: "WSL bridge contract on Windows",
};

/** Dependencies only the removed AI transport, storage and keyring used. */
const REMOVED_DEPENDENCIES = ["reqwest", "rustls", "bytes", "futures-util", "keyring"];

/** Dependencies retained by non-AI features; the removal must not take them. */
const RETAINED_DEPENDENCIES = [
  "tauri",
  "portable-pty",
  "tokio",
  "tempfile",
  "ignore",
  "globset",
  "shared_child",
  "grep-searcher",
  "notify",
];

function filesUnder(dir: string, extensions: RegExp, skip: RegExp[] = []): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (skip.some((pattern) => pattern.test(full))) return [];
    if (entry.isDirectory()) return filesUnder(full, extensions, skip);
    return extensions.test(entry.name) ? [full] : [];
  });
}

function relative(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function rustFiles(): string[] {
  return [
    ...filesUnder(rustSrc, /\.rs$/),
    ...filesUnder(rustCrates, /\.rs$/),
  ];
}

/** Production client and runner sources: removal guards name what is gone. */
function clientFiles(): string[] {
  const tests = /\.(?:test|bench)\.tsx?$/;
  return [
    ...filesUnder(srcRoot, /\.(?:ts|tsx)$/, [tests]),
    ...filesUnder(path.join(repoRoot, "scripts"), /\.(?:ts|tsx|mjs|js|py)$/, [
      tests,
    ]),
  ];
}

/** The command names inside `tauri::generate_handler![...]`. */
function registeredCommands(): string[] {
  const lib = readFileSync(path.join(rustSrc, "lib.rs"), "utf8");
  const block = lib.split("tauri::generate_handler![")[1]?.split("])")[0];
  if (!block) throw new Error("lib.rs no longer registers a command handler");
  return [...block.matchAll(/([A-Za-z_][\w:]*)\s*,/g)].map(
    (match) => match[1].split("::").pop() as string,
  );
}

function cargoDependencyNames(): string[] {
  const manifest = readFileSync(path.join(repoRoot, "src-tauri/Cargo.toml"), "utf8");
  return manifest
    .split("\n")
    .map((line) => /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1])
    .filter((name): name is string => !!name);
}

describe("removed built-in AI native commands", () => {
  it("registers none of them in the invocation handler", () => {
    const registered = registeredCommands();
    expect(registered.filter((name) => REMOVED_COMMANDS.includes(name))).toEqual(
      [],
    );
  });

  it("keeps the retained shared command surface registered", () => {
    const registered = registeredCommands();
    for (const retained of [
      "shell_run_command",
      "fs_read_file",
      "fs_write_file",
      "fs_move",
      "asset_grant",
      "fs_watch_add",
      "fs_grep",
      "git_status",
      "git_commit",
      "git_apply_hunks",
      "git_worktree_remove",
      "agent_hooks_plan",
      "agent_hooks_apply",
      "control_frontend_ready",
      "agent_decision_respond",
      "history_list",
      "pty_open",
      "pty_stream_open",
      "pty_set_presentation",
      "workspace_authorize",
      "window_set_backdrop",
    ])
      expect(registered, retained).toContain(retained);
  });

  it("names no removed command in any client or script source", () => {
    const hits = clientFiles().flatMap((file) => {
      const code = readFileSync(file, "utf8");
      return REMOVED_COMMANDS.filter((name) =>
        new RegExp(`\\b${name}\\b`).test(code),
      ).map((name) => `${relative(file)}: ${name}`);
    });
    expect(hits).toEqual([]);
  });

  it("leaves no command in the table without a consumer or a stated reason", () => {
    const corpus = clientFiles()
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const orphans = registeredCommands().filter(
      (name) =>
        !corpus.includes(name) &&
        RETAINED_NATIVE_ONLY[name] === undefined,
    );
    expect(orphans).toEqual([]);
  });
});

describe("removed built-in AI native modules", () => {
  it("leaves no removed module file on disk", () => {
    expect(REMOVED_PATHS.filter((file) => existsSync(path.join(repoRoot, file))))
      .toEqual([]);
  });

  it("has no retained Rust source naming a removed module or state type", () => {
    const hits = rustFiles().flatMap((file) => {
      const code = readFileSync(file, "utf8");
      return REMOVED_RUST_NAMES.filter((name) => code.includes(name)).map(
        (name) => `${relative(file)}: ${name}`,
      );
    });
    expect(hits).toEqual([]);
  });

  it("keeps no AI-only ownership wording in the native tree", () => {
    const hits = rustFiles().flatMap((file) => {
      const code = readFileSync(file, "utf8");
      return REMOVED_RUST_PROSE.filter((pattern) => pattern.test(code)).map(
        (pattern) => `${relative(file)}: ${pattern}`,
      );
    });
    expect(hits).toEqual([]);
  });

  it("keeps the neutral access primitives the retained preview depends on", () => {
    const access = readFileSync(
      path.join(rustSrc, "modules/fs/access.rs"),
      "utf8",
    );
    expect(access).toContain("pub(super) fn opened_path");
    const assets = readFileSync(path.join(rustSrc, "modules/fs/assets.rs"), "utf8");
    expect(assets).toContain("access::opened_path");
    const policy = readFileSync(
      path.join(rustSrc, "modules/fs/access_policy.rs"),
      "utf8",
    );
    expect(policy).toContain("pathPolicy.json");
    for (const retained of [
      "src/modules/workspace/native.ts",
      "src/modules/workspace/policy.ts",
      "src/modules/workspace/pathPolicy.json",
      "src-tauri/src/modules/fs/access.rs",
      "src-tauri/src/modules/fs/access_policy.rs",
    ])
      expect(existsSync(path.join(repoRoot, retained)), retained).toBe(true);
  });
});

describe("native dependency graph", () => {
  it("declares no dependency that only the AI stack used", () => {
    const deps = cargoDependencyNames();
    expect(deps.filter((name) => REMOVED_DEPENDENCIES.includes(name))).toEqual(
      [],
    );
  });

  it("still declares what the retained features build on", () => {
    const deps = cargoDependencyNames();
    for (const retained of RETAINED_DEPENDENCIES)
      expect(deps, retained).toContain(retained);
  });
});

describe("architecture docs describe the retained contracts", () => {
  function doc(relativePath: string): string {
    return readFileSync(path.join(repoRoot, relativePath), "utf8");
  }

  it("drops the removed subsystem guide and its links", () => {
    expect(existsSync(path.join(repoRoot, "docs/architecture/ai-subsystem.md")))
      .toBe(false);
    for (const file of ["docs/README.md", "docs/architecture/security-model.md", "TERAX.md"])
      expect(doc(file), file).not.toContain("ai-subsystem.md");
  });

  it("keeps no claim that the AI native layer is still present", () => {
    for (const file of [
      "TERAX.md",
      "docs/architecture/two-process-model.md",
      "docs/architecture/security-model.md",
    ]) {
      const text = doc(file);
      expect(text, file).not.toMatch(/until ticket #14/);
      expect(text, file).not.toMatch(/inert AI/);
      expect(text, file).not.toMatch(/\bnative compatibility layer\b/);
    }
  });

  it("lists no removed command in the IPC command reference", () => {
    const catalog = doc("docs/architecture/two-process-model.md");
    for (const name of REMOVED_COMMANDS)
      expect(catalog, name).not.toContain(`\`${name}\``);
  });
});
