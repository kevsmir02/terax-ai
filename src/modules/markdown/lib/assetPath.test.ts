import { describe, expect, it } from "vitest";
import { checkReadable } from "@/modules/workspace/policy";
import {
  classifyImageReference,
  isAllowedLocalImage,
  isInsideRoot,
  previewBoundary,
  rehypeLocalImages,
  resolveRelativeAsset,
} from "./assetPath";

describe("resolveRelativeAsset", () => {
  const base = "/work/proj/docs/guide.md";

  it("resolves sibling and nested references", () => {
    expect(resolveRelativeAsset(base, "a.png")).toBe("/work/proj/docs/a.png");
    expect(resolveRelativeAsset(base, "./img/a.png")).toBe(
      "/work/proj/docs/img/a.png",
    );
  });

  it("walks up with .. but never above the root", () => {
    expect(resolveRelativeAsset(base, "../assets/a.png")).toBe(
      "/work/proj/assets/a.png",
    );
    expect(resolveRelativeAsset(base, "../../../../../a.png")).toBe("/a.png");
  });

  it("decodes percent escapes and drops query and fragment", () => {
    expect(resolveRelativeAsset(base, "my%20pic.png?raw=1#x")).toBe(
      "/work/proj/docs/my pic.png",
    );
    expect(resolveRelativeAsset(base, "bad%E0%A4%A.png")).toBe(
      "/work/proj/docs/bad%E0%A4%A.png",
    );
  });

  it("leaves non-relative references alone", () => {
    for (const src of [
      "",
      "#top",
      "/abs/a.png",
      "//cdn.example.com/a.png",
      "https://example.com/a.png",
      "data:image/png;base64,AAAA",
      "asset://localhost/x",
      "C:\\img\\a.png",
    ]) {
      expect(resolveRelativeAsset(base, src)).toBeNull();
    }
  });

  it("keeps Windows separators and drive roots", () => {
    expect(
      resolveRelativeAsset("C:\\proj\\docs\\guide.md", "../img/a.png"),
    ).toBe("C:\\proj\\img\\a.png");
  });
});

const policy = (boundary: string) => ({
  boundary,
  isReadable: (abs: string) => checkReadable(abs).ok,
});

describe("isInsideRoot / previewBoundary", () => {
  it("is lexical and separator-agnostic, never matching siblings", () => {
    expect(isInsideRoot("/w/p", "/w/p/a/b.png")).toBe(true);
    expect(isInsideRoot("/w/p/", "/w/p/a.png")).toBe(true);
    expect(isInsideRoot("/w/p", "/w/p")).toBe(false);
    expect(isInsideRoot("/w/p", "/w/prod/a.png")).toBe(false);
    expect(isInsideRoot("C:\\W\\P", "c:/w/p/a.png")).toBe(true);
  });

  it("uses the workspace root when it holds the document, else the document folder", () => {
    expect(previewBoundary("/w/p/docs/a.md", "/w/p")).toBe("/w/p");
    expect(previewBoundary("/other/docs/a.md", "/w/p")).toBe("/other/docs");
    expect(previewBoundary("/w/p/docs/a.md", null)).toBe("/w/p/docs");
  });

  it("normalizes the document before deciding it is inside the root", () => {
    // An alias that walks out of the root is an outside document: its own
    // directory is the boundary, not the root it merely spells.
    expect(previewBoundary("/w/p/../outside/a.md", "/w/p")).toBe("/w/outside");
    expect(previewBoundary("/w/p/./docs/a.md", "/w/p")).toBe("/w/p");
    expect(previewBoundary("C:\\w\\p\\..\\outside\\a.md", "C:\\w\\p")).toBe(
      "C:/w/outside",
    );
  });
});

describe("isAllowedLocalImage", () => {
  const p = policy("/w/p");

  it("allows image types inside the boundary", () => {
    for (const ext of [
      "png",
      "JPG",
      "jpeg",
      "gif",
      "webp",
      "avif",
      "svg",
      "bmp",
      "ico",
    ]) {
      expect(isAllowedLocalImage(`/w/p/img/a.${ext}`, p)).toBe(true);
    }
  });

  it("refuses paths outside the boundary", () => {
    expect(isAllowedLocalImage("/w/other/a.png", p)).toBe(false);
    expect(isAllowedLocalImage("/home/me/a.png", p)).toBe(false);
    expect(isAllowedLocalImage("/w/prod/a.png", p)).toBe(false);
  });

  it("refuses anything that is not an image type", () => {
    for (const name of [
      "notes.md",
      "id_rsa",
      "a.png.txt",
      "a",
      ".png",
      "data.json",
      "x.html",
    ]) {
      expect(isAllowedLocalImage(`/w/p/${name}`, p)).toBe(false);
    }
  });

  it("refuses secret paths even when they look like images", () => {
    expect(isAllowedLocalImage("/w/p/.ssh/shot.png", p)).toBe(false);
    expect(isAllowedLocalImage("/w/p/.git/logo.png", p)).toBe(false);
    expect(isAllowedLocalImage("/w/p/.env.png", p)).toBe(false);
    expect(isAllowedLocalImage("/w/p/key.pem.png", p)).toBe(false);
  });
});

