// @vitest-environment jsdom
import { StatusBar } from "@/modules/statusbar";
import { LOCAL_WORKSPACE, useWorkspaceEnvStore } from "@/modules/workspace";
import { act, type ComponentProps } from "react";
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

let container: HTMLDivElement | null = null;
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
  container?.remove();
  container = null;
});

function mountStatusBar(props: Partial<ComponentProps<typeof StatusBar>> = {}) {
  const onCd = props.onCd ?? vi.fn();
  const onWorkspaceChange = props.onWorkspaceChange ?? vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <StatusBar
        cwd="/home/user/repo/sub"
        home="/home/user"
        onCd={onCd}
        onWorkspaceChange={onWorkspaceChange}
        {...props}
      />,
    );
  });
  return { container, onCd, onWorkspaceChange };
}

describe("StatusBar", () => {
  it("renders a solid border-t border-border hairline on the outer footer without re-painting bg-frame", () => {
    const { container: host } = mountStatusBar();
    const footer = host.querySelector("footer");
    expect(footer).not.toBeNull();
    const classes = footer?.className.split(/\s+/) ?? [];
    expect(classes).toContain("border-t");
    expect(classes).toContain("border-border");
    expect(classes).toContain("text-foreground");
    expect(classes).not.toContain("bg-frame");
  });

  it("renders empty directory notice without diluted opacity", () => {
    const { container: host } = mountStatusBar({ cwd: null, filePath: null });
    const footer = host.querySelector("footer");
    expect((footer?.className ?? "").split(/\s+/)).toContain("text-foreground");

    const empty = Array.from(host.querySelectorAll("span")).find(
      (el) => el.textContent === "no directory",
    );
    expect(empty).toBeDefined();
    const classes = (empty?.className ?? "").split(/\s+/);
    expect(classes).toContain("text-muted-foreground");
    expect(classes).not.toContain("text-muted-foreground/70");
  });

  it("renders crisp breadcrumb segments and current directory control and navigates on click", () => {
    const onCd = vi.fn();
    const { container: host } = mountStatusBar({ onCd });

    const badges = Array.from(
      host.querySelectorAll<HTMLElement>('[data-slot="badge"]'),
    );
    expect(badges.length).toBeGreaterThanOrEqual(2);
    for (const badge of badges) {
      const classes = (badge.className ?? "").split(/\s+/);
      expect(classes).toContain("border-border");
      expect(classes).toContain("bg-background");
      expect(classes).toContain("text-foreground");
    }

    const currentPage = host.querySelector<HTMLElement>(
      '[aria-current="page"]',
    );
    expect(currentPage?.textContent).toContain("sub");
    const pageClasses = (currentPage?.className ?? "").split(/\s+/);
    expect(pageClasses).toContain("text-foreground");
    expect(pageClasses).toContain("font-medium");

    const chevron = currentPage?.querySelector("svg");
    expect(chevron?.getAttribute("class") ?? "").not.toContain("opacity-70");

    const repoButton = Array.from(host.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "repo",
    );
    expect(repoButton).toBeDefined();
    act(() => {
      repoButton?.click();
    });
    expect(onCd).toHaveBeenCalledWith("/home/user/repo");
  });

  it("preserves CwdBreadcrumb directory navigation in terminal mode", () => {
    const onCd = vi.fn();
    const { container: host } = mountStatusBar({
      cwd: "/home/user/projects/app",
      home: "/home/user",
      onCd,
    });

    const projectsBtn = Array.from(host.querySelectorAll("button")).find(
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
    const { container: host } = mountStatusBar({
      cwd: "/home/user/projects/app",
      filePath: "/home/user/projects/app/src/main.ts",
      home: "/home/user",
      onCd,
    });

    expect(host.textContent).toContain("main.ts");
    const srcBtn = Array.from(host.querySelectorAll("button")).find(
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
    const { container: host } = mountStatusBar({ onWorkspaceChange });

    const trigger = host.querySelector<HTMLButtonElement>(
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
