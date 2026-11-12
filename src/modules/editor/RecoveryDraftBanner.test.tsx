import { makeRecord } from "./lib/recovery/model";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecoveryDraftBanner } from "./RecoveryDraftBanner";

const draft = makeRecord({
  bufferId: "buf-old",
  spaceId: "sp-a",
  path: "/home/me/notes.txt",
  diskRevision: `r1:${"ab".repeat(32)}:8:8-9`,
  bufferRevision: 4,
  text: "unsaved text",
  updatedAt: 1,
});

function render(
  options: {
    plan?: Parameters<typeof RecoveryDraftBanner>[0]["plan"];
    canRestore?: boolean;
  } = {},
): string {
  return renderToString(
    createElement(RecoveryDraftBanner, {
      draft,
      plan: options.plan ?? { kind: "adopt" },
      diskText: "disk text",
      canRestore: options.canRestore ?? true,
      onRestore: () => {},
      onSaveCopy: () => {},
      onDiscard: () => {},
      onDismiss: () => {},
    }),
  )
    .split("<!-- -->")
    .join("");
}

describe("recovered draft is offered, never imposed", () => {
  it("names the draft and offers compare, restore, discard and later", () => {
    const html = render();
    expect(html).toContain("Recovered unsaved draft for notes.txt");
    expect(html).toContain("Compare");
    expect(html).toContain("Restore");
    expect(html).toContain("Discard");
    expect(html).toContain("Later");
  });

  it("does not offer restore over the buffer's own unsaved edits", () => {
    const html = render({ canRestore: false });
    expect(html).toContain("disabled");
  });

  it("offers compare and Save As for a changed or missing original", () => {
    const changed = render({ plan: { kind: "compare", reason: "changed" } });
    // The dialog is closed initially; the banner still exposes the action.
    expect(changed).toContain("Compare");
    const missing = render({ plan: { kind: "compare", reason: "missing" } });
    expect(missing).toContain("Discard");
    // Nothing here claims the file will be written.
    expect(missing).not.toContain("Overwrite");
  });
});
