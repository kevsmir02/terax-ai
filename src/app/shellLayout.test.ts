import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

describe("App shell layout flattening", () => {
  const appSource = readSource("app/App.tsx");
  const resizableSource = readSource("components/ui/resizable.tsx");

  it("removes floating .terax-pane wrappers and horizontal gutters from sidebar and workspace", () => {
    expect(appSource).not.toMatch(/\bterax-pane(?![a-zA-Z0-9_-])/);
    expect(appSource).not.toMatch(/pl-2\s+pr-0\.5/);
    expect(appSource).not.toMatch(/pl-0\.5\s+pr-2/);
  });

  it("uses flush 1px border-border hairlines via default ResizableHandle", () => {
    expect(appSource).toContain("<ResizableHandle />");
    expect(appSource).not.toContain("rounded-full bg-transparent");
    expect(resizableSource).toContain("w-px");
    expect(resizableSource).toContain("bg-border");
  });

  it("confines bg-frame to the outer Shell frame and paints opaque bg-background on Content stage", () => {
    const bgFrameMatches = appSource.match(/\bbg-frame\b/g) ?? [];
    expect(bgFrameMatches).toHaveLength(1);
    expect(appSource).toMatch(
      /<ResizablePanel\s+id="workspace"[\s\S]{0,200}\bbg-background\b/,
    );
  });
});
