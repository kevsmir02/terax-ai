import { describe, expect, it } from "vitest";
import type { SpaceMeta } from "./store";
import {
  hasIsolatedSharedRoot,
  isSharedRootIsolated,
  normalizeSpaceRoot,
  sharedFolderFooterNote,
  sharedRootFor,
  sharedRoots,
  sharedRootWarning,
  sharedRootWarningWithIsolation,
} from "./sharedRoots";

function space(
  id: string,
  name: string,
  root: string | null,
  accountIsolation: "default" | "isolated" = "default",
): SpaceMeta {
  return {
    id,
    name,
    root,
    env: { kind: "local" },
    accountIsolation,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("shared checkout detection", () => {
  it("reports two Spaces that point at the same folder", () => {
    const spaces = [
      space("a", "Terax", "/work/terax"),
      space("b", "Terax review", "/work/terax"),
    ];

    expect(sharedRoots(spaces)).toEqual([
      {
        root: "/work/terax",
        spaceIds: ["a", "b"],
        names: ["Terax", "Terax review"],
      },
    ]);
    expect(sharedRootFor(spaces, "b")?.spaceIds).toEqual(["a", "b"]);
  });

  it("treats trailing separators and both path separators as one folder", () => {
    const spaces = [
      space("a", "One", "/work/terax/"),
      space("b", "Two", "\\work\\terax\\"),
      space("c", "Three", "/work/terax"),
    ];

    expect(sharedRoots(spaces).map((group) => group.spaceIds)).toEqual([
      ["a", "b", "c"],
    ]);
  });

  it("does not share worktrees, sibling names or unrooted Spaces", () => {
    const spaces = [
      space("a", "Main", "/work/terax"),
      space("b", "Issue", "/work/terax-feature"),
      space("c", "Nested", "/work/terax-feature/issue-17"),
      space("d", "No root", null),
      space("e", "No root either", null),
    ];

    expect(sharedRoots(spaces)).toEqual([]);
    expect(sharedRootFor(spaces, "a")).toBeNull();
    expect(sharedRootFor(spaces, "missing")).toBeNull();
  });

  it("normalizes a root for display and identity", () => {
    expect(normalizeSpaceRoot("/work/terax///")).toBe("/work/terax");
    expect(normalizeSpaceRoot("C:\\work\\terax\\")).toBe("C:/work/terax");
    expect(normalizeSpaceRoot("/")).toBe("/");
  });

  it("states the shared relationship without promising isolation", () => {
    const warning = sharedRootWarning("/work/terax", ["Terax", "Terax review"]);

    expect(warning).toContain("Spaces organize tabs");
    expect(warning).toContain("Files and processes are shared");
    expect(warning).toContain("worktree");
    expect(warning.toLowerCase()).not.toContain("isolated");
  });

  it("clarifies shared repo configs, tools, and MCP/memory backends when isolated Spaces share a root", () => {
    const spaces = [
      space("a", "Main", "/work/terax", "default"),
      space("b", "Client", "/work/terax", "isolated"),
      space("c", "Other", "/work/other", "isolated"),
    ];
    const groups = sharedRoots(spaces);
    expect(isSharedRootIsolated(groups[0], spaces)).toBe(true);
    expect(hasIsolatedSharedRoot(groups, spaces)).toBe(true);

    const nonIsolated = [
      space("a", "Main", "/work/terax", "default"),
      space("b", "Review", "/work/terax", "default"),
    ];
    const nonIsolatedGroups = sharedRoots(nonIsolated);
    expect(isSharedRootIsolated(nonIsolatedGroups[0], nonIsolated)).toBe(false);
    expect(hasIsolatedSharedRoot(nonIsolatedGroups, nonIsolated)).toBe(false);

    const warning = sharedRootWarningWithIsolation(
      "/work/terax",
      ["Main", "Client"],
      true,
    );
    expect(warning).toContain("Files and processes are shared");
    expect(warning).toContain(".mcp.json");
    expect(warning).toContain(".claude/");
    expect(warning).toContain("Git");
    expect(warning).toContain("SSH");
    expect(warning).toContain("cloud CLIs");
    expect(warning).toContain("Engram");
    expect(warning).toContain("CodeGraph");
    expect(warning).toContain("pi-lens");

    const plainNote = sharedFolderFooterNote(false);
    expect(plainNote).toBe(
      "Spaces organize tabs only; files and processes are shared.",
    );

    const isolatedNote = sharedFolderFooterNote(true);
    expect(isolatedNote).toContain(
      "Spaces organize tabs only; files and processes are shared.",
    );
    expect(isolatedNote).toContain(".mcp.json");
    expect(isolatedNote).toContain(".claude/");
    expect(isolatedNote).toContain("Engram");
    expect(isolatedNote).toContain("CodeGraph");
    expect(isolatedNote).toContain("pi-lens");
  });
});
