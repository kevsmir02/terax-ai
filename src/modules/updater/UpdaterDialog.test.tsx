import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dialog } from "@/components/ui/dialog";
import type { HandoffApproval } from "./handoffReadiness";
import type { AvailableRelease } from "./releaseManifest";
import { UpdaterDialogBody } from "./UpdaterDialog";
import type { UpdaterDialogState } from "./UpdaterDialog";

const release: AvailableRelease = {
  version: "0.10.0",
  channel: "stable",
  notes: "Fork stable fixture.",
  publishedAt: "2026-10-01T12:00:00Z",
  trust: "fixture-unverified",
  artifact: {
    url: "http://127.0.0.1:8787/Terax_0.10.0_amd64.deb",
    signature: "untrusted comment: fixture\nAA==\ntrusted comment: fixture",
    size: 1234,
  },
};

const approval: HandoffApproval = {
  at: 100,
  snapshot: { buffers: [], processes: [], agents: [] },
};

function render(state: UpdaterDialogState) {
  return renderToStaticMarkup(
    // The body uses the dialog's own header/footer primitives, so it renders inside a
    // dialog root; the portal content is the shell's job, not the copy's.
    createElement(
      Dialog,
      { open: true },
      createElement(UpdaterDialogBody, {
        state,
        distro: "debian",
        onSelectDistro: () => {},
        copiedCommand: null,
        onCopy: () => {},
        onDismiss: () => {},
        onRequestHandoff: () => {},
        onReviewWork: () => {},
      }),
    ),
  )
    .split("<!-- -->")
    .join("");
}

/** No state may read as a completed install: only the package tool can do that. */
const INSTALL_CLAIM =
  /(has been|successfully|now) installed|installation (completed|finished)|restart to finish/i;

describe("updater dialog body", () => {
  it("names the work that blocks the handoff and offers to review it", () => {
    const html = render({
      kind: "handoff-blocked",
      release,
      approval,
      assessedAt: 101,
      hazards: [
        { kind: "buffer", tabId: 7, spaceId: "space-a", title: "src/app.ts" },
        {
          kind: "agent",
          tabId: 9,
          leafId: 42,
          spaceId: "space-a",
          agent: "Claude Code",
        },
      ],
      startedAfterApproval: true,
      summary:
        "Terax did not hand off: 1 file with unsaved changes (src/app.ts) and 1 agent still working (Claude Code). Terax does not save, close, stop or interrupt any of it; what to finish or close stays your decision.",
    });

    expect(html).toContain("src/app.ts");
    expect(html).toContain("Claude Code");
    expect(html).toMatch(/not handed off/i);
    expect(html).toContain("Review");
    expect(html).toContain("does not save, close, stop or interrupt");
    expect(html).toContain("Approve the handoff again");
    expect(html).not.toMatch(INSTALL_CLAIM);
  });

  it("reports a completed handoff as handed off, never as installed", () => {
    const html = render({
      kind: "handed-off",
      release,
      approvedAt: 100,
      handedOffAt: 101,
    });

    expect(html).toContain("Handed off");
    expect(html).toContain("0.10.0");
    expect(html).toContain("did not download, install or verify anything");
    expect(html).toContain("cannot confirm the result");
    expect(html).toContain("apt install");
    expect(html).not.toMatch(INSTALL_CLAIM);
    // No relaunch control exists, and no in-app install action is offered.
    expect(html).not.toMatch(/>\s*(Relaunch|Restart|Install now)\s*</);
  });

  it("gives an explicit recovery path for cancellation, locks and failures", () => {
    const html = render({
      kind: "handed-off",
      release,
      approvedAt: 100,
      handedOffAt: 101,
    });

    expect(html).toContain("cancelled");
    expect(html).toContain("locked");
    expect(html).toContain("close Terax");
    expect(html).toContain("run the command again");
    expect(html).toContain("nothing is rolled back");
    expect(html).toContain("cannot tell you whether the transaction finished");
  });

  it("says the readiness check is running without claiming anything was resolved", () => {
    const html = render({
      kind: "handoff-checking",
      release,
      approval,
    });

    expect(html).toContain("Checking");
    expect(html).toContain("does not save, close, stop or interrupt");
    expect(html).not.toMatch(INSTALL_CLAIM);
  });

  it("keeps the pre-handoff state free of an install claim", () => {
    const html = render({ kind: "update-available", checkedAt: 1, release });
    expect(html).toContain("Update with package tool");
    expect(html).not.toMatch(INSTALL_CLAIM);
  });
});
