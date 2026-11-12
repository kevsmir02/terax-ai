/**
 * Legacy AI-owned native barrel.
 *
 * The generic half now lives in the neutral owner, `src/modules/workspace/
 * native`, and is re-exported here so the remaining agent code keeps
 * compiling. `readFile` is deliberately **overridden** below: the agent reader
 * must stay on the policy-guarded `ai_read_file`, while the neutral
 * `native.readFile` maps to the explicit-user `fs_read_file`.
 *
 * Remaining importers of this module (all AI-owned; none retained by the
 * workspace program):
 *  - `ai/lib/transport.ts`
 *  - `ai/store/planStore.ts`
 *  - `ai/tools/edit.ts`
 *  - `ai/tools/fs.ts`
 *  - `ai/tools/search.ts`
 *  - `ai/tools/shell.ts`
 *  - `ai/components/AgentRunBridge.tsx`
 * Deleting this file (with the agent) must not remove
 * `modules/workspace/native`, which retained Spaces/explorer callers import.
 */

import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import {
  native as sharedNative,
  type ReadResult,
} from "@/modules/workspace/native";

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  gitignored: boolean;
};

type GrepHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

export type GrepResponse = {
  hits: GrepHit[];
  truncated: boolean;
  files_scanned: number;
};

type GlobHit = { path: string; rel: string };
export type GlobResponse = { hits: GlobHit[]; truncated: boolean };

export const native = {
  ...sharedNative,
  readProjectMemory: (
    root: string,
    checkedPath: string,
    workspace: WorkspaceEnv,
  ) =>
    invoke<string | null>("fs_read_project_memory", {
      root,
      checkedPath,
      workspace,
    }),
  // AI reads stay behind the shared policy + registry composition
  // (`fs::ai::read_file`); do not point this at the neutral `readFile`.
  readFile: (path: string) =>
    invoke<ReadResult>("ai_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  // AI tooling never sees dot-prefixed entries regardless of the user's
  // explorer preference — keeps .git / .env / .ssh out of agent context.
  readDir: (path: string) =>
    invoke<DirEntry[]>("ai_read_dir", {
      path,
      showHidden: false,
      workspace: currentWorkspaceEnv(),
    }),
  grep: (params: {
    pattern: string;
    root: string;
    glob?: string[];
    caseInsensitive?: boolean;
    maxResults?: number;
  }) =>
    invoke<GrepResponse>("ai_grep", {
      pattern: params.pattern,
      root: params.root,
      glob: params.glob ?? null,
      caseInsensitive: params.caseInsensitive ?? null,
      maxResults: params.maxResults ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  glob: (params: { pattern: string; root: string; maxResults?: number }) =>
    invoke<GlobResponse>("ai_glob", {
      pattern: params.pattern,
      root: params.root,
      maxResults: params.maxResults ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  shellSessionOpen: (cwd?: string | null) =>
    invoke<number>("shell_session_open", {
      cwd: cwd ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  shellSessionRun: (
    id: number,
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
  ) =>
    invoke<{
      stdout: string;
      stderr: string;
      exit_code: number | null;
      timed_out: boolean;
      truncated: boolean;
      cwd_after: string;
    }>("shell_session_run", {
      id,
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  shellSessionClose: (id: number) =>
    invoke<void>("shell_session_close", { id }),
  shellBgSpawn: (command: string, cwd?: string | null) =>
    invoke<number>("shell_bg_spawn", {
      command,
      cwd: cwd ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  shellBgLogs: (handle: number, sinceOffset?: number) =>
    invoke<{
      bytes: string;
      next_offset: number;
      dropped: number;
      exited: boolean;
      exit_code: number | null;
    }>("shell_bg_logs", { handle, sinceOffset: sinceOffset ?? null }),
  shellBgKill: (handle: number) => invoke<void>("shell_bg_kill", { handle }),
  shellBgList: () =>
    invoke<
      {
        handle: number;
        command: string;
        cwd: string | null;
        started_at_ms: number;
        exited: boolean;
        exit_code: number | null;
      }[]
    >("shell_bg_list"),
};
