// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdater } from "./useUpdater";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "1.0.0"),
}));

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: () => "linux",
  arch: () => "x86_64",
}));

const currentManifest = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures", "stable-current.json"),
    "utf8",
  ),
) as Record<string, unknown>;
currentManifest.version = "1.0.0";

describe("useUpdater Tauri transport wiring", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("uses updater_fetch_manifest for autoCheck startup discovery in Tauri runtime", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const invoke = vi.fn(async () => ({
      status: 200,
      retryAfter: null,
      body: JSON.stringify(currentManifest),
    }));
    vi.stubGlobal("isTauri", true);
    Object.defineProperty(window, "isTauri", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: { invoke },
      configurable: true,
    });

    let latestState: ReturnType<typeof useUpdater>["state"] | null = null;
    function Harness() {
      const updater = useUpdater({ autoCheck: true });
      latestState = updater.state;
      return null;
    }

    await act(async () => {
      root.render(createElement(Harness));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(invoke.mock.calls[0]?.slice(0, 2)).toEqual([
      "updater_fetch_manifest",
      { endpointOverride: null },
    ]);
    expect(latestState).toMatchObject({
      kind: "up-to-date",
      latestVersion: "1.0.0",
    });
  });

  it("uses updater_fetch_manifest for manual Settings -> About checks and surfaces blocked failures", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const invoke = vi.fn(async () => {
      throw {
        reason: "blocked",
        detail: "TLS certificate error",
      };
    });
    vi.stubGlobal("isTauri", true);
    Object.defineProperty(window, "isTauri", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: { invoke },
      configurable: true,
    });

    const updaterRef: { current: ReturnType<typeof useUpdater> | null } = {
      current: null,
    };
    function Harness() {
      updaterRef.current = useUpdater({ autoCheck: false });
      return null;
    }

    await act(async () => {
      root.render(createElement(Harness));
    });
    expect(invoke).not.toHaveBeenCalled();

    await act(async () => {
      await updaterRef.current?.check({ manual: true });
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(invoke.mock.calls[0]?.slice(0, 2)).toEqual([
      "updater_fetch_manifest",
      { endpointOverride: null },
    ]);
    expect(updaterRef.current?.state).toMatchObject({
      kind: "check-failed",
      failure: {
        reason: "blocked",
        detail: "TLS certificate error",
        attempts: 1,
        retryable: false,
      },
    });
  });

  it("uses fetch instead of updater_fetch_manifest outside the Tauri runtime", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(currentManifest), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const invoke = vi.fn();
    vi.stubGlobal("isTauri", false);
    Object.defineProperty(window, "isTauri", {
      value: false,
      configurable: true,
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: { invoke },
      configurable: true,
    });

    const updaterRef: { current: ReturnType<typeof useUpdater> | null } = {
      current: null,
    };
    function Harness() {
      updaterRef.current = useUpdater({ autoCheck: false });
      return null;
    }

    await act(async () => {
      root.render(createElement(Harness));
    });
    await act(async () => {
      await updaterRef.current?.check({ manual: true });
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(updaterRef.current?.state).toMatchObject({
      kind: "up-to-date",
      latestVersion: "1.0.0",
    });
  });
});
