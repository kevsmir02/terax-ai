import { describe, expect, it } from "vitest";
import {
  previewFrameLifecycle,
  previewReloadNotice,
  reloadNoticeAfter,
  type PreviewFrameInputs,
  type PreviewFrameUnloadReason,
} from "./frameLifecycle";

const active: PreviewFrameInputs = {
  tabActive: true,
  spaceActive: true,
  windowVisible: true,
  windowFocused: true,
};

describe("preview frame lifecycle", () => {
  it("keeps the frame while its tab is the active tab of the active Space and the window is visible", () => {
    expect(previewFrameLifecycle(active)).toEqual({
      mounted: true,
      reason: null,
    });
  });

  it("unloads the frame as soon as its tab stops being the active tab", () => {
    expect(previewFrameLifecycle({ ...active, tabActive: false })).toEqual({
      mounted: false,
      reason: "tab-inactive",
    });
  });

  it("unloads the frame when its Space stops being the active Space", () => {
    expect(previewFrameLifecycle({ ...active, spaceActive: false })).toEqual({
      mounted: false,
      reason: "space-inactive",
    });
  });

  it("unloads the frame when a supported visibility signal says the window is hidden", () => {
    expect(previewFrameLifecycle({ ...active, windowVisible: false })).toEqual({
      mounted: false,
      reason: "window-hidden",
    });
  });

  it("does not unload a still-visible window that only lost focus", () => {
    // Focus loss while the window is visible means the user is working in another window;
    // the preview is still on screen and must keep running (it is not occlusion).
    expect(
      previewFrameLifecycle({
        ...active,
        windowFocused: false,
        windowVisible: true,
      }),
    ).toEqual({ mounted: true, reason: null });
  });

  it("names the closest cause when several hidden states apply", () => {
    // An inactive Space explains why its tabs are hidden, even though they are also not the
    // active tab; a hidden window with an active tab and Space reports the window.
    expect(
      previewFrameLifecycle({
        ...active,
        tabActive: false,
        spaceActive: false,
        windowVisible: false,
      }),
    ).toEqual({ mounted: false, reason: "space-inactive" });
    expect(
      previewFrameLifecycle({
        ...active,
        tabActive: false,
        windowVisible: false,
      }),
    ).toEqual({ mounted: false, reason: "tab-inactive" });
  });
});

/**
 * The ticket's decision table, written out signal by signal instead of derived from the
 * implementation: which reported state unloads a frame and which does not.
 */
describe("the unload decision table", () => {
  const table: Array<
    [
      label: string,
      inputs: PreviewFrameInputs,
      expected: "mounted" | PreviewFrameUnloadReason,
    ]
  > = [
    ["active tab, active Space, window visible", active, "mounted"],
    ["active tab, active Space, window focused", active, "mounted"],
    [
      "active tab, active Space, window visible but unfocused (blur)",
      { ...active, windowFocused: false },
      "mounted",
    ],
    [
      "active tab, active Space, window reported hidden",
      { ...active, windowVisible: false },
      "window-hidden",
    ],
    [
      "active tab, active Space, window hidden and unfocused",
      { ...active, windowVisible: false, windowFocused: false },
      "window-hidden",
    ],
    [
      "inactive tab, active Space",
      { ...active, tabActive: false },
      "tab-inactive",
    ],
    [
      "inactive tab of an inactive Space",
      { ...active, tabActive: false, spaceActive: false },
      "space-inactive",
    ],
    [
      "active tab of an inactive Space",
      { ...active, spaceActive: false },
      "space-inactive",
    ],
    [
      "inactive tab, window reported hidden",
      { ...active, tabActive: false, windowVisible: false },
      "tab-inactive",
    ],
  ];

  it.each(table)("%s → %s", (_label, inputs, expected) => {
    const lifecycle = previewFrameLifecycle(inputs);
    if (expected === "mounted") {
      expect(lifecycle).toEqual({ mounted: true, reason: null });
    } else {
      expect(lifecycle).toEqual({ mounted: false, reason: expected });
    }
  });

  it("never changes its answer because of focus alone", () => {
    // Focus is recorded for callers but never an input to the decision: for every tab/Space/
    // window-visibility combination, a visible window with and without focus behaves the same.
    for (const tabActive of [true, false])
      for (const spaceActive of [true, false])
        for (const windowVisible of [true, false]) {
          const base = { tabActive, spaceActive, windowVisible };
          expect(
            previewFrameLifecycle({ ...base, windowFocused: false }),
          ).toEqual(previewFrameLifecycle({ ...base, windowFocused: true }));
        }
  });
});

