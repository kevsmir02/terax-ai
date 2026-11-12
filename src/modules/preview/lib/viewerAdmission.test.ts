import { beforeEach, describe, expect, it } from "vitest";
import {
  DECODED_ASSET_BUDGET_BYTES,
  MAX_CONCURRENT_DECODED_VIEWERS,
  MIB,
} from "./limits";
import {
  admitDecodedViewer,
  heldDecodedBytes,
  releaseDecodedViewer,
  useViewerAdmissionStore,
  type ViewerEntry,
} from "./viewerAdmission";

function viewer(
  id: string,
  decodedBytes: number,
  overrides: Partial<ViewerEntry> = {},
): ViewerEntry {
  return {
    id,
    tabId: "tab-1",
    decodedBytes,
    visible: true,
    lastUsed: 1,
    evicted: false,
    ...overrides,
  };
}

describe("admitDecodedViewer", () => {
  it("admits up to the approved concurrent viewer count", () => {
    let viewers: readonly ViewerEntry[] = [];
    for (let index = 0; index < MAX_CONCURRENT_DECODED_VIEWERS; index += 1) {
      const outcome = admitDecodedViewer(viewers, {
        id: `image-${index}`,
        tabId: "tab-1",
        decodedBytes: MIB,
        visible: true,
        lastUsed: index,
      });
      expect(outcome.admission.kind).toBe("admit");
      viewers = outcome.viewers;
    }
    expect(viewers).toHaveLength(MAX_CONCURRENT_DECODED_VIEWERS);
    expect(heldDecodedBytes(viewers)).toBe(
      MAX_CONCURRENT_DECODED_VIEWERS * MIB,
    );
  });

  it("refuses a fifth visible viewer instead of evicting a visible one", () => {
    let viewers: readonly ViewerEntry[] = [];
    for (let index = 0; index < MAX_CONCURRENT_DECODED_VIEWERS; index += 1) {
      viewers = admitDecodedViewer(viewers, {
        id: `visible-${index}`,
        tabId: "tab-1",
        decodedBytes: MIB,
        visible: true,
        lastUsed: index,
      }).viewers;
    }
    const outcome = admitDecodedViewer(viewers, {
      id: "fifth",
      tabId: "tab-2",
      decodedBytes: MIB,
      visible: true,
      lastUsed: 99,
    });
    expect(outcome.admission.kind).toBe("refuse");
    if (outcome.admission.kind !== "refuse") return;
    expect(outcome.admission.blocking).toHaveLength(
      MAX_CONCURRENT_DECODED_VIEWERS,
    );
    expect(outcome.admission.alternatives).toContain("close-another-viewer");
    // The table is untouched: nothing visible was released.
    expect(outcome.viewers).toBe(viewers);
    expect(outcome.viewers.every((entry) => !entry.evicted)).toBe(true);
  });

  it("releases hidden viewers least-recently-used first to make room", () => {
    const viewers = [
      viewer("visible", MIB),
      viewer("hidden-new", MIB, { visible: false, lastUsed: 30 }),
      viewer("hidden-old", MIB, { visible: false, lastUsed: 10 }),
      viewer("hidden-mid", MIB, { visible: false, lastUsed: 20 }),
    ];
    const outcome = admitDecodedViewer(viewers, {
      id: "new",
      tabId: "tab-2",
      decodedBytes: MIB,
      visible: true,
      lastUsed: 40,
    });
    expect(outcome.admission.kind).toBe("admit");
    if (outcome.admission.kind !== "admit") return;
    expect(outcome.admission.evict).toEqual(["hidden-old"]);
    const evicted = outcome.viewers.filter((entry) => entry.evicted);
    expect(evicted.map((entry) => entry.id)).toEqual(["hidden-old"]);
    expect(
      outcome.viewers.find((entry) => entry.id === "visible")?.evicted,
    ).toBe(false);
    // Evicted bytes stop counting toward the budget immediately.
    expect(heldDecodedBytes(outcome.viewers)).toBe(4 * MIB + MIB - MIB);
  });

  it("refuses when the decoded budget cannot be met without closing a visible viewer", () => {
    const viewers = [
      viewer("first", DECODED_ASSET_BUDGET_BYTES / 2, { lastUsed: 1 }),
      viewer("second", DECODED_ASSET_BUDGET_BYTES / 2, { lastUsed: 2 }),
    ];
    expect(heldDecodedBytes(viewers)).toBe(DECODED_ASSET_BUDGET_BYTES);
    const outcome = admitDecodedViewer(viewers, {
      id: "oversize",
      tabId: "tab-2",
      decodedBytes: MIB,
      visible: true,
      lastUsed: 3,
    });
    expect(outcome.admission.kind).toBe("refuse");
    if (outcome.admission.kind !== "refuse") return;
    expect(outcome.admission.blocking).toEqual(["first", "second"]);
    expect(outcome.admission.alternatives).toContain("open-externally");
  });

  it("releases hidden bytes before refusing an over-budget viewer", () => {
    const viewers = [
      viewer("visible", DECODED_ASSET_BUDGET_BYTES - 8 * MIB, { lastUsed: 1 }),
      viewer("hidden", 8 * MIB, { visible: false, lastUsed: 2 }),
    ];
    const outcome = admitDecodedViewer(viewers, {
      id: "wants-room",
      tabId: "tab-2",
      decodedBytes: 4 * MIB,
      visible: true,
      lastUsed: 3,
    });
    expect(outcome.admission.kind).toBe("admit");
    if (outcome.admission.kind !== "admit") return;
    expect(outcome.admission.evict).toEqual(["hidden"]);
    expect(heldDecodedBytes(outcome.viewers)).toBeLessThanOrEqual(
      DECODED_ASSET_BUDGET_BYTES,
    );
  });

  it("refuses a single viewer larger than the whole budget", () => {
    const outcome = admitDecodedViewer([], {
      id: "huge",
      tabId: "tab-1",
      decodedBytes: DECODED_ASSET_BUDGET_BYTES + 1,
      visible: true,
      lastUsed: 1,
    });
    expect(outcome.admission.kind).toBe("refuse");
    if (outcome.admission.kind !== "refuse") return;
    expect(outcome.admission.alternatives).toEqual(["open-externally"]);
    expect(outcome.viewers).toEqual([]);
  });

  it("replaces a re-admitted viewer instead of counting it twice", () => {
    const viewers = [viewer("image", MIB, { lastUsed: 1 })];
    const outcome = admitDecodedViewer(viewers, {
      id: "image",
      tabId: "tab-1",
      decodedBytes: 2 * MIB,
      visible: true,
      lastUsed: 2,
    });
    expect(outcome.viewers).toHaveLength(1);
    expect(outcome.viewers[0]?.decodedBytes).toBe(2 * MIB);
    expect(heldDecodedBytes(outcome.viewers)).toBe(2 * MIB);
  });

  it("releases a slot when the viewer is gone", () => {
    const viewers = [viewer("gone", MIB), viewer("stays", MIB)];
    const remaining = releaseDecodedViewer(viewers, "gone");
    expect(remaining.map((entry) => entry.id)).toEqual(["stays"]);
  });
});

