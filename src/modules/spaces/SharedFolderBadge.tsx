import { cn } from "@/lib/utils";
import {
  sharedRootWarningWithIsolation,
  type SharedRoot,
} from "./lib/sharedRoots";

/** Marks a Space whose saved root is also another Space's, on purpose. */
export function SharedFolderBadge({
  group,
  isolated = false,
  className,
}: {
  group: SharedRoot;
  isolated?: boolean;
  className?: string;
}) {
  return (
    <span
      data-shared-root={group.root}
      title={sharedRootWarningWithIsolation(group.root, group.names, isolated)}
      className={cn(
        "shrink-0 rounded border border-border bg-background px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
    >
      Shared folder
    </span>
  );
}
