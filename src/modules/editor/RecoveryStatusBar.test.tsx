import type { RecoveryStatus } from "./lib/recovery/manager";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecoveryStatusBar } from "./RecoveryStatusBar";

function status(overrides: Partial<RecoveryStatus>): RecoveryStatus {
  return {
    kind: "durable",
    bufferId: "buf-a",
    bufferRevision: 3,
    durableRevision: 3,
    bytes: 2048,
    totalBytes: 4096,
    scheduled: false,
    ...overrides,
  };
}

function render(value: RecoveryStatus): string {
  return renderToString(
    createElement(RecoveryStatusBar, { status: value, onRetry: () => {} }),
  );
}

describe("recovery status is visible", () => {
  it("stays out of the way when the feature is off or there is nothing to say", () => {
    expect(render(status({ kind: "off" }))).toBe("");
    expect(render(status({ kind: "idle" }))).toBe("");
    // An excluded path says nothing in the editor: it has no draft, and the
    // disclosure in settings explains the exclusion.
    expect(render(status({ kind: "excluded" }))).toBe("");
  });

  it("distinguishes a pending write from an acknowledged one", () => {
    const pending = render(
      status({ kind: "pending", durableRevision: 2, scheduled: true }),
    );
    expect(pending).toContain("Saving draft");
    expect(pending).not.toContain("Draft saved");
    // A scheduled write is honest progress; no Retry noise.
    expect(pending).not.toContain("Retry");

    const durable = render(status({ kind: "durable" }));
    expect(durable).toContain("Draft saved");
    expect(durable).toContain("2.0 KB");
  });

  it("does not claim progress for pending text that is not scheduled", () => {
    // If recovery ever leaves pending text with no persistence scheduled, the
    // status must say so and offer Retry instead of "Saving draft…" forever.
    const stalled = render(
      status({ kind: "pending", durableRevision: 2, scheduled: false }),
    );
    expect(stalled).not.toContain("Saving draft");
    expect(stalled).toContain("not scheduled");
    expect(stalled).toContain("Retry");
  });

  it("shows a failed write instead of pretending it was saved", () => {
    const failed = render(
      status({ kind: "failed", message: "disk full", durableRevision: 2 }),
    );
    expect(failed).toContain("Draft not saved");
    expect(failed).toContain("disk full");
    expect(failed).not.toContain("Draft saved");
  });

  it("shows the full-storage and per-file pause reasons", () => {
    const full = render(
      status({
        kind: "paused",
        reason: "total-limit",
        message: "Recovery storage is full. Nothing was evicted.",
      }),
    );
    expect(full).toContain("Recovery storage is full");
    expect(full).toContain("Retry");

    const tooBig = render(
      status({ kind: "paused", reason: "file-limit", message: "Too large." }),
    );
    expect(tooBig).toContain("Too large");
  });

  it("shows unavailable storage", () => {
    const unavailable = render(
      status({ kind: "unavailable", message: "read-only" }),
    );
    expect(unavailable).toContain("Recovery unavailable");
    expect(unavailable).toContain("read-only");
  });
});
