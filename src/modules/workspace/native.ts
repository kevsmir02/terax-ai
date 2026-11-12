/**
 * Neutral native file/workspace commands.
 *
 * This is the shared contract for retained features (Spaces, explorer,
 * editor-adjacent tooling). It replaced the generic half of the built-in AI
 * native barrel, which was removed with the AI chat feature (ticket #12).
 *
 * Trust tiers are deliberate — do not collapse them:
 *  - `readFile`/`writeFile` here call `fs_read_file`/`fs_write_file`, the
 *    explicit-user editing commands. They apply **no** secret-path policy and
 *    no workspace registry, so editing `~/.ssh/config`, `key.pem` or a file
 *    outside the project root keeps working (that is the point of tier A).
 *  - Automatic consumers (agent reads, preview assets) must go through
 *    `modules/workspace/policy` plus the native guards instead.
 *  - `shellRunCommand` maps to `shell_run_command`, whose `cwd` is
 *    registry-confined (`workspace::authorize_spawn_cwd`); a command whose cwd
 *    lies outside every authorized root is refused.
 */

import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";

export type ReadResult =
  | { kind: "text"; content: string; size: number; mtime?: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
};

export const native = {
  workspaceCurrentDir: () => invoke<string>("workspace_current_dir"),
  workspaceAuthorize: (path: string) =>
    invoke<string>("workspace_authorize", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  /** Explicit-user read: no path policy, no workspace registry. */
  readFile: (path: string) =>
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  /** Explicit-user write: atomic tempfile+rename, returns the new mtime. */
  writeFile: (path: string, content: string) =>
    invoke<number>("fs_write_file", {
      path,
      content,
      workspace: currentWorkspaceEnv(),
    }),
  canonicalize: (
    path: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<string>("fs_canonicalize", {
      path,
      workspace,
    }),
  createFile: (path: string) =>
    invoke<void>("fs_create_file", { path, workspace: currentWorkspaceEnv() }),
  createDir: (path: string) =>
    invoke<void>("fs_create_dir", { path, workspace: currentWorkspaceEnv() }),
  shellRunCommand: (
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
  ) =>
    invoke<CommandOutput>("shell_run_command", {
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: currentWorkspaceEnv(),
    }),
};
