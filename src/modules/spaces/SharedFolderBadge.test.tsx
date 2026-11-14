import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SharedRoot } from "./lib/sharedRoots";
import { SharedFolderBadge } from "./SharedFolderBadge";

const group: SharedRoot = {
  root: "/work/terax",
  spaceIds: ["a", "b"],
  names: ["Terax", "Terax review"],
};

function render(className?: string) {
  return renderToStaticMarkup(
    createElement(SharedFolderBadge, { group, className }),
  );
}

describe("SharedFolderBadge", () => {
  it("says the folder is shared and names the other Space", () => {
    const html = render();

    expect(html).toContain("Shared folder");
    expect(html).toContain("Terax review");
    expect(html).toContain("Files and processes are shared");
  });

  it("carries the normalized shared root for the app lab to read", () => {
    expect(render()).toContain('data-shared-root="/work/terax"');
  });

  it("uses undiluted border-border and text-muted-foreground contrast", () => {
    const html = render();
    expect(html).toContain("border-border ");
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain("border-border/70");
    expect(html).not.toContain("text-muted-foreground/80");
  });
});
