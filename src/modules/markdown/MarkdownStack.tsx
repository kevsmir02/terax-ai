import { cn } from "@/lib/utils";
import type { MarkdownTab, Tab } from "@/modules/tabs";
import { MarkdownPreviewPane } from "./MarkdownPreviewPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  /**
   * Configured Space project roots, by Space id. A Markdown document resolves
   * its automatic local assets against this root (or, when the document lives
   * outside it, against the document's own directory). The mutable terminal cwd
   * is deliberately not an input.
   */
  spaceRoots?: Readonly<Record<string, string | null>>;
  onSetMarkdownView: (id: number, mode: "rendered" | "raw") => void;
};

export function MarkdownStack({
  tabs,
  activeId,
  spaceRoots = {},
  onSetMarkdownView,
}: Props) {
  const markdowns = tabs.filter(
    (t): t is MarkdownTab => t.kind === "markdown" && !t.cold,
  );
  if (markdowns.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {markdowns.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <MarkdownPreviewPane
              path={t.path}
              tabId={t.id}
              projectRoot={spaceRoots[t.spaceId] ?? null}
              visible={visible}
              onSetView={(mode) => onSetMarkdownView(t.id, mode)}
            />
          </div>
        );
      })}
    </div>
  );
}
