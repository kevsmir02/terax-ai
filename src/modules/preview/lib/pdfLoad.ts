import type { PdfLoadOutcome } from "./pdfViewer";

/**
 * Turns whatever the lazy PDF loader threw into the reader's honest outcomes.
 *
 * `pdfjs-dist` reports document-level failures as typed exceptions, but a
 * native read failure, a missing worker or a malformed xref can arrive as a
 * plain error. The mapping is pure and tested against the exception names the
 * library documents, so "corrupt", "encrypted", "unsupported" and "unreadable"
 * stay distinct instead of collapsing into one opaque message.
 */
export function classifyPdfError(error: unknown): PdfLoadOutcome {
  const name = nameOf(error);
  const message = messageOf(error);
  const lower = message.toLowerCase();

  if (name === "PasswordException" || lower.includes("password")) {
    return {
      kind: "password",
      reason: "This PDF is encrypted and needs a password to open it.",
    };
  }
  if (
    name === "InvalidPDFException" ||
    lower.includes("invalid pdf structure") ||
    lower.includes("xref") ||
    lower.includes("bad pdf")
  ) {
    return {
      kind: "corrupt",
      reason:
        "This PDF could not be parsed: its structure is invalid or truncated.",
    };
  }
  if (
    lower.includes("not supported") ||
    lower.includes("unsupported") ||
    lower.includes("cannot be displayed")
  ) {
    return {
      kind: "unsupported",
      reason: "This PDF uses a feature this reader cannot display.",
    };
  }
  if (
    name === "MissingPDFException" ||
    name === "UnexpectedResponseException"
  ) {
    return {
      kind: "unreadable",
      reason: "The document could not be read from disk.",
    };
  }
  return {
    kind: "unreadable",
    reason: message
      ? `The document could not be opened: ${message}`
      : "The document could not be opened.",
  };
}

function nameOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    return String((error as { name?: unknown }).name ?? "");
  }
  return "";
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return "";
}
