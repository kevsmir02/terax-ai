import { describe, expect, it } from "vitest";
import {
  buildWorktreeRequest,
  fieldMessages,
  initialWorktreeForm,
  localProblems,
  parseIncludeInput,
  skippedReasonText,
  worktreeResultLines,
  worktreeSpaceName,
  accessText,
  canOpenAsSpace,
  type WorktreeCreateForm,
} from "./createWorktree";

const form = (patch: Partial<WorktreeCreateForm> = {}): WorktreeCreateForm => ({
  ...initialWorktreeForm,
  taskSlug: "feature",
  branchName: "feature/lab",
  ...patch,
});

describe("worktree creation form", () => {
  it("asks for the fields each location and branch mode actually needs", () => {
    expect(localProblems(form({ location: "managed" }))).toEqual([]);
    expect(
      localProblems(form({ location: "managed", taskSlug: " " })).map(
        (problem) => problem.field,
      ),
    ).toEqual(["path"]);
    expect(
      localProblems(form({ location: "managed", taskSlug: "a/b" })).map(
        (problem) => problem.field,
      ),
    ).toEqual(["path"]);

    expect(
      localProblems(form({ location: "custom", path: "relative/wt" })).map(
        (problem) => problem.field,
      ),
    ).toEqual(["path"]);
    expect(
      localProblems(form({ location: "custom", path: "/tmp/../wt" })).map(
        (problem) => problem.field,
      ),
    ).toEqual(["path"]);

    for (const branchMode of ["newBranch", "existingBranch"] as const) {
      expect(
        localProblems(form({ branchMode, branchName: " " })).map(
          (problem) => problem.field,
        ),
      ).toEqual(["branch"]);
    }
    expect(localProblems(form({ branchMode: "detach" }))).toEqual([]);
  });

  it("rejects branch and revision syntax that git can never accept", () => {
    for (const branchName of [
      "bad branch",
      "-rf",
      "a..b",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "dir/",
      "dir/.hidden",
      "dir/name.lock",
      "a//b",
      "@{upstream}",
    ]) {
      expect(
        localProblems(form({ branchName })).map((problem) => problem.field),
        branchName,
      ).toEqual(["branch"]);
    }
    for (const base of ["HEAD~1", "origin/main", "abc123", ""]) {
      expect(localProblems(form({ base })), base).toEqual([]);
    }
    for (const base of ["--all", "a b", "a..b"]) {
      expect(
        localProblems(form({ base })).map((problem) => problem.field),
        base,
      ).toEqual(["base"]);
    }
  });

  it("keeps ignored-file patterns inside the repository and bounded", () => {
    expect(parseIncludeInput(" .env, .env.* \n config/local.json ")).toEqual([
      ".env",
      ".env.*",
      "config/local.json",
    ]);
    expect(parseIncludeInput(".env, .env")).toEqual([".env"]);
    expect(parseIncludeInput("")).toEqual([]);

    for (const include of [
      "../secret",
      "/etc/passwd",
      "!keep",
      ".git/config",
      "C:/secret",
      "a\\b",
      "a//b",
    ]) {
      expect(
        localProblems(form({ include })).map((problem) => problem.field),
        include,
      ).toEqual(["include"]);
    }
    const tooMany = Array.from({ length: 65 }, (_, i) => `.env.${i}`).join(
      "\n",
    );
    expect(
      localProblems(form({ include: tooMany })).map((problem) => problem.field),
    ).toEqual(["include"]);
    expect(localProblems(form({ include: ".env, apps/*/.env" }))).toEqual([]);
  });

  it("builds the request the native command takes, with nulls not empty strings", () => {
    expect(
      buildWorktreeRequest(form({ include: ".env, apps/*/.env" })),
    ).toEqual({
      path: null,
      taskSlug: "feature",
      branch: { mode: "newBranch", name: "feature/lab" },
      base: null,
      include: [".env", "apps/*/.env"],
    });
    expect(
      buildWorktreeRequest(
        form({
          location: "custom",
          path: " /work/wt ",
          branchMode: "detach",
          base: " main ",
          include: " ",
        }),
      ),
    ).toEqual({
      path: "/work/wt",
      taskSlug: null,
      branch: { mode: "detach" },
      base: "main",
      include: [],
    });
  });

  it("groups native problems by the field they belong to", () => {
    expect(
      fieldMessages([
        { field: "base", message: "does-not-exist does not name a commit" },
        { field: "branch", message: "branch main is already checked out" },
        { field: "branch", message: "second branch problem" },
      ]),
    ).toEqual({
      base: "does-not-exist does not name a commit",
      branch: "branch main is already checked out",
    });
  });
});

describe("worktree creation result", () => {
  it("reports copied and skipped included files without claiming an overwrite", () => {
    const lines = worktreeResultLines({
      path: "/work/wt",
      branch: "feature/lab",
      head: "abc123",
      detached: false,
      copied: [".env"],
      skipped: [{ path: "config/local.json", reason: "already-exists" }],
      includeTruncated: true,
    });
    expect(lines).toEqual([
      "Copied .env",
      "Did not copy config/local.json: already exists in the worktree — left untouched",
      "The copy limits ran out; some ignored files were not copied. Nothing was overwritten.",
    ]);
    expect(skippedReasonText("symlink")).toContain("symlink");
    expect(skippedReasonText("budget-exceeded")).toContain("64 MiB");
    expect(skippedReasonText("some-new-reason")).toBe("some-new-reason");
    expect(
      worktreeResultLines({
        path: "/work/wt",
        branch: null,
        head: "abc123",
        detached: true,
        copied: [],
        skipped: [],
        includeTruncated: false,
      }),
    ).toEqual([]);
  });

  it("names the new Space after the branch, else the folder", () => {
    const result = {
      path: "/work/one/feature-x",
      branch: "feature/x",
      head: "abc",
      detached: false,
      copied: [],
      skipped: [],
      includeTruncated: false,
    };
    expect(worktreeSpaceName(result)).toBe("feature/x");
    expect(worktreeSpaceName({ ...result, branch: null })).toBe("feature-x");
  });

  it("only offers a Space when the app has access to the folder", () => {
    expect(canOpenAsSpace("derived")).toBe(true);
    expect(canOpenAsSpace("root")).toBe(true);
    expect(canOpenAsSpace("covered")).toBe(true);
    expect(canOpenAsSpace("none")).toBe(false);
    expect(canOpenAsSpace(null)).toBe(false);
    expect(accessText("derived")).toContain("linked worktree");
    expect(accessText("none")).toContain("cannot be opened");
  });
});