describe("preview reload disclosure", () => {
  it("says the page reloads and transient state is lost, per cause", () => {
    for (const [reason, cause] of [
      ["tab-inactive", "another tab"],
      ["space-inactive", "another Space"],
      ["window-hidden", "hidden or minimized"],
    ] as const) {
      const notice = previewReloadNotice(reason);
      expect(notice.title).toContain("reloaded");
      expect(notice.detail).toContain(cause);
      expect(notice.detail.toLowerCase()).toContain("state");
      expect(notice.detail.toLowerCase()).toContain("lost");
    }
  });

  it("keeps the independent dev server alive in the copy", () => {
    expect(previewReloadNotice("tab-inactive").detail.toLowerCase()).toContain(
      "dev server keeps running",
    );
  });

  it("does not promise complete Linux hidden-window detection", () => {
    const notice = previewReloadNotice("window-hidden");
    expect(notice.limitation.toLowerCase()).toContain("linux");
    expect(notice.limitation.toLowerCase()).toContain("may keep running");
    expect(notice.limitation).not.toMatch(/\b(every|all|always|guarantee)\b/i);
  });
});

describe("preview reload notice lifecycle", () => {
  const loaded = { mounted: true, reason: null } as const;
  const hiddenByTab = { mounted: false, reason: "tab-inactive" } as const;
  const hiddenBySpace = { mounted: false, reason: "space-inactive" } as const;

  it("records the cause when the frame is unloaded", () => {
    expect(reloadNoticeAfter(loaded, hiddenByTab, null)).toBe("tab-inactive");
  });

  it("keeps the cause across the re-mount so the reload is explained where it happens", () => {
    expect(reloadNoticeAfter(hiddenByTab, loaded, "tab-inactive")).toBe(
      "tab-inactive",
    );
  });

  it("nothing to say while the frame stays mounted", () => {
    expect(reloadNoticeAfter(loaded, loaded, null)).toBe(null);
  });

  it("a dismissal stays dismissed across re-renders and later re-mounts", () => {
    expect(reloadNoticeAfter(hiddenByTab, hiddenByTab, null)).toBe(null);
    expect(reloadNoticeAfter(hiddenByTab, loaded, null)).toBe(null);
  });

  it("keeps the cause that took the frame off screen, not a later intermediate state", () => {
    // Returning to a Space re-renders before the app has restored the Space's active tab: the
    // frame reports "tab-inactive" for that render even though the tab never changed. The
    // recorded cause must stay the one that took the frame away, or the notice would blame a
    // tab switch the user never made.
    expect(reloadNoticeAfter(hiddenByTab, hiddenBySpace, "tab-inactive")).toBe(
      "tab-inactive",
    );
    expect(
      reloadNoticeAfter(hiddenBySpace, hiddenByTab, "space-inactive"),
    ).toBe("space-inactive");
    expect(reloadNoticeAfter(hiddenBySpace, loaded, "space-inactive")).toBe(
      "space-inactive",
    );
  });

  it("a visible blur never changes the recorded cause", () => {
    // A blur is not an unload state at all; it cannot reach this function with a new reason.
    expect(reloadNoticeAfter(loaded, loaded, "space-inactive")).toBe(
      "space-inactive",
    );
  });
});
