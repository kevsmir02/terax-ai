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

function render(className?: string, isolated?: boolean) {
  return renderToStaticMarkup(
    createElement(SharedFolderBadge, { group, className, isolated }),
  );
}

describe("SharedFolderBadge", () => {
  it("says the folder is shared and names the other Space", () => {
    const html = render();

    expect(html).toContain("Shared folder");
    expect(html).toContain("Terax review");
    expect(html).toContain("Files and processes are shared");
  });

  it("clarifies shared repo configs, tools, and MCP/memory backends when an isolated Space shares the root", () => {
    const html = render(undefined, true);

    expect(html).toContain("Shared folder");
    expect(html).toContain(".mcp.json");
    expect(html).toContain(".claude/");
    expect(html).toContain("Git");
    expect(html).toContain("SSH");
    expect(html).toContain("cloud CLIs");
    expect(html).toContain("Engram");
    expect(html).toContain("CodeGraph");
    expect(html).toContain("pi-lens");
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
