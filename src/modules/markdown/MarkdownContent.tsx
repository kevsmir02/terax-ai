// Rendered Markdown surface: sanitised HTML, local images through the shared
// asset policy, and the shared fenced-code renderer. Document read/watch
// lifecycle belongs to `MarkdownPreviewPane`; this component only draws text.

import { memo, useMemo } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { checkReadable } from "@/modules/workspace/policy";
import {
  MarkdownCode,
  type MarkdownCodeProps,
} from "./components/MarkdownCode";
import {
  MarkdownImage,
  type MarkdownImageProps,
  MarkdownImageVisibility,
} from "./components/MarkdownImage";
import { rehypeLocalImages } from "./lib/assetPath";
import { markdownRenderKey } from "./lib/documentAssets";
import { MarkdownLink } from "./MarkdownLink";

export type MarkdownContentProps = {
  /** Path of the rendered document; relative images resolve against it. */
  path: string;
  /** The tab that owns the decoded-viewer slots for inline images. */
  tabId?: number;
  /** False while the tab is not on screen: inline images do no work. */
  visible?: boolean;
  /** The folder local images may come from (`previewBoundary`). */
  boundary: string;
  content: string;
  /** Asset URL for an allowed local image; undefined before the grant lands. */
  assetUrlFor?: (absolutePath: string) => string | undefined;
  assetError?: string;
  onRetryImages?: () => void;
  /** Files the person explicitly allowed beyond the boundary. */
  grantedAssets?: ReadonlySet<string>;
  /** True only after the person chose to load this document's remote images. */
  allowRemote?: boolean;
  /** Changes when the native asset grant set changes. */
  assetVersion?: number;
  /** False above the approved 4 MiB syntax ceiling. */
  syntax?: boolean;
};

export const MarkdownContent = memo(function MarkdownContent({
  path,
  tabId = 0,
  visible = true,
  boundary,
  content,
  assetUrlFor,
  assetError,
  onRetryImages,
  grantedAssets,
  allowRemote = false,
  assetVersion = 0,
  syntax = true,
}: MarkdownContentProps) {
  const components = useMemo(
    () => ({
      a: MarkdownLink,
      code: (props: MarkdownCodeProps) => (
        <MarkdownCode {...props} syntax={syntax} />
      ),
      img: (props: Omit<MarkdownImageProps, "tabId" | "documentPath">) => (
        <MarkdownImage {...props} tabId={tabId} documentPath={path} />
      ),
    }),
    [syntax, tabId, path],
  );
  const rehypePlugins = useMemo(() => {
    const d = defaultRehypePlugins;
    return [
      d.raw,
      d.sanitize,
      rehypeLocalImages(path, (abs) => assetUrlFor?.(abs), {
        boundary,
        isReadable: (abs) => checkReadable(abs).ok,
        granted: grantedAssets,
        allowRemote,
      }),
      d.harden,
    ];
  }, [path, boundary, assetUrlFor, grantedAssets, allowRemote]);

  // Streamdown memoises on the text and does not compare the rehype plugin
  // props, so a policy change (a grant landing, remote consent, another
  // document's boundary) must remount it; otherwise the blocked placeholders
  // would stay forever.
  const renderKey = markdownRenderKey({
    path,
    boundary,
    allowRemote,
    granted: grantedAssets,
    assetVersion,
  });

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
      <MarkdownImageVisibility.Provider value={visible}>
        <Streamdown
          key={renderKey}
          className="select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          components={components}
          rehypePlugins={rehypePlugins}
          mode="static"
          parseIncompleteMarkdown={false}
        >
          {content}
        </Streamdown>
      </MarkdownImageVisibility.Provider>
    </>
  );
});
