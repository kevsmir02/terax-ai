/**
 * The worktree creation wire contract, checked against the Rust source.
 *
 * The native preflight is the authority on branch/ref/path problems, and the
 * workspace registry is the authority on access. A rename on either side must
 * fail here instead of silently rendering an unknown field as an empty form.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  WorktreeProblemField,
  WorktreePreflight,
} from "@/modules/git/types";
import type { WorktreeAccess } from "./createWorktree";

const root = join(import.meta.dirname, "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const worktreeRust = read("src-tauri/src/modules/git/worktree.rs");
const workspaceRust = read("src-tauri/src/modules/workspace.rs");

function rustEnum(source: string, name: string): string[] {
  const block = new RegExp(
    `#\\[serde\\(([^)]*)\\)\\]\\s*pub enum ${name} \\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  if (!block) throw new Error(`enum ${name} not found in the Rust source`);

  if (!/rename_all = "([A-Za-z-]+)"/.test(block[1]))
    throw new Error(`enum ${name} declares no rename_all`);
  return [...block[2].matchAll(/^\s{4}([A-Z][A-Za-z]*),/gm)].map(
    (match) => match[1],
  );
}

function rustStructFields(source: string, name: string): string[] {
  const block = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`).exec(
    source,
  );
  if (!block) throw new Error(`struct ${name} not found in the Rust source`);
  return [...block[1].matchAll(/^\s{4}pub (\w+):/gm)].map((match) => match[1]);
}

describe("worktree creation wire contract", () => {
  it("keeps the preflight problem fields and struct fields in step", () => {
    const fields = rustEnum(
      worktreeRust,
      "WorktreeProblemField",
    ) as WorktreeProblemField[];
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
    const variants = rustEnum(workspaceRust, "Access");
    expect(variants).toEqual(["Root", "Derived", "Covered", "None"]);
    const expected: WorktreeAccess[] = ["root", "derived", "covered", "none"];
    expect(variants.map((variant) => variant.toLowerCase())).toEqual(expected);
  });
});
