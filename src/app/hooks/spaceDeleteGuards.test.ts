import type { Tab } from "@/modules/tabs";
import { describe, expect, it, vi } from "vitest";
import {
  type SpaceDeleteDeps,
  SpaceDeleteGuard,
  spaceDeleteMessage,
  spaceHazardSnapshot,
} from "./spaceDeleteGuards";

function term(id: number, spaceId: string, leafIds: number[]): Tab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    paneTree:
      leafIds.length === 1
        ? { kind: "leaf", id: leafIds[0] }
        : {
            kind: "split",
            id: id * 100,
            dir: "row",
            children: leafIds.map((leafId) => ({ kind: "leaf", id: leafId })),
          },
    activeLeafId: leafIds[0],
  } as Tab;
}

function editor(id: number, spaceId: string, dirty: boolean): Tab {
  return {
    id,
    kind: "editor",
    spaceId,
    title: "notes.md",
    path: "/work/notes.md",
    dirty,
    preview: false,
  };
}

function harness(over: Partial<SpaceDeleteDeps> = {}) {
  const commit = vi.fn();
  const isBusy = vi.fn(async (_leafId: number) => false);
  const deps: SpaceDeleteDeps = {
    tabs: () => [
      editor(1, "a", true),
      term(2, "a", [20]),
      editor(3, "b", false),
    ],
    isBusy,
    confirmRunning: () => true,
    deleteOrganization: commit,
    ...over,
  };
  return { deps, commit, isBusy };
}

describe("space hazard snapshot", () => {
  it("uses the authoritative buffer state when the tab list lags a save", () => {
    const tabs = [editor(1, "a", true), term(2, "a", [20])];
    expect(spaceHazardSnapshot(tabs, "a", () => false)).toEqual({
      dirtyIds: [],
      leafIds: [20],
    });
  });

  it("counts only the tabs of the Space being deleted", () => {
    const tabs = [
      editor(1, "a", true),
      editor(2, "b", true),
      term(3, "a", [30, 31]),
      term(4, "b", [40]),
    ];

    expect(spaceHazardSnapshot(tabs, "a")).toEqual({
      dirtyIds: [1],
      leafIds: [30, 31],
    });
  });
});

describe("SpaceDeleteGuard", () => {
  it("asks before deleting even a clean Space and deletes only saved organization", async () => {
    const { deps, commit } = harness({
      tabs: () => [editor(1, "a", false), editor(3, "b", false)],
    });
    const guard = new SpaceDeleteGuard(deps);

    const pending = await guard.request("a");
    expect(pending).toMatchObject({ spaceId: "a" });
    expect(commit).not.toHaveBeenCalled();

    await expect(guard.confirm()).resolves.toMatchObject({ status: "deleted" });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith("a");
    expect(guard.current()).toBeNull();
  });

  it("summarizes dirty buffers and processes before deletion", async () => {
    const busy = vi.fn(async (leafId: number) => leafId === 20);
    const { deps } = harness({ isBusy: busy });
    const guard = new SpaceDeleteGuard(deps);

    const pending = await guard.request("a");
    expect(pending?.hazards).toEqual({ dirtyIds: [1], busyLeafIds: [20] });
    expect(busy).toHaveBeenCalledWith(20);

    if (!pending) throw new Error("the Space did not request confirmation");
    const message = spaceDeleteMessage(pending, deps.tabs());
    expect(message).toContain("1 file has unsaved changes");
    expect(message).toContain("1 process may still be running");
    expect(message).toContain("Files and worktrees on disk are not deleted");
  });

  it("inspects hazards without opening a transaction", async () => {
    const { deps, commit } = harness();
    const guard = new SpaceDeleteGuard(deps);

    await expect(guard.inspect("a")).resolves.toEqual({
      dirtyIds: [1],
      busyLeafIds: [],
    });
    expect(guard.current()).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it("cancel aborts everything and leaves the Space's work untouched", async () => {
    const { deps, commit } = harness();
    const guard = new SpaceDeleteGuard(deps);
    await guard.request("a");

    guard.cancel();

    expect(guard.current()).toBeNull();
    await expect(guard.confirm()).resolves.toMatchObject({ status: "idle" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("drops a request that was in flight when the user canceled", async () => {
    const gate: { release: () => void } = { release: () => {} };
    const waiting = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const { deps } = harness({
      isBusy: vi.fn(async () => {
        await waiting;
        return true;
      }),
    });
    const guard = new SpaceDeleteGuard(deps);

    const request = guard.request("a");
    guard.cancel();
    gate.release();
    await request;

    expect(guard.current()).toBeNull();
  });

  it("requires another confirmation when a buffer turned dirty during the check", async () => {
    let dirty = false;
    const { deps, commit } = harness({
      tabs: () => [editor(1, "a", dirty), editor(3, "b", false)],
    });
    const guard = new SpaceDeleteGuard(deps);
    await guard.request("a");

    dirty = true;
    await expect(guard.confirm()).resolves.toMatchObject({
      status: "needs-confirmation",
      pending: { hazards: { dirtyIds: [1] } },
    });
    expect(commit).not.toHaveBeenCalled();

    await expect(guard.confirm()).resolves.toMatchObject({ status: "deleted" });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("does not let a saved buffer's newer typing ride on the earlier acknowledgement", async () => {
    let dirty = true;
    const { deps, commit } = harness({
      tabs: () => [editor(1, "a", dirty), editor(3, "b", false)],
    });
    const guard = new SpaceDeleteGuard(deps);
    await guard.request("a");

    await expect(guard.confirm({ savedDirtyIds: [1] })).resolves.toMatchObject({
      status: "needs-confirmation",
    });
    expect(commit).not.toHaveBeenCalled();

    dirty = false;
    await expect(guard.confirm({ savedDirtyIds: [1] })).resolves.toMatchObject({
      status: "deleted",
    });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("commits once even when confirmation is requested repeatedly", async () => {
    const { deps, commit } = harness({
      tabs: () => [editor(3, "b", false), editor(1, "a", false)],
    });
    const guard = new SpaceDeleteGuard(deps);
    await guard.request("a");

    const [first, second] = await Promise.all([
      guard.confirm(),
      guard.confirm(),
    ]);

    expect(first.status).toBe("deleted");
    expect(second.status).toBe("deleted");
    expect(commit).toHaveBeenCalledOnce();
  });

  it("treats an uncertain process probe as a process to resolve", async () => {
    const { deps } = harness({
      isBusy: vi.fn(async () => {
        throw new Error("probe unavailable");
      }),
    });
    const guard = new SpaceDeleteGuard(deps);

    const pending = await guard.request("a");
    expect(pending?.hazards.dirtyIds).toEqual([1]);
    expect(pending?.hazards.busyLeafIds).toEqual([20]);
  });
});
