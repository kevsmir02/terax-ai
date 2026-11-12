import { cn } from "@/lib/utils";
import { sharedRootWarning, type SharedRoot } from "./lib/sharedRoots";

/** Marks a Space whose saved root is also another Space's, on purpose. */
export function SharedFolderBadge({
  group,
  className,
}: {
  group: SharedRoot;
  className?: string;
}) {
  return (
    <span
      data-shared-root={group.root}
      title={sharedRootWarning(group.root, group.names)}
      className={cn(
        "shrink-0 rounded border border-border/70 px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground/80",
        className,
      )}
    >
      Shared folder
    </span>
  );
}
