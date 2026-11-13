/**
 * The worktree creation wire contract, checked against the Rust source.
 *
 * The native preflight is the authority on branch/ref/path problems, and the
 * workspace registry is the authority on access. A rename on either side must
 * fail here instead of silently rendering an unknown field as an empty form.
 */

import { readRepoFile, rustEnum, rustStructFields } from "@/test/rustSource";
import { describe, expect, it } from "vitest";
import type {
  WorktreeProblemField,
  WorktreePreflight,
} from "@/modules/git/types";
import type { WorktreeAccess } from "./createWorktree";

const worktreeRust = readRepoFile("src-tauri/src/modules/git/worktree.rs");
const workspaceRust = readRepoFile("src-tauri/src/modules/workspace.rs");

describe("worktree creation wire contract", () => {
  it("keeps the preflight problem fields and struct fields in step", () => {
    const fields = rustEnum(worktreeRust, "WorktreeProblemField", {
      requireRenameAll: true,
    }).variants as WorktreeProblemField[];
    expect(fields).toEqual(["Path", "Branch", "Base", "Include"]);
    expect(
      fields.map((field) => field[0].toLowerCase() + field.slice(1)),
    ).toEqual(["path", "branch", "base", "include"]);
    expect(rustStructFields(worktreeRust, "WorktreeProblem")).toEqual([
      "field",
      "message",
    ]);
    expect(rustStructFields(worktreeRust, "WorktreePreflight")).toEqual([
      "path",
      "collision",
      "problems",
    ]);

    // A value of the shape the native command serializes must satisfy the type
    // the dialog reads.
    const sample: WorktreePreflight = {
      path: "/work/wt",
      collision: null,
      problems: [{ field: "branch", message: "branch main already exists" }],
    };
    expect(sample.problems[0].field).toBe("branch");
  });

  it("keeps the workspace access kinds in step", () => {
    const variants = rustEnum(workspaceRust, "Access", {
      requireRenameAll: true,
    }).variants;
    expect(variants).toEqual(["Root", "Derived", "Covered", "None"]);
    const expected: WorktreeAccess[] = ["root", "derived", "covered", "none"];
    expect(variants.map((variant) => variant.toLowerCase())).toEqual(expected);
  });
});
