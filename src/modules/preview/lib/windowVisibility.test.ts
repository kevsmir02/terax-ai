import { describe, expect, it, vi } from "vitest";
import {
  createWindowVisibleTracker,
  type VisibilityDocument,
} from "./windowVisibility";

function fakeDocument(initial: DocumentVisibilityState) {
  const listeners = new Set<() => void>();
  const doc: VisibilityDocument = {
    get visibilityState() {
      return state;
    },
    addEventListener: (_type: "visibilitychange", listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_type: "visibilitychange", listener: () => void) =>
      listeners.delete(listener),
  };
  let state = initial;
  return {
    doc,
    set(next: DocumentVisibilityState) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function fakePresentation() {
  const listeners = new Set<(state: { visible: boolean }) => void>();
  return {
    subscribe: (listener: (state: { visible: boolean }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(visible: boolean) {
      for (const listener of [...listeners]) listener({ visible });
    },
    listenerCount: () => listeners.size,
  };
}

describe("preview window visibility", () => {
  it("starts from the document's own visibility state", () => {
    expect(
      createWindowVisibleTracker({
        doc: fakeDocument("visible").doc,
      }).visible(),
    ).toBe(true);
    expect(
      createWindowVisibleTracker({ doc: fakeDocument("hidden").doc }).visible(),
    ).toBe(false);
  });

  it("reports a hidden document to subscribers without waiting for anything else", () => {
    const page = fakeDocument("visible");
    const tracker = createWindowVisibleTracker({ doc: page.doc });
    const seen: boolean[] = [];
    tracker.subscribe((visible) => seen.push(visible));
    page.set("hidden");
    page.set("visible");
    expect(seen).toEqual([true, false, true]);
  });

  it("treats a native occlusion report as hidden even while the document still says visible", () => {
    // macOS reports occlusion without a page-visibility change; Linux reports neither today.
    const page = fakeDocument("visible");
    const presentation = fakePresentation();
    const tracker = createWindowVisibleTracker({
      doc: page.doc,
      subscribePresentation: presentation.subscribe,
    });
    const seen: boolean[] = [];
    tracker.subscribe((visible) => seen.push(visible));
    presentation.push(false);
    expect(tracker.visible()).toBe(false);
    presentation.push(true);
    expect(tracker.visible()).toBe(true);
    expect(seen).toEqual([true, false, true]);
  });

  it("subscribes once and releases both sources when disposed", () => {
    const page = fakeDocument("visible");
    const presentation = fakePresentation();
    const tracker = createWindowVisibleTracker({
      doc: page.doc,
      subscribePresentation: presentation.subscribe,
    });
    const stop = tracker.subscribe(vi.fn());
    expect(page.listenerCount()).toBe(1);
    expect(presentation.listenerCount()).toBe(1);
    stop();
    stop();
    expect(page.listenerCount()).toBe(0);
    expect(presentation.listenerCount()).toBe(0);
  });
});
