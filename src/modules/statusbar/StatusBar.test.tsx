// @vitest-environment jsdom

import { StatusBar } from "@/modules/statusbar";
import { LOCAL_WORKSPACE, useWorkspaceEnvStore } from "@/modules/workspace";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformState = vi.hoisted(() => ({ isWindows: false }));

vi.mock("@/lib/platform", () => ({
  IS_MAC: false,
  get IS_WINDOWS() {
    return platformState.isWindows;
  },
  USE_CUSTOM_WINDOW_CONTROLS: false,
  MOD_PROP: "ctrl",
  isPrimaryModifierPressed: () => false,
  KEY_SEP: "+",
  fmtShortcut: (...parts: string[]) => parts.join("+"),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  platformState.isWindows = false;
  useWorkspaceEnvStore.setState({
    env: LOCAL_WORKSPACE,
    distros: [],
    loading: false,
    error: null,
  });
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
});

function renderStatusBar(props?: Partial<Parameters<typeof StatusBar>[0]>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const onCd = props?.onCd ?? vi.fn();
  const onWorkspaceChange = props?.onWorkspaceChange ?? vi.fn();
  act(() => {
    root?.render(
      <StatusBar
        cwd={props?.cwd ?? "/home/user/projects/app"}
        filePath={props?.filePath}
        home={props?.home ?? "/home/user"}
        onCd={onCd}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );
  });
  return { host, onCd, onWorkspaceChange };
}

describe("StatusBar", () => {
  it("renders a solid border-t border-border hairline on the outer footer without re-painting bg-frame", () => {
    const { host: container } = renderStatusBar();
    const footer = container.querySelector("footer");
    expect(footer).not.toBeNull();
    const classes = footer?.className.split(/\s+/) ?? [];
    expect(classes).toContain("border-t");
    expect(classes).toContain("border-border");
    expect(classes).not.toContain("bg-frame");
  });

  it("preserves CwdBreadcrumb directory navigation in terminal mode", () => {
    const onCd = vi.fn();
    const { host: container } = renderStatusBar({
      cwd: "/home/user/projects/app",
      home: "/home/user",
      onCd,
    });

    const projectsBtn = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "projects",
    );
    expect(projectsBtn).toBeDefined();
    act(() => {
      projectsBtn?.click();
    });
    expect(onCd).toHaveBeenCalledWith("/home/user/projects");
  });

  it("preserves CwdBreadcrumb file breadcrumbs and directory navigation in non-terminal mode", () => {
    const onCd = vi.fn();
    const { host: container } = renderStatusBar({
      cwd: "/home/user/projects/app",
      filePath: "/home/user/projects/app/src/main.ts",
      home: "/home/user",
      onCd,
    });

    expect(container.textContent).toContain("main.ts");
    const srcBtn = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "src",
    );
    expect(srcBtn).toBeDefined();
    act(() => {
      srcBtn?.click();
    });
    expect(onCd).toHaveBeenCalledWith("/home/user/projects/app/src");
  });

  it("preserves WorkspaceEnvSelector for switching workspace environments on Windows", () => {
    platformState.isWindows = true;
    useWorkspaceEnvStore.setState({
      env: LOCAL_WORKSPACE,
      distros: [{ name: "Ubuntu", default: true, running: true }],
      loading: false,
      error: null,
    });
    const onWorkspaceChange = vi.fn();
    const { host: container } = renderStatusBar({ onWorkspaceChange });

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[title="Workspace environment"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("Windows");

    act(() => {
      trigger?.focus();
      trigger?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    const ubuntuItem = Array.from(
      menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    ).find((item) => item.textContent?.includes("WSL: Ubuntu"));
    expect(ubuntuItem).toBeDefined();

    act(() => {
      ubuntuItem?.click();
    });
    expect(onWorkspaceChange).toHaveBeenCalledWith({
      kind: "wsl",
      distro: "Ubuntu",
    });
  });
});
