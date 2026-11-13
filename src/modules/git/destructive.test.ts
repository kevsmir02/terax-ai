import { describe, expect, it, vi } from "vitest";
import {
  assessDestructiveAction,
  assertNoDestructiveMutation,
  assertNoDestructiveSave,
  assertNoDestructiveSpawn,
  createDestructiveGitGuard,
  createDestructiveMutationScope,
  destructivePlanMessage,
  destructiveMutationScope,
  resolveDestructiveUsage,
  type DestructiveAction,
  type DestructivePlan,
  type DestructiveUsage,
} from "./destructive";
import type { GitStatusSnapshot } from "./types";

const REPO = "/work/terax";
const WT = "/work/terax-feature";

function identity(path: string): Promise<string | null> {
  return Promise.resolve(path);
}

function status(
  changed: Array<
    Partial<{
      path: string;
      staged: boolean;
      unstaged: boolean;
      untracked: boolean;
      indexStatus: string;
      worktreeStatus: string;
      originalPath: string | null;
      statusLabel: string;
    }>
  >,
  repoRoot = REPO,
): GitStatusSnapshot {
  return {
    repoRoot,
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    isDetached: false,
    truncated: false,
    changedFiles: changed.map((file) => ({
      path: file.path ?? "src/a.ts",
      originalPath: file.originalPath ?? null,
      indexStatus: file.indexStatus ?? (file.staged ? "M" : " "),
      worktreeStatus: file.worktreeStatus ?? (file.unstaged ? "M" : " "),
      staged: file.staged ?? false,
      unstaged: file.unstaged ?? true,
      untracked: file.untracked ?? false,
      statusLabel: file.statusLabel ?? "Modified",
    })),
  };
}

function usage(input: Partial<DestructiveUsage> = {}): DestructiveUsage {
  return { buffers: [], terminals: [], ...input };
}

function buffer(
  overrides: Partial<DestructiveUsage["buffers"][number]> = {},
): DestructiveUsage["buffers"][number] {
  return {
    tabId: 7,
    spaceId: "space-b",
    spaceName: "Review",
    spaceRoot: REPO,
    path: `${REPO}/src/a.ts`,
    canonicalPath: `${REPO}/src/a.ts`,
    dirty: true,
    ...overrides,
  };
}

function terminal(
  overrides: Partial<DestructiveUsage["terminals"][number]> = {},
): DestructiveUsage["terminals"][number] {
  return {
    tabId: 9,
    leafId: 90,
    spaceId: "space-wt",
    spaceName: "Worktree",
    cwd: WT,
    canonicalCwd: WT,
    busy: true,
    ...overrides,
  };
}

const discard: DestructiveAction = {
  kind: "discard",
  repoRoot: REPO,
  worktreeRoot: REPO,
  entries: [{ path: "src/a.ts", untracked: false }],
};

async function assess(
  action: DestructiveAction,
  options: {
    status?: GitStatusSnapshot | null;
    usage?: DestructiveUsage;
  } = {},
): Promise<DestructivePlan> {
  return assessDestructiveAction({
    action,
    status: options.status ?? status([{ path: "src/a.ts", staged: true }]),
    usage: options.usage ?? usage(),
    canonicalize: identity,
  });
}

