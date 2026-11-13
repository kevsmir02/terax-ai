import { describe, expect, it } from "vitest";
import type { SpaceMeta } from "./store";
import {
  normalizeSpaceRoot,
  sharedRootFor,
  sharedRoots,
  sharedRootWarning,
} from "./sharedRoots";

function space(id: string, name: string, root: string | null): SpaceMeta {
  return {
    id,
    name,
    root,
    env: { kind: "local" },
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
});