describe("viewer admission store", () => {
  beforeEach(() => {
    useViewerAdmissionStore.setState({ viewers: [], clock: 0 });
  });

  it("keeps recency in admission order so eviction is least-recently-used", () => {
    const store = useViewerAdmissionStore.getState();
    store.admit({
      id: "old",
      tabId: "tab-1",
      decodedBytes: MIB,
      visible: false,
    });
    store.admit({
      id: "new",
      tabId: "tab-1",
      decodedBytes: MIB,
      visible: false,
    });
    const state = useViewerAdmissionStore.getState();
    expect(state.viewers.map((entry) => entry.lastUsed)).toEqual([1, 2]);
  });

  it("marks evicted entries and reports them through the decision", () => {
    const store = useViewerAdmissionStore.getState();
    for (
      let index = 0;
      index < MAX_CONCURRENT_DECODED_VIEWERS + 1;
      index += 1
    ) {
      store.admit({
        id: `viewer-${index}`,
        tabId: "tab-1",
        decodedBytes: MIB,
        visible: index === 0,
      });
    }
    const state = useViewerAdmissionStore.getState();
    expect(state.viewers.some((entry) => entry.evicted)).toBe(true);
    expect(
      state.viewers.find((entry) => entry.id === "viewer-0")?.evicted,
    ).toBe(false);
    expect(heldDecodedBytes(state.viewers)).toBeLessThanOrEqual(
      DECODED_ASSET_BUDGET_BYTES,
    );
  });

  it("frees a slot on release and on releaseAll", () => {
    const store = useViewerAdmissionStore.getState();
    store.admit({
      id: "one",
      tabId: "tab-1",
      decodedBytes: MIB,
      visible: true,
    });
    store.release("one");
    expect(useViewerAdmissionStore.getState().viewers).toEqual([]);
    store.admit({
      id: "two",
      tabId: "tab-1",
      decodedBytes: MIB,
      visible: true,
    });
    useViewerAdmissionStore.getState().releaseAll();
    expect(useViewerAdmissionStore.getState().viewers).toEqual([]);
  });
});
