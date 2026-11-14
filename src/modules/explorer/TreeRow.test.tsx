// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryRow, type RowActions } from "./TreeRow";

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

const noopActions: RowActions = {
  toggle: vi.fn(),
  beginRename: vi.fn(),
  commitRename: vi.fn(),
  cancelRename: vi.fn(),
};

describe("EntryRow", () => {
  it("lifts resting file label, selected row, and gitignored contrast", () => {
    const onOpenFile = vi.fn();
    const onSelectPath = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <div>
          <EntryRow
            path="/repo/src/index.ts"
            name="index.ts"
            isDir={false}
            isExpanded={false}
            depth={1}
            actions={noopActions}
            renameInProgress={false}
            isSelected={false}
            isRenaming={false}
            onOpenFile={onOpenFile}
            onSelectPath={onSelectPath}
          />
          <EntryRow
            path="/repo/src"
            name="src"
            isDir
            isExpanded
            depth={0}
            actions={noopActions}
            renameInProgress={false}
            isSelected
            isRenaming={false}
            onOpenFile={onOpenFile}
            onSelectPath={onSelectPath}
          />
          <EntryRow
            path="/repo/dist"
            name="dist"
            isDir
            isExpanded={false}
            depth={0}
            actions={noopActions}
            renameInProgress={false}
            isSelected={false}
            isRenaming={false}
            onOpenFile={onOpenFile}
            onSelectPath={onSelectPath}
            gitignored
          />
        </div>,
      );
    });

    const regularRow = container.querySelector<HTMLButtonElement>(
      '[data-fs-path="/repo/src/index.ts"]',
    );
    const selectedRow = container.querySelector<HTMLButtonElement>(
      '[data-fs-path="/repo/src"]',
    );
    const ignoredRow = container.querySelector<HTMLButtonElement>(
      '[data-fs-path="/repo/dist"]',
    );

    const regularClasses = (regularRow?.className ?? "").split(/\s+/);
    expect(regularClasses).toContain("text-foreground");
    expect(regularClasses).not.toContain("text-foreground/85");

    const selectedClasses = (selectedRow?.className ?? "").split(/\s+/);
    expect(selectedClasses).toContain("bg-accent");
    expect(selectedClasses).toContain("text-foreground");
    expect(selectedClasses).toContain("ring-1");
    expect(selectedClasses).toContain("ring-border");

    const ignoredClasses = (ignoredRow?.className ?? "").split(/\s+/);
    expect(ignoredClasses).toContain("text-muted-foreground");
    expect(ignoredClasses).not.toContain("text-muted-foreground/70");

    act(() => {
      regularRow?.click();
    });
    expect(onSelectPath).toHaveBeenCalledWith("/repo/src/index.ts", {
      shift: false,
      mod: false,
    });
    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/index.ts");
  });
});
