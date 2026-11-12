import { describe, expect, it } from "vitest";
import { checkReadable } from "@/modules/workspace/policy";
import {
  documentAssetSummary,
  grantDocumentAssets,
  markdownRenderKey,
  NO_DOCUMENT_ASSET_CONSENT,
} from "./documentAssets";

const policy = (boundary: string) => ({
  boundary,
  isReadable: (abs: string) => checkReadable(abs).ok,
});

describe("documentAssetSummary", () => {
  it("finds inline images and raw HTML image tags", () => {
    const summary = documentAssetSummary(
      [
        "![a](./a.png)",
        '<img src="https://cdn.example.com/b.png" alt="b">',
        "![c](../../../outside/c.png)",
        "![d](./notes.md)",
      ].join("\n\n"),
      "/w/p/docs/readme.md",
      policy("/w/p"),
    );

    expect(summary.remote).toEqual(["https://cdn.example.com/b.png"]);
    expect(summary.outside).toEqual(["/outside/c.png"]);
    expect(summary.blocked).toBe(0);
  });

  it("deduplicates repeated references and keeps order", () => {
    const summary = documentAssetSummary(
      "![a](./a.png)\n![a](./a.png)\n![b](https://x.example/a.png)\n![c](https://x.example/a.png)",
      "/w/p/readme.md",
      policy("/w/p"),
    );
    expect(summary.remote).toEqual(["https://x.example/a.png"]);
    expect(summary.outside).toEqual([]);
  });

  it("never offers a protected path as a grant", () => {
    const summary = documentAssetSummary(
      ["![secret](../.ssh/logo.png)", "![env](../.env.png)"].join("\n"),
      "/w/p/docs/readme.md",
      policy("/w/p"),
    );
    expect(summary.outside).toEqual([]);
    expect(summary.blocked).toBe(2);
  });

  it("anchors an outside document to its own folder, not a terminal cwd", () => {
    const doc = "/home/me/notes/readme.md";
    const summary = documentAssetSummary(
      "![same](./pic.png)\n![parent](../pic.png)\n![root](../../../w/p/pic.png)",
      doc,
      policy("/home/me/notes"),
    );
    expect(summary.outside).toEqual(["/home/me/pic.png", "/w/p/pic.png"]);
    expect(summary.blocked).toBe(0);
  });

  it("ignores image syntax inside a fenced code block", () => {
    const summary = documentAssetSummary(
      [
        "Example:",
        "",
        "```md",
        "![not-a-reference](https://example.com/example.png)",
        "```",
        "",
        "![real](../../outside.png)",
      ].join("\n"),
      "/w/p/docs/readme.md",
      policy("/w/p"),
    );
    expect(summary.remote).toEqual([]);
    expect(summary.outside).toEqual(["/w/outside.png"]);
  });

  it("does not report inline data or injected asset URLs", () => {
    const summary = documentAssetSummary(
      "![a](data:image/png;base64,AAAA)\n![b](asset://localhost/x.png)",
      "/w/p/readme.md",
      policy("/w/p"),
    );
    expect(summary).toEqual({ outside: [], remote: [], blocked: 0 });
  });
});

describe("markdownRenderKey", () => {
  const base = {
    path: "/w/p/docs/a.md",
    boundary: "/w/p",
    allowRemote: false,
    granted: new Set<string>(),
    assetVersion: 0,
  };

  it("is stable for the same policy", () => {
    expect(markdownRenderKey(base)).toBe(markdownRenderKey({ ...base }));
  });

  it("changes when a grant lands, consent is given or the document moves", () => {
    const landed = markdownRenderKey({ ...base, assetVersion: 1 });
    expect(landed).not.toBe(markdownRenderKey(base));
    const remote = markdownRenderKey({ ...base, allowRemote: true });
    expect(remote).not.toBe(markdownRenderKey(base));
    const outside = markdownRenderKey({
      ...base,
      granted: new Set(["/elsewhere/pic.png"]),
    });
    expect(outside).not.toBe(markdownRenderKey(base));
    const elsewhere = markdownRenderKey({ ...base, boundary: "/w/q" });
    expect(elsewhere).not.toBe(markdownRenderKey(base));
  });
});

describe("grantDocumentAssets", () => {
  const summary = {
    outside: ["/w/outside/a.png"],
    remote: ["https://x.example/a.png"],
    blocked: 0,
  };

  it("records the explicit choice for outside files only", () => {
    const next = grantDocumentAssets(
      summary,
      NO_DOCUMENT_ASSET_CONSENT,
      "outside",
    );
    expect(next.granted).toEqual(["/w/outside/a.png"]);
    expect(next.remote).toBe(false);
  });

  it("records deliberate remote loading without granting local files", () => {
    const next = grantDocumentAssets(
      summary,
      NO_DOCUMENT_ASSET_CONSENT,
      "remote",
    );
    expect(next.remote).toBe(true);
    expect(next.granted).toEqual([]);
  });

  it("keeps a previous grant when the other choice is made", () => {
    const outside = grantDocumentAssets(
      summary,
      NO_DOCUMENT_ASSET_CONSENT,
      "outside",
    );
    const both = grantDocumentAssets(summary, outside, "remote");
    expect(both).toEqual({ remote: true, granted: ["/w/outside/a.png"] });
  });

  it("ignores a summary with nothing to grant", () => {
    const empty = { outside: [], remote: [], blocked: 2 };
    expect(
      grantDocumentAssets(empty, NO_DOCUMENT_ASSET_CONSENT, "outside"),
    ).toEqual(NO_DOCUMENT_ASSET_CONSENT);
    expect(
      grantDocumentAssets(empty, NO_DOCUMENT_ASSET_CONSENT, "remote"),
    ).toEqual(NO_DOCUMENT_ASSET_CONSENT);
  });
});
