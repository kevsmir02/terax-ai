// @vitest-environment jsdom

import { SidebarRail } from "@/modules/sidebar";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

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

function renderRail(
  props?: Partial<{
    activeView: "explorer" | "source-control";
    onSelectView: (view: "explorer" | "source-control") => void;
    changedCount: number;
  }>,
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const onSelectView = props?.onSelectView ?? vi.fn();
  act(() => {
    root?.render(
      <SidebarRail
        activeView={props?.activeView ?? "explorer"}
        onSelectView={onSelectView}
        changedCount={props?.changedCount ?? 0}
      />,
    );
  });
  return { host, onSelectView };
}

describe("SidebarRail", () => {
  it("renders a solid border-t border-border hairline and crisp change badge border", () => {
    const { host: container } = renderRail({ changedCount: 3 });
    const rail = container.firstElementChild as HTMLElement | null;
    expect(rail).not.toBeNull();
    const classes = rail?.className.split(/\s+/) ?? [];
    expect(classes).toContain("border-t");
    expect(classes).toContain("border-border");
    expect(classes).not.toContain("border-border/60");

    const badge = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent?.trim() === "3",
    );
    expect(badge).not.toBeUndefined();
    const badgeClasses = badge?.className.split(/\s+/) ?? [];
    expect(badgeClasses).toContain("border-border");
    expect(badgeClasses).not.toContain("border-border/60");
  });

  it("reflects active view and invokes onSelectView when toggled", () => {
    const onSelectView = vi.fn();
    const { host: container } = renderRail({
      activeView: "explorer",
      onSelectView,
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");

    act(() => {
      buttons[1]?.click();
    });
    expect(onSelectView).toHaveBeenCalledWith("source-control");
  });
});