describe("classifyImageReference", () => {
  const p = policy("/w/p");

  it("classifies ordinary relative images inside the boundary", () => {
    expect(classifyImageReference("/w/p/docs/a.md", "./a.png", p)).toEqual({
      kind: "local",
      absolutePath: "/w/p/docs/a.png",
    });
    expect(classifyImageReference("/w/p/docs/a.md", "../img/a.svg", p)).toEqual(
      { kind: "local", absolutePath: "/w/p/img/a.svg" },
    );
  });

  it("distinguishes an outside image from a protected one", () => {
    expect(
      classifyImageReference("/w/p/docs/a.md", "../../../home/me/a.png", p),
    ).toEqual({ kind: "outside", absolutePath: "/home/me/a.png" });
    expect(
      classifyImageReference("/w/p/docs/a.md", "../.ssh/logo.png", p),
    ).toEqual({ kind: "protected", absolutePath: "/w/p/.ssh/logo.png" });
    expect(classifyImageReference("/w/p/docs/a.md", "../.env.png", p)).toEqual({
      kind: "protected",
      absolutePath: "/w/p/.env.png",
    });
  });

  it("classifies remote, inline, injected and non-image references", () => {
    expect(
      classifyImageReference("/w/p/a.md", "https://cdn.example.com/a.png", p),
    ).toEqual({ kind: "remote", url: "https://cdn.example.com/a.png" });
    expect(
      classifyImageReference("/w/p/a.md", "//cdn.example.com/a.png", p),
    ).toEqual({ kind: "remote", url: "//cdn.example.com/a.png" });
    expect(
      classifyImageReference("/w/p/a.md", "data:image/png;base64,AAAA", p),
    ).toEqual({ kind: "inline" });
    expect(
      classifyImageReference("/w/p/a.md", "asset://localhost/x.png", p),
    ).toEqual({ kind: "injected" });
    expect(classifyImageReference("/w/p/a.md", "../notes.md", p)).toEqual({
      kind: "unsupported",
      reference: "../notes.md",
    });
    expect(classifyImageReference("/w/p/a.md", "/etc/logo.png", p)).toEqual({
      kind: "unsupported",
      reference: "/etc/logo.png",
    });
    expect(classifyImageReference("/w/p/a.md", "#top", p)).toEqual({
      kind: "none",
    });
  });
});

