// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloseDialogs } from "./CloseDialogs";

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

function baseProps(): React.ComponentProps<typeof CloseDialogs> {
  return {
    tabs: [],
    pendingCloseTab: null,
    closeSaveState: "idle",
    onCancelClose: vi.fn(),
    onConfirmClose: vi.fn(),
    onSaveAndClose: vi.fn(),
    pendingTerminalCloseTab: null,
    onCancelTerminalClose: vi.fn(),
    onConfirmTerminalClose: vi.fn(),
    pendingDeleteTabs: null,
    onCancelDeleteClose: vi.fn(),
    onConfirmDeleteClose: vi.fn(),
    pendingCloseMany: null,
    closeManyConfirming: false,
    closeManyIncomplete: false,
    onCancelCloseMany: vi.fn(),
    onConfirmCloseMany: vi.fn(),
    onSaveAndCloseMany: vi.fn(),
    pendingSpaceDelete: null,
    spaceName: "Client",
    spaceDeleteSaving: false,
    spaceDeleteIncomplete: false,
    onCancelSpaceDelete: vi.fn(),
    onConfirmSpaceDelete: vi.fn(),
    onSaveAndDeleteSpace: vi.fn(),
  };
}

describe("CloseDialogs Space private account hazards", () => {
  it("renders Clear private accounts hazard confirmation with local vs remote OAuth copy", () => {
    const onConfirmClear = vi.fn();
    const ExtraCloseDialogs = CloseDialogs as React.ComponentType<
      React.ComponentProps<typeof CloseDialogs> & {
        pendingClearPrivateAccounts?: {
          spaceId: string;
          spaceName: string;
          terminalCount: number;
          busyLeafIds: number[];
        } | null;
        clearPrivateAccountsBusy?: boolean;
        onCancelClearPrivateAccounts?: () => void;
        onConfirmClearPrivateAccounts?: () => void;
      }
    >;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ExtraCloseDialogs
          {...baseProps()}
          pendingClearPrivateAccounts={{
            spaceId: "sp-1",
            spaceName: "Client",
            terminalCount: 1,
            busyLeafIds: [20],
          }}
          clearPrivateAccountsBusy={false}
          onCancelClearPrivateAccounts={vi.fn()}
          onConfirmClearPrivateAccounts={onConfirmClear}
        />,
      );
    });

    const dialog = document.body.querySelector<HTMLElement>(
      "[data-clear-accounts-dialog]",
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Clear private accounts?");
    expect(dialog?.textContent).toMatch(/remote.*OAuth|does not revoke/i);
    expect(dialog?.textContent).toMatch(/in-memory tokens|stopped/i);

    const confirmBtn = Array.from(
      dialog?.querySelectorAll("button") ?? [],
    ).find((b) => b.textContent?.includes("Clear Private Accounts"));
    expect(confirmBtn).toBeDefined();
    act(() => {
      confirmBtn?.click();
    });
    expect(onConfirmClear).toHaveBeenCalledTimes(1);
  });

  it("renders retained-profile local-vs-remote OAuth copy in Delete Space dialog", () => {
    const ExtraCloseDialogs = CloseDialogs as React.ComponentType<
      React.ComponentProps<typeof CloseDialogs> & {
        spaceProfileContext?: {
          accountIsolation?: "default" | "isolated";
          hasRetainedProfiles?: boolean;
        };
      }
    >;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ExtraCloseDialogs
          {...baseProps()}
          pendingSpaceDelete={{
            spaceId: "sp-1",
            hazards: { dirtyIds: [], busyLeafIds: [] },
          }}
          spaceName="Client"
          spaceProfileContext={{
            accountIsolation: "default",
            hasRetainedProfiles: true,
          }}
        />,
      );
    });

    const dialog = document.body.querySelector<HTMLElement>(
      "[data-space-delete-dialog]",
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toMatch(
      /local.*credentials|private.*profiles/i,
    );
    expect(dialog?.textContent).toMatch(/remote.*OAuth|revoked/i);
  });
});
