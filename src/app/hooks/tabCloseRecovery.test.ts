/**
 * Source-level regression test for the "closing a tab forgets recovery" bug
 * class (issue #16).
 *
 * The recovery manager owns a coalescing timer per buffer, so a tab that
 * closes without resolving its recovery state keeps writing after unmount.
 * That is correct for a plain close (the draft is offered back) and *wrong*
 * for an explicit discard ("Discard & Close"): the discarded text was then
 * persisted and offered back as a recovered draft. The behaviour itself is
 * pinned at the manager seam (`recovery/manager.test.ts`); this test pins the
 * wiring that the manager cannot enforce: every tab-removal entry point in the
 * app must go through one choke point and state what closing means for the
 * draft. Rendering `App`/`useTabCloseGuards` for real needs jsdom plus the
 * whole Tauri surface, so the wiring is checked in the source.
 */

import { readRepoFile } from "@/test/rustSource";
import { describe, expect, it } from "vitest";

const app = readRepoFile("src/app/App.tsx");
const guards = readRepoFile("src/app/hooks/useTabCloseGuards.ts");

/** A slice of the source between two markers; a missing marker is a failure. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`missing marker: ${from}`);
  const end = source.indexOf(to, start + from.length);
  if (end < 0) throw new Error(`missing marker after ${from}: ${to}`);
  return source.slice(start, end);
}

describe("tab close resolves recovery state", () => {
  it("resolves the buffer's recovery before dropping its handle", () => {
    const choke = between(
      app,
      "const releaseTabRecovery",
      "const disposeTab = useCallback",
    );
    expect(choke).toContain("releaseRecovery(intent)");
    // Order matters: disposing after the delete would still work for the
    // timer, but discarding after a closed handle would not; keep both ahead.
    expect(choke.indexOf("releaseRecovery(intent)")).toBeLessThan(
      choke.indexOf("editorRefs.current.delete(id)"),
    );
  });

  it("makes every single-tab path go through that choke point", () => {
    const single = between(
      app,
      "const disposeTab = useCallback",
      "const disposeTabs = useCallback",
    );
    expect(single).toContain("releaseTabRecovery(id, intent)");
    // No second implementation of handle cleanup that could skip recovery.
    expect(single).not.toContain("editorRefs.current.delete");
  });

  it("makes every bulk path go through that choke point", () => {
    const bulk = between(
      app,
      "const disposeTabs = useCallback",
      "const disposeDeletedTabs = useCallback",
    );
    expect(bulk).toContain("releaseTabRecovery(");
    expect(bulk).not.toContain("editorRefs.current.delete");

    const deleted = between(
      app,
      "const disposeDeletedTabs = useCallback",
      "const handleEditorClose",
    );
    expect(deleted).toContain("disposeTab(id, ");
    expect(deleted).not.toContain("editorRefs.current.delete");
  });

  it("discards when a deleted file's tab closes, and when a Space is deleted", () => {
    const deleted = between(
      app,
      "const disposeDeletedTabs = useCallback",
      "const handleEditorClose",
    );
    // A deleted file keeps the person's unsaved text recoverable, like a close.
    expect(deleted).toContain('disposeTab(id, "keep-draft")');

    const space = between(app, "const prepareDiscard", "const {");
    expect(space).toContain('releaseRecovery("discard")');
  });

  it("states a discard intent at every disposeTab call site", () => {
    const calls = [...guards.matchAll(/disposeTab\(([^)]*)\)/g)].map(
      (match) => match[1] ?? "",
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      // The intent is a required parameter, so a call that omits it does not
      // compile; this also catches a future default that would silently keep
      // a discarded draft.
      expect(args).toMatch(/,\s*"(discard|keep-draft)"$/);
    }
  });

  it("discards on the polite confirmations and keeps drafts on the others", () => {
    const confirmClose = between(
      guards,
      "const confirmClose = useCallback",
      "const cancelClose",
    );
    expect(confirmClose).toContain('disposeTab(pendingCloseTab, "discard")');

    const saveAndClose = between(
      guards,
      "const saveAndClose = useCallback",
      "const confirmTerminalClose",
    );
    // The save itself resolved the draft; the close must not claim a discard.
    expect(saveAndClose).toContain('disposeTab(tabId, "keep-draft")');

    const closeMany = between(
      guards,
      "const confirmCloseMany = useCallback",
      "const saveAndCloseMany",
    );
    // "Close anyway" discards exactly the buffers it told the person about.
    expect(closeMany).toContain("hazards.dirtyIds");
  });

  it("never closes a planned set without saying what to discard", () => {
    const calls = [...guards.matchAll(/disposeTabs\(([\s\S]*?)\);/g)].map(
      (match) => match[1] ?? "",
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args.split(",").length).toBeGreaterThanOrEqual(3);
    }
  });
});
