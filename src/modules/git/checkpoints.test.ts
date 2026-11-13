import {
  camelFieldName,
  readRepoFile,
  rustStructFields,
} from "@/test/rustSource";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import { git } from "./api";
import type { CheckpointStorage, RecoveryKind } from "./types";

const workspace = { kind: "local" };

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

    await git.checkpointInspect("/wt", "refs/codr/manual-checkpoints/abc");
    expect(mocks.invoke).toHaveBeenLastCalledWith("git_checkpoint_inspect", {
      worktree: "/wt",
      reference: "refs/codr/manual-checkpoints/abc",
      workspace,
    });
  });

  it("cleans up only the refs the caller names", async () => {
    await git.checkpointCleanup("/wt", ["refs/codr/manual-checkpoints/abc"]);
    expect(mocks.invoke).toHaveBeenLastCalledWith("git_checkpoint_cleanup", {
      worktree: "/wt",
      refs: ["refs/codr/manual-checkpoints/abc"],
      workspace,
    });
  });

  it("previews a restore and binds the confirmation to its fingerprint", async () => {
    await git.checkpointRestorePreview(
      "/wt",
      "refs/codr/manual-checkpoints/abc",
    );
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "git_checkpoint_manual_restore_preview",
      {
        worktree: "/wt",
        reference: "refs/codr/manual-checkpoints/abc",
        workspace,
      },
    );

    await git.checkpointRestoreManual(
      "/wt",
      "refs/codr/manual-checkpoints/abc",
      "fingerprint",
      true,
    );
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "git_checkpoint_manual_restore",
      {
        worktree: "/wt",
        reference: "refs/codr/manual-checkpoints/abc",
        fingerprint: "fingerprint",
        force: true,
        workspace,
      },
    );
  });
});

describe("cross-language checkpoint contracts", () => {
  it("keeps the Rust recovery kinds and the TS union in step", () => {
    const source = readRepoFile("src-tauri/src/modules/git/checkpoint.rs");
    const body =
      /pub enum RecoveryKind \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    const variants = [...body.matchAll(/^\s{4}([A-Z][A-Za-z]*),/gm)]
      .map((match) => match[1].toLowerCase())
      .sort();
    const union: RecoveryKind[] = ["manual", "safety", "turn"];
    expect(variants).toEqual(union);
  });

  it("registers every checkpoint command the client invokes", () => {
    const api = readRepoFile("src/modules/git/api.ts");
    const lib = readRepoFile("src-tauri/src/lib.rs");
    const commands = new Set(
      [...api.matchAll(/"(git_checkpoint_[a-z_]+)"/g)].map((match) => match[1]),
    );
    expect(commands.size).toBeGreaterThan(0);
    for (const command of commands) {
      expect(lib, `${command} is not registered in lib.rs`).toContain(command);
    }
  });

  it("reports storage as shared context, never as reclaimed bytes", () => {
    // Parsed from the producer, the way the worktree-removal contract does it:
    // a positive field list fails on *any* new field, including one a scan for
    // "reclaimed"/"freed" names would miss (`storageSaved`, `reclaimable`).
    // Deleting a ref removes reachability, not a measurable number of bytes,
    // until Git itself prunes unreachable objects — and the app never runs
    // garbage collection.
    const fields = rustStructFields(
      readRepoFile("src-tauri/src/modules/git/checkpoint.rs"),
      "StoragePressure",
    );
    expect(fields).toEqual([
      "loose_objects",
      "loose_kib",
      "packed_objects",
      "packed_kib",
      "owned_refs",
      "shared_objects",
    ]);
    const storage: CheckpointStorage = {
      looseObjects: 0,
      looseKib: 0,
      packedObjects: 0,
      packedKib: 0,
      ownedRefs: 0,
      sharedObjects: true,
    };
    // Both directions: a native field without a TS peer (or the reverse) fails.
    expect(Object.keys(storage)).toEqual(fields.map(camelFieldName));
  });
});
