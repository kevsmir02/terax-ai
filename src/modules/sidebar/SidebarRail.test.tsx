// @vitest-environment jsdom
import { SidebarRail } from "@/modules/sidebar";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function mountRail(
  activeView: "explorer" | "source-control" = "explorer",
  changedCount = 4,
  onSelectView = vi.fn(),
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <SidebarRail
        activeView={activeView}
        onSelectView={onSelectView}
        changedCount={changedCount}
      />,
    );
  });
  return { container, onSelectView };
}

describe("SidebarRail", () => {
  it("uses solid border hairlines, crisp active selection, and readable badge contrast", () => {
    const { container: host } = mountRail("explorer", 4);
    const rail = host.firstElementChild as HTMLElement;
    const railClasses = (rail?.className ?? "").split(/\s+/);

    expect(railClasses).toContain("border-t");
    expect(railClasses).toContain("border-border");
    expect(railClasses).not.toContain("border-border/60");
    expect(railClasses).not.toContain("bg-foreground/[0.025]");

    const filesBtn = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Files"]',
    );
    const gitBtn = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Git"]',
    );

    const activeClasses = (filesBtn?.className ?? "").split(/\s+/);
    expect(activeClasses).toContain("border");
    expect(activeClasses).toContain("border-border");
    expect(activeClasses).toContain("bg-accent");
    expect(activeClasses).toContain("text-foreground");
    expect(activeClasses).not.toContain("bg-foreground/[0.07]");
    expect(activeClasses).not.toContain("dark:bg-foreground/[0.09]");

    const inactiveClasses = (gitBtn?.className ?? "").split(/\s+/);
    expect(inactiveClasses).toContain("text-muted-foreground");
    expect(inactiveClasses).toContain("hover:text-foreground");
    expect(inactiveClasses).not.toContain("hover:bg-foreground/[0.045]");

    const badge = Array.from(gitBtn?.querySelectorAll("span") ?? []).find(
      (el) => el.textContent === "4",
    );
    expect(badge).toBeDefined();
    const badgeClasses = (badge?.className ?? "").split(/\s+/);
    expect(badgeClasses).toContain("border-border");
    expect(badgeClasses).toContain("text-foreground");
    expect(badgeClasses).not.toContain("border-border/60");
    expect(badgeClasses).not.toContain("text-muted-foreground/95");
  });

  it("reflects active view, omits change badge when changedCount is zero, and invokes onSelectView when toggled", () => {
    const onSelectView = vi.fn();
    const { container: host } = mountRail("explorer", 0, onSelectView);
    const buttons = Array.from(host.querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");
    expect(buttons[1]?.querySelectorAll("span")).toHaveLength(1);

    act(() => {
      buttons[1]?.click();
    });
    expect(onSelectView).toHaveBeenCalledWith("source-control");
  });
});
