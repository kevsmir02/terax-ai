import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import { git } from "./api";
import type { RecoveryKind } from "./types";

const workspace = { kind: "local" };
const root = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("manual checkpoint api", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("creates without a task id, turn or agent hook", async () => {
    await git.checkpointManualCreate("/wt");
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "git_checkpoint_manual_create",
      { worktree: "/wt", name: null, workspace },
    );

    await git.checkpointManualCreate("/wt", "before refactor");
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "git_checkpoint_manual_create",
      { worktree: "/wt", name: "before refactor", workspace },
    );
  });

  it("lists groups and inspects one owned ref", async () => {
    await git.checkpointGroups("/wt");
    expect(mocks.invoke).toHaveBeenLastCalledWith("git_checkpoint_groups", {
      worktree: "/wt",
      workspace,
    });

    await git.checkpointInspect(
      "/wt",
      "refs/terax-workspace/manual-checkpoints/abc",
    );
    expect(mocks.invoke).toHaveBeenLastCalledWith("git_checkpoint_inspect", {
      worktree: "/wt",
      reference: "refs/terax-workspace/manual-checkpoints/abc",
      workspace,
    });
  });

  it("cleans up only the refs the caller names", async () => {
    await git.checkpointCleanup("/wt", [
      "refs/terax-workspace/manual-checkpoints/abc",
    ]);
    expect(mocks.invoke).toHaveBeenLastCalledWith("git_checkpoint_cleanup", {
      worktree: "/wt",
      refs: ["refs/terax-workspace/manual-checkpoints/abc"],
      workspace,
    });
  });
});

describe("cross-language checkpoint contracts", () => {
  it("keeps the Rust recovery kinds and the TS union in step", () => {
    const source = read("src-tauri/src/modules/git/checkpoint.rs");
    const body =
      /pub enum RecoveryKind \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    const variants = [...body.matchAll(/^\s{4}([A-Z][A-Za-z]*),/gm)]
      .map((match) => match[1].toLowerCase())
      .sort();
    const union: RecoveryKind[] = ["manual", "safety", "turn"];
    expect(variants).toEqual(union);
  });

  it("registers every checkpoint command the client invokes", () => {
    const api = read("src/modules/git/api.ts");
    const lib = read("src-tauri/src/lib.rs");
    const commands = new Set(
      [...api.matchAll(/"(git_checkpoint_[a-z_]+)"/g)].map((match) => match[1]),
    );
    expect(commands.size).toBeGreaterThan(0);
    for (const command of commands) {
      expect(lib, `${command} is not registered in lib.rs`).toContain(command);
    }
  });

  it("reports storage as shared context, never as reclaimed bytes", () => {
    const types = read("src/modules/git/types.ts");
    expect(types).toContain("sharedObjects");
    expect(types).not.toMatch(/reclaimedBytes|freedBytes|reclaimedKib/);
  });
});
