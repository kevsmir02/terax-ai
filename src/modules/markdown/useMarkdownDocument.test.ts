import { beforeEach, describe, expect, it, vi } from "vitest";

type Effect = {
  effect: () => void | (() => void);
  deps: unknown[];
  cleanup?: () => void;
};

const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<Effect | undefined>,
  pending: [] as Array<{ index: number; effect: Effect }>,
  cursor: 0,
  invoke: vi.fn(),
  fsChanged: null as null | ((paths: string[]) => void),
}));

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) {
      harness.states[index] =
        typeof initial === "function" ? (initial as () => unknown)() : initial;
    }
    return [
      harness.states[index],
      (value: unknown) => {
        harness.states[index] =
          typeof value === "function"
            ? (value as (previous: unknown) => unknown)(harness.states[index])
            : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    if (!harness.refs[index]) harness.refs[index] = { current: initial };
    return harness.refs[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = harness.cursor++;
    const previous = harness.effects[index];
    if (
      previous &&
      deps.length === previous.deps.length &&
      deps.every((value, i) => Object.is(value, previous.deps[i]))
    ) {
      return;
    }
    harness.pending.push({ index, effect: { effect, deps } });
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: harness.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    listen: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("@/modules/explorer/lib/watch", () => ({
  listenFsChanged: (callback: (paths: string[]) => void) => {
    harness.fsChanged = callback;
    return Promise.resolve(() => {});
  },
  watchAdd: () => {},
  watchRemove: () => {},
  parentDir: (path: string) => path.slice(0, path.lastIndexOf("/")),
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import { useMarkdownDocument } from "./useMarkdownDocument";

function render(path = "/proj/docs/readme.md", visible = true) {
  harness.cursor = 0;
  harness.pending = [];
  const result = useMarkdownDocument(path, visible);
  for (const entry of harness.pending) {
    const previous = harness.effects[entry.index];
    previous?.cleanup?.();
    const effect = { ...entry.effect };
    const cleanup = effect.effect();
    effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    harness.effects[entry.index] = effect;
  }
  harness.pending = [];
  return result;
}

function unmount() {
  for (const effect of harness.effects) effect?.cleanup?.();
  harness.effects = [];
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

beforeEach(() => {
  unmount();
  harness.states = [];
  harness.refs = [];
  harness.effects = [];
  harness.pending = [];
  harness.cursor = 0;
  harness.invoke.mockReset();
  harness.fsChanged = null;
  harness.invoke.mockResolvedValue({ kind: "text", content: "hello", size: 5 });
});

describe("useMarkdownDocument", () => {
  it("does not read a document that has never been shown", () => {
    render("/proj/docs/readme.md", false);
    expect(
      harness.invoke.mock.calls.filter(([name]) => name === "fs_read_file"),
    ).toEqual([]);
  });

  it("reads once the hidden document becomes visible", async () => {
    render("/proj/docs/readme.md", false);
    render("/proj/docs/readme.md", true);
    expect(
      harness.invoke.mock.calls.filter(([name]) => name === "fs_read_file"),
    ).toHaveLength(1);
    await settle();
    expect(render("/proj/docs/readme.md", true).status).toEqual({
      kind: "ready",
      content: "hello",
      size: 5,
    });
  });

  it("ignores a read that lands after the document unmounts", async () => {
    const read = deferred<unknown>();
    harness.invoke.mockImplementationOnce(() => read.promise);
    render();
    unmount();
    read.resolve({ kind: "text", content: "late", size: 4 });
    await settle();
    expect(harness.states[0]).toEqual({ kind: "loading" });
  });

  it("does not let an older read replace a newer one", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const reads = [first.promise, second.promise];
    harness.invoke.mockImplementation((name: string) =>
      name === "fs_read_file"
        ? reads.shift()
        : Promise.resolve("/proj/docs/readme.md"),
    );
    render("/proj/docs/readme.md", true);
    await settle();
    // A change while hidden only marks the document stale; showing it reads once.
    render("/proj/docs/readme.md", false);
    harness.fsChanged?.(["/proj/docs/readme.md"]);
    render("/proj/docs/readme.md", true);
    second.resolve({ kind: "text", content: "new", size: 3 });
    await settle();
    expect(harness.states[0]).toEqual({
      kind: "ready",
      content: "new",
      size: 3,
    });
    first.resolve({ kind: "text", content: "old", size: 3 });
    await settle();
    expect(harness.states[0]).toEqual({
      kind: "ready",
      content: "new",
      size: 3,
    });
  });

  it("re-reads through the explicit override only after the person asks", async () => {
    harness.invoke.mockResolvedValue({
      kind: "toolarge",
      size: 20_000_000,
      limit: 10_485_760,
    });
    render();
    await settle();
    expect(render().status).toMatchObject({
      kind: "toolarge",
      forced: false,
    });
    const lastRead = () => {
      const reads = harness.invoke.mock.calls.filter(
        ([name]) => name === "fs_read_file",
      );
      return reads[reads.length - 1];
    };
    expect(lastRead()).toEqual([
      "fs_read_file",
      expect.objectContaining({ force: false }),
    ]);

    harness.invoke.mockResolvedValue({
      kind: "text",
      content: "large",
      size: 20_000_000,
    });
    render().openAnyway();
    expect(lastRead()).toEqual([
      "fs_read_file",
      expect.objectContaining({ force: true }),
    ]);
    await settle();
    expect(render().status).toEqual({
      kind: "ready",
      content: "large",
      size: 20_000_000,
    });
  });
});
