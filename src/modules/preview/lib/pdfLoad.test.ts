import { describe, expect, it } from "vitest";
import { classifyPdfError } from "./pdfLoad";

function reasonOf(error: unknown): string {
  const outcome = classifyPdfError(error);
  return "reason" in outcome ? outcome.reason : "";
}

// These names are the ones pdfjs-dist documents and throws: the test states the
// contract ("corrupt", "password", "unsupported" and "unreadable" stay
// distinct) against the library's own vocabulary, not against an invented one.
describe("classifyPdfError", () => {
  it("recognises a parse error as a corrupt document", () => {
    const error = {
      name: "InvalidPDFException",
      message: "Invalid PDF structure.",
    };
    const outcome = classifyPdfError(error);
    expect(outcome.kind).toBe("corrupt");
    expect(reasonOf(error)).toContain("structure");
  });

  it("recognises a truncated object graph behind a plain error", () => {
    expect(classifyPdfError(new Error("bad XRef entry at 42")).kind).toBe(
      "corrupt",
    );
  });

  it("keeps an encrypted document distinct from a corrupt one", () => {
    const error = { name: "PasswordException", message: "No password given" };
    expect(classifyPdfError(error).kind).toBe("password");
    expect(reasonOf(error)).toContain("encrypted");
  });

  it("recognises an unsupported feature", () => {
    expect(
      classifyPdfError(new Error("XFA is not supported by this build")).kind,
    ).toBe("unsupported");
  });

  it("treats a worker or IPC failure as unreadable, not as a corrupt file", () => {
    expect(classifyPdfError(new Error("worker failed to load")).kind).toBe(
      "unreadable",
    );
    expect(classifyPdfError("Load failed").kind).toBe("unreadable");
  });

  it("always produces a reason a person can read", () => {
    for (const error of [undefined, null, 42, {}, new Error("")]) {
      const outcome = classifyPdfError(error);
      expect(outcome.kind).toBe("unreadable");
      expect(reasonOf(error).length).toBeGreaterThan(10);
    }
  });
});
