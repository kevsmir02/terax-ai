import { useBlockController } from "@/modules/terminal/lib/blockController";
import { focusLeafInput } from "@/modules/terminal/lib/terminalSessionApi";
import { lazy, Suspense } from "react";

const ShellInput = lazy(() => import("@/modules/terminal/block/ShellInput"));

type Props = {
  isBlockTab: boolean;
  activeLeafId: number | null;
};

/**
 * Shell input for Blocks terminals. The combined Shell/AI input bar went with
 * the built-in chat composer (ticket #12); ordinary terminal tabs send keys
 * straight to the PTY, so nothing is rendered for them.
 */
export function WorkspaceInputBar({ isBlockTab, activeLeafId }: Props) {
  const controller = useBlockController(isBlockTab ? activeLeafId : null);
  if (!isBlockTab || activeLeafId === null || !controller) return null;

  return (
    <div
      data-block-input-bar
      className="shrink-0 border-t border-border bg-terminal-header px-3 py-2"
    >
      <div className="flex flex-col gap-2 rounded-lg px-1 py-1">
        <div className="flex items-end gap-2.5">
          <div className="relative min-w-0 flex-1">
            {controller.blockMode === "plain" ? (
              <button
                type="button"
                className="text-sm text-muted-foreground hover:text-foreground"
                onClick={() => focusLeafInput(activeLeafId)}
              >
                Type directly in the terminal
              </button>
            ) : (
              <Suspense fallback={null}>
                <ShellInput
                  leafId={activeLeafId}
                  mode={controller.blockMode}
                  focused
                  onSubmit={controller.submitCommand}
                  onInterrupt={controller.interrupt}
                  getCwd={controller.getCwd}
                />
              </Suspense>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
