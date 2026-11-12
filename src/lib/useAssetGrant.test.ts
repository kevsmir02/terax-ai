import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effectDeps: [] as unknown[],
  cleanup: undefined as (() => void) | undefined,
  effect: undefined as (() => void | (() => void)) | undefined,
  invoke: vi.fn(),
  workspace: { kind: "local" },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: harness.invoke,
  convertFileSrc: (path: string) => `http://asset.localhost/${path}`,
}));
vi.mock("@/modules/workspace", () => ({
  useWorkspaceEnvStore: () => harness.workspace,
  workspaceScopeKey: () => "local",
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const slot = harness.cursor++;
    if (!(slot in harness.states)) {
      harness.states[slot] =
        typeof initial === "function" ? (initial as () => unknown)() : initial;
    }
    return [
      harness.states[slot],
      (value: unknown) => {
        harness.states[slot] =
          typeof value === "function" ? value(harness.states[slot]) : value;
      },
    ];
  },
  useCallback: (callback: unknown) => callback,
  useMemo: (compute: () => unknown) => compute(),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    if (
      deps.some((value, index) => !Object.is(value, harness.effectDeps[index]))
    ) {
      harness.effect = effect;
      harness.effectDeps = deps;
    }
  },
}));
import { useAssetGrant } from "./useAssetGrant";

function render(
  path: string | null = "/repo/image.png",
  tabId: number | null = 1,
) {
  harness.cursor = 0;
  const result = useAssetGrant(path, tabId);
  if (harness.effect) {
    harness.cleanup?.();
    const effect = harness.effect;
    harness.effect = undefined;
    harness.cleanup = effect() || undefined;
  }
  return result;
}

function calls(command: string) {
  return harness.invoke.mock.calls.filter(([name]) => name === command);
}

function resolveGrants(token: string) {
  harness.invoke.mockImplementation((command: string) =>
    Promise.resolve(command === "asset_grant" ? token : undefined),
  );
}

function grantScope(): string {
  const call = calls("asset_grant")[0];
  expect(call).toBeDefined();
  return (call[1] as { scope: string }).scope;
}
beforeEach(() => {
  harness.cleanup?.();
  harness.states = [];
  harness.effectDeps = [];
  harness.cleanup = undefined;
  harness.effect = undefined;
  harness.invoke.mockReset();
  harness.invoke.mockResolvedValue(undefined);
});

it("shows a rejected grant and permits a successful retry", async () => {
  harness.invoke.mockRejectedValueOnce(
    new Error("too many active media grants"),
  );
  expect(render().urlFor("/repo/image.png")).toBeUndefined();
  await vi.waitFor(() =>
    expect(render().error).toContain("too many active media grants"),
  );
  resolveGrants("fresh-token");
  render().retry();
  expect(render().error).toBeUndefined();
  await vi.waitFor(() =>
    expect(render().urlFor("/repo/image.png")).toContain("token=fresh-token"),
  );
});

it("revokes a grant returned after its view unmounts", async () => {
  let finish: (token: string) => void = () => {};
  harness.invoke.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  render();
  harness.cleanup?.();
  harness.cleanup = undefined;
  finish("late-token");
  await vi.waitFor(() =>
    expect(harness.invoke).toHaveBeenCalledWith("asset_revoke", {
      token: "late-token",
    }),
  );
});

it("does not request a grant for a non-media view", () => {
  render(null);
  expect(harness.invoke).not.toHaveBeenCalled();
});

it("revokes the tab-owned scope when the surface unmounts", async () => {
  harness.invoke.mockResolvedValueOnce("token-1");
  render("/repo/image.png", 4);
  const scope = grantScope();
  expect(scope).toBeTruthy();
  await vi.waitFor(() =>
    expect(render("/repo/image.png", 4).urlFor("/repo/image.png")).toContain(
      "token=token-1",
    ),
  );
  harness.cleanup?.();
  harness.cleanup = undefined;
  harness.effect = undefined;
  expect(harness.invoke).toHaveBeenCalledWith("asset_revoke_scope", { scope });
});

it("does not install a delayed grant into a closed tab", async () => {
  const { assetScopes } = await import("./assetScopes");
  let finish: (token: string) => void = () => {};
  harness.invoke.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  render("/repo/image.png", 9);
  const scope = grantScope();
  // Tab close arrives while the native grant is still in flight.
  assetScopes.closeTab(9);
  finish("tab-closed-token");
  await vi.waitFor(() =>
    expect(harness.invoke).toHaveBeenCalledWith("asset_revoke", {
      token: "tab-closed-token",
    }),
  );
  expect(
    render("/repo/image.png", 9).urlFor("/repo/image.png"),
  ).toBeUndefined();
  expect(scope).toBeTruthy();
});

it("does not install a delayed grant for a replaced view", async () => {
  let finishFirst: (token: string) => void = () => {};
  harness.invoke.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finishFirst = resolve;
      }),
  );
  render("/repo/first.png", 1);
  // The pane now shows another file; its own grant resolves normally.
  resolveGrants("second-token");
  render("/repo/second.png", 1);
  await vi.waitFor(() =>
    expect(render("/repo/second.png", 1).urlFor("/repo/second.png")).toContain(
      "token=second-token",
    ),
  );
  finishFirst("stale-token");
  await vi.waitFor(() =>
    expect(harness.invoke).toHaveBeenCalledWith("asset_revoke", {
      token: "stale-token",
    }),
  );
  const current = render("/repo/second.png", 1);
  expect(current.urlFor("/repo/second.png")).toContain("token=second-token");
  expect(harness.invoke).not.toHaveBeenCalledWith("asset_revoke", {
    token: "second-token",
  });
});

it("permits the Windows media origin in both CSP directives", () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  for (const directive of ["img-src", "media-src"]) {
    const policy = config.app.security.csp
      .split(";")
      .find((value: string) => value.trim().startsWith(`${directive} `));
    expect(policy?.split(/\s+/)).toContain("http://asset.localhost");
  }
});
