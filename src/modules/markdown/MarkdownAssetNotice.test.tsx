import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EMPTY_DOCUMENT_ASSETS,
  NO_DOCUMENT_ASSET_CONSENT,
  type DocumentAssetConsent,
  type DocumentAssetSummary,
} from "./lib/documentAssets";
import { MarkdownAssetNotice } from "./MarkdownAssetNotice";

function render(
  summary: DocumentAssetSummary,
  consent: DocumentAssetConsent = NO_DOCUMENT_ASSET_CONSENT,
) {
  return renderToStaticMarkup(
    createElement(MarkdownAssetNotice, {
      summary,
      consent,
      boundary: "/w/project",
      onAllowOutside: () => {},
      onLoadRemote: () => {},
    }),
  );
}

describe("MarkdownAssetNotice", () => {
  it("offers deliberate remote loading without embedding a URL", () => {
    const html = render({
      ...EMPTY_DOCUMENT_ASSETS,
      remote: ["https://tracker.example/pixel.png"],
    });
    expect(html).toContain("Load 1 remote image");
    expect(html).toContain("Nothing has been fetched");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("src=");
  });

  it("offers an explicit grant for images outside the boundary", () => {
    const html = render({
      ...EMPTY_DOCUMENT_ASSETS,
      outside: ["/elsewhere/pic.png"],
    });
    expect(html).toContain("Allow 1 image outside");
    expect(html).toContain("/w/project");
  });

  it("never offers a grant for a protected path", () => {
    const html = render({ ...EMPTY_DOCUMENT_ASSETS, blocked: 2 });
    expect(html).toContain("2 protected images stay blocked");
    expect(html).not.toContain("<button");
  });

  it("disappears once the person has made both choices", () => {
    expect(
      render(
        {
          outside: ["/elsewhere/pic.png"],
          remote: ["https://x.example/a.png"],
          blocked: 0,
        },
        { remote: true, granted: ["/elsewhere/pic.png"] },
      ),
    ).toBe("");
  });

  it("keeps asking for the choice that was not made", () => {
    const html = render(
      {
        outside: ["/elsewhere/pic.png"],
        remote: ["https://x.example/a.png"],
        blocked: 0,
      },
      { remote: true, granted: [] },
    );
    expect(html).not.toContain("Load 1 remote image");
    expect(html).toContain("Allow 1 image outside");
  });
});
