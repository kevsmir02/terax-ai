// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RecoveryStatusBar } from "@/modules/editor/RecoveryStatusBar";
import { MarkdownAssetNotice } from "@/modules/markdown/MarkdownAssetNotice";
import { MarkdownViewToggle } from "@/modules/markdown/MarkdownViewToggle";
import { PreviewAddressBar } from "@/modules/preview/PreviewAddressBar";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SRC_ROOT = resolve(import.meta.dirname, "..");

const NON_TERMINAL_VIEW_FILES = [
  "modules/editor/EditorPane.tsx",
  "modules/editor/RecoveryStatusBar.tsx",
  "modules/editor/RecoveryDraftBanner.tsx",
  "modules/editor/GitDiffPane.tsx",
  "modules/markdown/MarkdownPreviewPane.tsx",
  "modules/markdown/MarkdownViewToggle.tsx",
  "modules/markdown/MarkdownAssetNotice.tsx",
  "modules/markdown/components/MarkdownImageView.tsx",
  "modules/markdown/components/CodeBlock.tsx",
  "modules/git-history/GitHistoryPane.tsx",
  "modules/preview/PreviewAddressBar.tsx",
  "modules/preview/PreviewPane.tsx",
  "modules/preview/AssetPreview.tsx",
  "modules/preview/ImagePreviewView.tsx",
  "modules/preview/PdfReaderView.tsx",
  "modules/preview/MediaPreviewView.tsx",
] as const;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function cleanupNode() {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
}

afterEach(() => {
  cleanupNode();
});

function renderNode(element: React.ReactElement) {
  cleanupNode();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(element);
  });
  return host;
}

describe("non-terminal view hairlines and full-bleed framing", () => {
  it("renders crisp undiluted border-border hairlines in PreviewAddressBar, RecoveryStatusBar, MarkdownViewToggle, and MarkdownAssetNotice", () => {
    const previewContainer = renderNode(
      <PreviewAddressBar
        url="http://localhost:3000"
        onSubmit={vi.fn()}
        onReload={vi.fn()}
      />,
    );
    const previewRoot =
      previewContainer.firstElementChild as HTMLElement | null;
    expect(previewRoot?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["border-b", "border-border"]),
    );
    expect(previewRoot?.className).not.toContain("border-border/60");

    const recoveryContainer = renderNode(
      <RecoveryStatusBar
        status={{
          kind: "durable",
          bufferId: "buf-1",
          bufferRevision: 1,
          durableRevision: 1,
          bytes: 42,
          totalBytes: 42,
          scheduled: false,
        }}
        onRetry={vi.fn()}
      />,
    );
    const recoveryRoot =
      recoveryContainer.firstElementChild as HTMLElement | null;
    expect(recoveryRoot?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["border-b", "border-border"]),
    );
    expect(recoveryRoot?.className).not.toContain("border-border/60");

    const toggleContainer = renderNode(
      <MarkdownViewToggle mode="rendered" onChange={vi.fn()} />,
    );
    const toggleRoot = toggleContainer.firstElementChild as HTMLElement | null;
    expect(toggleRoot?.className.split(/\s+/)).toContain("border-border");
    expect(toggleRoot?.className).not.toContain("border-border/60");

    const noticeContainer = renderNode(
      <MarkdownAssetNotice
        summary={{
          outside: ["/tmp/outside.png"],
          remote: [],
          blocked: 0,
        }}
        consent={{ granted: [], remote: false }}
        boundary="/repo"
        onAllowOutside={vi.fn()}
        onLoadRemote={vi.fn()}
      />,
    );
    const noticeRoot = noticeContainer.firstElementChild as HTMLElement | null;
    expect(noticeRoot?.className.split(/\s+/)).toContain("border-border");
    expect(noticeRoot?.className).not.toContain("border-border/60");
  });

  it("keeps all non-terminal view sources free of floating card wrappers and diluted border-border/40..60 hairlines", () => {
    for (const file of NON_TERMINAL_VIEW_FILES) {
      const source = readFileSync(resolve(SRC_ROOT, file), "utf8");
      expect(source, `${file} should not use .terax-pane`).not.toMatch(
        /\bterax-pane(?![a-zA-Z0-9_-])/,
      );
      expect(
        source,
        `${file} should use solid border-border instead of /40../60 alpha dilutions`,
      ).not.toMatch(/\bborder-border\/(40|45|50|60)\b/);
    }
  });
});
