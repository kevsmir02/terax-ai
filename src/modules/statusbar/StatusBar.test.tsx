// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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
  return { container, onCd };
}

describe("StatusBar", () => {
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
});