describe("rehypeLocalImages", () => {
  type Properties = {
    src?: string;
    alt?: string;
    [attribute: string]: unknown;
  };
  const img = (src: string, alt = "") => ({
    type: "element",
    tagName: "img",
    properties: { src, alt } as Properties,
    children: [],
  });
  const run = (
    src: string,
    doc = "/w/p/docs/readme.md",
    root = "/w/p",
    extra: { granted?: ReadonlySet<string>; allowRemote?: boolean } = {},
  ) => {
    const node = img(src);
    const t = {
      type: "root",
      children: [{ type: "element", tagName: "p", children: [node] }],
    };
    rehypeLocalImages(doc, (p) => `asset://${p}`, {
      ...policy(root),
      ...extra,
    })()(t);
    return node.properties.src;
  };
  const runNode = (
    src: string,
    doc = "/w/p/docs/readme.md",
    root = "/w/p",
    extra: { granted?: ReadonlySet<string>; allowRemote?: boolean } = {},
  ) => {
    const node = img(src);
    const t = {
      type: "root",
      children: [{ type: "element", tagName: "p", children: [node] }],
    };
    rehypeLocalImages(doc, (p) => `asset://${p}`, {
      ...policy(root),
      ...extra,
    })()(t);
    return node;
  };

  it("rewrites allowed relative images at any depth", () => {
    expect(run("./a.png")).toBe("asset:///w/p/docs/a.png");
    expect(run("../img/a.svg")).toBe("asset:///w/p/img/a.svg");
  });

  it("marks every managed image with its source for the bounded surface", () => {
    const local = runNode("./a.png");
    expect(local.properties?.["data-terax-image"]).toBe("file");
    expect(local.properties?.["data-terax-image-path"]).toBe("/w/p/docs/a.png");
    expect(local.properties?.["data-terax-image-key"]).toBeTruthy();
    // An automatic local image is probed inside the document boundary.
    expect(local.properties?.["data-terax-image-guard"]).toBe("/w/p");

    // An explicitly granted outside file is probed under that consent.
    const granted = runNode("../../../home/me/pic.png", undefined, undefined, {
      granted: new Set(["/home/me/pic.png"]),
    });
    expect(granted.properties?.["data-terax-image"]).toBe("file");
    expect(granted.properties?.["data-terax-image-guard"]).toBeUndefined();

    const remote = runNode("https://example.com/b.png", undefined, undefined, {
      allowRemote: true,
    });
    expect(remote.properties?.["data-terax-image"]).toBe("remote");
    expect(remote.properties?.["data-terax-image-path"]).toBeUndefined();

    const inline = runNode("data:image/png;base64,AAAA");
    expect(inline.properties?.["data-terax-image"]).toBe("data");
  });

  it("keys an image by its source offset so blocks and re-renders agree", () => {
    const node = {
      ...img("./a.png"),
      position: { start: { offset: 42 } },
    };
    const tree = {
      type: "root",
      children: [{ type: "element", tagName: "p", children: [node] }],
    };
    rehypeLocalImages("/w/p/docs/readme.md", (p) => `asset://${p}`, {
      ...policy("/w/p"),
    })()(tree);
    expect(node.properties?.["data-terax-image-key"]).toBe("o42");
  });

  it("gives repeated references distinct keys so each claim is its own slot", () => {
    const first = img("./same.png");
    const second = img("./same.png");
    const tree = {
      type: "root",
      children: [{ type: "element", tagName: "p", children: [first, second] }],
    };
    rehypeLocalImages("/w/p/docs/readme.md", (p) => `asset://${p}`, {
      ...policy("/w/p"),
    })()(tree);
    expect(first.properties?.["data-terax-image-key"]).toBeTruthy();
    expect(second.properties?.["data-terax-image-key"]).toBeTruthy();
    expect(first.properties?.["data-terax-image-key"]).not.toBe(
      second.properties?.["data-terax-image-key"],
    );
  });

  it("never fetches remote images without deliberate consent", () => {
    const blocked = runNode("https://example.com/b.png");
    expect(blocked.tagName).toBe("span");
    expect(blocked.properties?.src).toBeUndefined();
    expect(JSON.stringify(blocked)).toContain("remote image blocked");
    expect(
      run("https://example.com/b.png", undefined, undefined, {
        allowRemote: true,
      }),
    ).toBe("https://example.com/b.png");
  });

  it("blocks traversal out of the project root until it is granted", () => {
    const outside = runNode("../../../home/me/pic.png");
    expect(outside.tagName).toBe("span");
    expect(outside.properties?.src).toBeUndefined();
    expect(JSON.stringify(outside)).toContain("outside the project folder");

    expect(
      run("../../../home/me/pic.png", undefined, undefined, {
        granted: new Set(["/home/me/pic.png"]),
      }),
    ).toBe("asset:///home/me/pic.png");
  });

  it("supports the same explicit grant for an outside document's own folder", () => {
    const doc = "/elsewhere/docs/readme.md";
    const root = "/elsewhere/docs";
    expect(run("./pic.png", doc, root)).toBe("asset:///elsewhere/docs/pic.png");
    expect(
      run("../shared/pic.png", doc, root, {
        granted: new Set(["/elsewhere/shared/pic.png"]),
      }),
    ).toBe("asset:///elsewhere/shared/pic.png");
    expect(runNode("../shared/pic.png", doc, root).tagName).toBe("span");
  });

  it("does not rewrite non-image files or secret paths", () => {
    expect(run("../notes.md")).toBe("../notes.md");
    expect(run("../.ssh/id_rsa")).toBe("../.ssh/id_rsa");
    const secret = runNode("../.env.png");
    expect(secret.tagName).toBe("span");
    expect(JSON.stringify(secret)).toContain("protected image");
  });

  it("never grants a protected path, even when the document asks to", () => {
    const node = runNode("../.env.png", undefined, undefined, {
      granted: new Set(["/w/p/.env.png"]),
    });
    expect(node.tagName).toBe("span");
    expect(node.properties?.src).toBeUndefined();
  });

  it("never rewrites absolute references", () => {
    expect(run("/etc/passwd")).toBe("/etc/passwd");
    expect(run("C:\\Users\\me\\a.png")).toBe("C:\\Users\\me\\a.png");
  });

  it("keeps inline data images, which fetch nothing", () => {
    expect(run("data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("drops asset-protocol URLs written in the document", () => {
    expect(run("asset://localhost/%2Fetc%2Fpasswd")).toBeUndefined();
    expect(run("https://asset.localhost/C%3A%2Fsecret.png")).toBeUndefined();
    expect(run("//asset.localhost/x.png")).toBeUndefined();
  });

  it("confines a document outside the workspace to its own folder", () => {
    expect(run("./a.png", "/elsewhere/d/r.md", "/elsewhere/d")).toBe(
      "asset:///elsewhere/d/a.png",
    );
    const outside = runNode("../a.png", "/elsewhere/d/r.md", "/elsewhere/d");
    expect(outside.tagName).toBe("span");
    expect(outside.properties?.src).toBeUndefined();
  });
});