describe("destructive Git assessment", () => {
  it("finds a dirty buffer in another Space by canonical path", async () => {
    const plan = await assess(discard, {
      usage: usage({ buffers: [buffer()] }),
    });

    expect(plan.blockers).toEqual([
      expect.objectContaining({
        kind: "unsavedBuffer",
        tabId: 7,
        spaceName: "Review",
        canonicalPath: `${REPO}/src/a.ts`,
      }),
    ]);
    expect(plan.affected).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        canonicalPath: `${REPO}/src/a.ts`,
        indexEffect: "staysStaged",
      }),
    ]);
    expect(plan.requiresAcknowledgement.unsavedBuffers).toBe(true);
  });

  it("counts an outside-root editor view whose canonical file is inside the worktree", async () => {
    const plan = await assess(discard, {
      usage: usage({
        buffers: [
          buffer({
            tabId: 11,
            spaceId: "space-narrow",
            spaceName: "Packages",
            spaceRoot: `${REPO}/packages/app`,
            path: `${REPO}/packages/app/../src/a.ts`,
            canonicalPath: `${REPO}/src/a.ts`,
          }),
        ],
      }),
    });

    expect(plan.blockers).toEqual([
      expect.objectContaining({
        kind: "unsavedBuffer",
        tabId: 11,
        outsideSpaceRoot: true,
      }),
    ]);
  });

  it("does not block a dirty buffer at an unrelated path", async () => {
    const plan = await assess(discard, {
      usage: usage({
        buffers: [
          buffer({
            path: `${REPO}/README.md`,
            canonicalPath: `${REPO}/README.md`,
          }),
        ],
      }),
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.requiresAcknowledgement.unsavedBuffers).toBe(false);
  });

  it("blocks worktree removal on matching terminal work, including an uncertain probe", async () => {
    const action: DestructiveAction = {
      kind: "worktreeRemove",
      repoRoot: REPO,
      worktreeRoot: WT,
      force: true,
    };
    const plan = await assess(action, {
      status: status([], WT),
      usage: usage({
        terminals: [
          terminal({ leafId: 90, busy: true }),
          terminal({
            leafId: 91,
            cwd: `${WT}/src`,
            canonicalCwd: `${WT}/src`,
            busy: "uncertain",
          }),
          terminal({
            leafId: 92,
            cwd: `${REPO}/src`,
            canonicalCwd: `${REPO}/src`,
            busy: true,
          }),
        ],
      }),
    });

    expect(plan.blockers).toEqual([
      expect.objectContaining({
        kind: "activeTerminal",
        leafId: 90,
        busy: true,
      }),
      expect.objectContaining({
        kind: "activeTerminal",
        leafId: 91,
        busy: "uncertain",
      }),
    ]);
    expect(plan.activeWork.map((work) => work.leafId)).toEqual([90, 91]);
    expect(plan.force).toBe(true);
  });

  it("keeps staged-state effects visible for a discard", async () => {
    const plan = await assess(discard, {
      status: status([
        { path: "src/a.ts", staged: true, unstaged: true },
        { path: "src/b.ts", staged: false, unstaged: true },
      ]),
    });

    expect(plan.affected.map((path) => [path.path, path.indexEffect])).toEqual([
      ["src/a.ts", "staysStaged"],
    ]);
    expect(destructivePlanMessage(plan)).toContain("staged copy stays staged");
  });

  it("describes affected paths, unsaved buffers, active work and force honestly", async () => {
    const action: DestructiveAction = {
      kind: "worktreeRemove",
      repoRoot: REPO,
      worktreeRoot: WT,
      force: true,
    };
    const plan = await assess(action, {
      status: status([], WT),
      usage: usage({
        buffers: [
          buffer({ path: `${WT}/src/a.ts`, canonicalPath: `${WT}/src/a.ts` }),
        ],
        terminals: [terminal()],
      }),
    });

    const message = destructivePlanMessage(plan);
    expect(message).toContain("Remove worktree");
    expect(message).toContain(`${WT}/src/a.ts`);
    expect(message).toContain('Space "Review"');
    expect(message).toContain('Space "Worktree"');
    expect(message).toContain("Force does not");
    expect(message).toContain("outside the application's control");
  });
});

