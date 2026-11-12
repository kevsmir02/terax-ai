// Rendered Markdown surface: sanitised HTML, local images through the shared
// asset policy, and the shared fenced-code renderer. Document read/watch
// lifecycle belongs to `MarkdownPreviewPane`; this component only draws text.

import { memo, useMemo } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { checkReadable } from "@/modules/workspace/policy";
import { MarkdownCode } from "./components/MarkdownCode";
import { rehypeLocalImages } from "./lib/assetPath";
import { MarkdownLink } from "./MarkdownLink";

const components = { a: MarkdownLink, code: MarkdownCode };

export type MarkdownContentProps = {
  /** Path of the rendered document; relative images resolve against it. */
  path: string;
  /** The folder local images may come from (`previewBoundary`). */
  boundary: string;
  content: string;
  /** Asset URL for an allowed local image; undefined before the grant lands. */
  assetUrlFor?: (absolutePath: string) => string | undefined;
  assetError?: string;
  onRetryImages?: () => void;
};

export const MarkdownContent = memo(function MarkdownContent({
  path,
  boundary,
  content,
  assetUrlFor,
  assetError,
  onRetryImages,
}: MarkdownContentProps) {
  const rehypePlugins = useMemo(() => {
    const d = defaultRehypePlugins;
    return [
      d.raw,
      d.sanitize,
      rehypeLocalImages(path, (abs) => assetUrlFor?.(abs) ?? "data:,", {
        boundary,
        isReadable: (abs) => checkReadable(abs).ok,
      }),
      d.harden,
    ];
  }, [path, boundary, assetUrlFor]);

  return (
    <>
      {assetError && (
        <div className="mb-3 text-xs text-muted-foreground">
          <p role="alert">Local images unavailable: {assetError}</p>
          <button type="button" className="underline" onClick={onRetryImages}>
            Retry images
          </button>
        </div>
      )}
      <Streamdown
        className="select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        components={components}
        rehypePlugins={rehypePlugins}
        mode="static"
        parseIncompleteMarkdown={false}
      >
        {content}
      </Streamdown>
    </>
  );
});
