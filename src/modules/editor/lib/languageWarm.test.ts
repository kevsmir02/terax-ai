import { TEXT_SYNTAX_LIMIT_BYTES } from "@/modules/preview/lib/limits";
import { describe, expect, it, vi } from "vitest";
import type { LanguageResult } from "./languageResolver";
import { planLanguageWarm, warmLanguage } from "./languageWarm";
import type { DocumentState } from "./useDocument";

const loaded: LanguageResult = {
  ext: [],
  name: "TypeScript",
  id: "typescript",
};

function resolver() {
  return vi.fn(async (_path: string) => loaded);
}

function ready(size: number): DocumentState {
  return { status: "ready", content: "", size };
}

describe("planLanguageWarm", () => {
  it("warms a ready document that is within the syntax ceiling", () => {
    expect(
      planLanguageWarm({ path: "/repo/src/main.tsx", doc: ready(1024) }),
    ).toEqual({ warm: true, path: "/repo/src/main.tsx" });
  });

  it("keeps the syntax ceiling inclusive, like the native read does", () => {
    expect(
      planLanguageWarm({
        path: "/repo/src/main.tsx",
        doc: ready(TEXT_SYNTAX_LIMIT_BYTES),
      }),
    ).toEqual({ warm: true, path: "/repo/src/main.tsx" });
  });

  it("does not warm one byte past the syntax ceiling", () => {
    expect(
      planLanguageWarm({
        path: "/repo/src/main.tsx",
        doc: ready(TEXT_SYNTAX_LIMIT_BYTES + 1),
      }),
    ).toEqual({ warm: false, reason: "over-syntax-limit" });
  });

  it("does not warm while the file is still being read", () => {
    expect(
      planLanguageWarm({
        path: "/repo/src/main.tsx",
        doc: { status: "loading" },
      }),
    ).toEqual({ warm: false, reason: "still-reading" });
  });

  it("does not warm a document the native reader refused", () => {
    expect(
      planLanguageWarm({
        path: "/repo/huge.log",
        doc: {
          status: "toolarge",
          size: 60 * 1024 * 1024,
          limit: 10 * 1024 * 1024,
        },
      }),
    ).toEqual({ warm: false, reason: "refused" });
  });

  it("does not warm a document with no text to parse", () => {
    for (const doc of [
      { status: "binary", size: 2048 },
      { status: "error", message: "permission denied" },
    ] as DocumentState[]) {
      expect(planLanguageWarm({ path: "/repo/blob.bin", doc })).toEqual({
        warm: false,
        reason: "refused",
      });
    }
  });

  it("resolves an override language instead of the file's own", () => {
    expect(
      planLanguageWarm({
        path: "/repo/notes",
        overrideLanguage: "python",
        doc: ready(64),
      }),
    ).toEqual({ warm: true, path: "dummy.python" });
  });

  it("applies the ceiling to an override language too", () => {
    expect(
      planLanguageWarm({
        path: "/repo/notes",
        overrideLanguage: "python",
        doc: ready(TEXT_SYNTAX_LIMIT_BYTES + 1),
      }),
    ).toEqual({ warm: false, reason: "over-syntax-limit" });
  });
});

describe("warmLanguage", () => {
  it("imports the chunk for a document within the ceiling", async () => {
    const resolve = resolver();
    const pending = warmLanguage(resolve, {
      path: "/repo/src/main.tsx",
      doc: ready(4096),
    });
    expect(resolve).toHaveBeenCalledWith("/repo/src/main.tsx");
    await expect(pending).resolves.toBe(loaded);
  });

  it("never imports a chunk for an oversized document", async () => {
    const resolve = resolver();
    const pending = warmLanguage(resolve, {
      path: "/repo/generated/bundle.ts",
      doc: ready(TEXT_SYNTAX_LIMIT_BYTES + 1),
    });
    expect(pending).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("never imports a chunk for a document the read ceiling refused", async () => {
    const resolve = resolver();
    const pending = warmLanguage(resolve, {
      path: "/repo/generated/bundle.ts",
      doc: {
        status: "toolarge",
        size: 60 * 1024 * 1024,
        limit: 10 * 1024 * 1024,
      },
    });
    expect(pending).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("swallows a failed import so warming never surfaces an error", async () => {
    const resolve = vi.fn(async (): Promise<LanguageResult | null> => {
      throw new Error("chunk failed to load");
    });
    await expect(
      warmLanguage(resolve, { path: "/repo/src/main.tsx", doc: ready(1024) }),
    ).resolves.toBeNull();
  });
});