describe("resolving live usage", () => {
  it("canonicalizes buffers and terminals, and treats a failed probe as uncertain", async () => {
    const resolved = await resolveDestructiveUsage(
      {
        buffers: [
          {
            tabId: 7,
            spaceId: "space-b",
            spaceName: "Review",
            spaceRoot: REPO,
            path: `${REPO}/src/a.ts`,
            dirty: true,
          },
        ],
        terminals: [
          {
            tabId: 9,
            leafId: 90,
            spaceId: "space-wt",
            spaceName: "Worktree",
            cwd: `${WT}/src`,
          },
        ],
        isBusy: async () => {
          throw new Error("probe unavailable");
        },
      },
      async (path) => `${path}-canonical`,
    );

    expect(resolved.buffers[0]?.canonicalPath).toBe(
      `${REPO}/src/a.ts-canonical`,
    );
    expect(resolved.terminals[0]).toEqual(
      expect.objectContaining({
        canonicalCwd: `${WT}/src-canonical`,
        busy: "uncertain",
      }),
    );
  });
});

describe("destructive Git guard", () => {
  it("refuses confirmation until every unsaved buffer is acknowledged", async () => {
    const mutate = vi.fn(async () => {});
    const guard = createDestructiveGitGuard({
      inspect: (action) =>
        assess(action, { usage: usage({ buffers: [buffer()] }) }),
      mutate,
    });
    const plan = await guard.request(discard);
    expect(plan).not.toBeNull();

    const withoutAck = await guard.confirm({
      fingerprint: plan?.fingerprint ?? "",
    });
    expect(withoutAck.status).toBe("unacknowledged");
    expect(mutate).not.toHaveBeenCalled();

    const withAck = await guard.confirm({
      fingerprint: plan?.fingerprint ?? "",
      unsavedBuffers: [7],
    });
    expect(withAck.status).toBe("done");
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("refuses a plan whose work changed after the dialog opened", async () => {
    let dirty = true;
    const mutate = vi.fn(async () => {});
    const guard = createDestructiveGitGuard({
      inspect: (action) =>
        assess(action, {
          usage: usage({
            buffers: [
              dirty
                ? buffer()
                : buffer({
                    tabId: 8,
                    dirty: true,
                    path: `${REPO}/src/c.ts`,
                    canonicalPath: `${REPO}/src/c.ts`,
                  }),
            ],
          }),
        }),
      mutate,
    });
    const first = await guard.request(discard);
    dirty = false;
    const result = await guard.confirm({
      fingerprint: first?.fingerprint ?? "",
      unsavedBuffers: [7],
    });

    expect(result.status).toBe("stale");
    expect(mutate).not.toHaveBeenCalled();
    if (result.status === "stale") {
      expect(result.plan.fingerprint).not.toBe(first?.fingerprint);
    }
  });

  it("does not let force bypass unsaved-buffer protection", async () => {
    const forceAction: DestructiveAction = {
      kind: "worktreeRemove",
      repoRoot: REPO,
      worktreeRoot: WT,
      force: true,
    };
    const mutate = vi.fn(async () => {});
    const guard = createDestructiveGitGuard({
      inspect: (action) =>
        assess(action, {
          status: status([], WT),
          usage: usage({
            buffers: [
              buffer({
                path: `${WT}/src/a.ts`,
                canonicalPath: `${WT}/src/a.ts`,
              }),
            ],
          }),
        }),
      mutate,
    });
    const plan = await guard.request(forceAction);
    const result = await guard.confirm({
      fingerprint: plan?.fingerprint ?? "",
      force: true,
    });

    expect(result.status).toBe("unacknowledged");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("holds the mutation scope while executing, then releases it", async () => {
    const scope = createDestructiveMutationScope();
    let release: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guard = createDestructiveGitGuard({
      inspect: (action) =>
        assess(action, {
          status: status([{ path: "src/a.ts" }]),
          usage: usage(),
        }),
      mutate: async () => running,
      scope,
    });
    const plan = await guard.request(discard);
    const confirmed = guard.confirm({ fingerprint: plan?.fingerprint ?? "" });
    await vi.waitFor(() => expect(scope.active()).not.toBeNull());

    expect(await scope.saveRefusal(`${REPO}/src/a.ts`)).toContain(
      "destructive Git action",
    );
    expect(await scope.saveRefusal(`${REPO}/README.md`)).toBeNull();
    expect(await scope.mutationRefusal(REPO)).toContain(
      "destructive Git action",
    );
    expect(await scope.spawnRefusal(`${REPO}/src`)).toContain(
      "destructive Git action",
    );

    release();
    expect((await confirmed).status).toBe("done");
    expect(await scope.saveRefusal(`${REPO}/src/a.ts`)).toBeNull();
    expect(await scope.mutationRefusal(REPO)).toBeNull();
  });

  it("blocks the app-owned save, spawn and mutation entry points while executing", async () => {
    const plan = await assess(discard, {
      status: status([{ path: "src/a.ts" }]),
    });
    const token = destructiveMutationScope.begin(plan);
    try {
      await expect(assertNoDestructiveSave(`${REPO}/src/a.ts`)).rejects.toThrow(
        "destructive Git action",
      );
      await expect(assertNoDestructiveSpawn(`${REPO}/src`)).rejects.toThrow(
        "destructive Git action",
      );
      await expect(assertNoDestructiveMutation(REPO)).rejects.toThrow(
        "destructive Git action",
      );
      await expect(
        assertNoDestructiveSave(`${REPO}/README.md`),
      ).resolves.toBeUndefined();
    } finally {
      destructiveMutationScope.end(token.id);
    }
  });

  it("refuses a second destructive action while one is executing", async () => {
    const scope = createDestructiveMutationScope();
    let release: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guard = createDestructiveGitGuard({
      inspect: (action) => assess(action),
      mutate: async () => running,
      scope,
    });
    const plan = await guard.request(discard);
    const first = guard.confirm({ fingerprint: plan?.fingerprint ?? "" });
    await Promise.resolve();
    const second = await guard.request(discard);

    expect(second).toBeNull();
    release();
    await first;
  });
});

describe("checkpoint restore through the shared guard", () => {
  const previewFingerprint = "native-preview";
  const restore: DestructiveAction = {
    kind: "restore",
    repoRoot: REPO,
    worktreeRoot: WT,
    ref: "refs/codr/manual-checkpoints/abc",
    paths: ["src/a.ts"],
    previewFingerprint,
  };

  it("names only the paths the native preflight will change", async () => {
    const plan = await assess(restore, {
      status: status([
        { path: "src/a.ts", staged: true, unstaged: true },
        { path: "src/unrelated.ts", unstaged: true },
      ]),
    });
    expect(plan.affected.map((path) => path.path)).toEqual(["src/a.ts"]);
    expect(plan.fingerprint).toContain(previewFingerprint);
    expect(destructivePlanMessage(plan)).toContain("src/a.ts");
    expect(destructivePlanMessage(plan)).not.toContain("src/unrelated.ts");
  });

  it("still blocks a dirty buffer anywhere in the worktree a restore can reach", async () => {
    const plan = await assess(restore, {
      status: status([{ path: "src/a.ts", unstaged: true }]),
      usage: usage({
        buffers: [buffer({ path: `${WT}/src/other.ts` })],
      }),
    });
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]?.kind).toBe("unsavedBuffer");
    expect(plan.requiresAcknowledgement.unsavedBuffers).toBe(true);
  });

  it("binds the confirmation to the native preview fingerprint", async () => {
    let current = restore;
    const guard = createDestructiveGitGuard({
      inspect: async () =>
        assess(current, {
          status: status([{ path: "src/a.ts", unstaged: true }]),
        }),
      mutate: async () => {},
    });
    const plan = await guard.request(restore);
    // A native re-preview that changed the fingerprint is a different plan:
    // the old confirmation is stale instead of silently restoring.
    current = { ...restore, previewFingerprint: "new" };
    const result = await guard.confirm({
      fingerprint: plan?.fingerprint ?? "",
    });
    expect(result.status).toBe("stale");
  });
});
