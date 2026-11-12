import { beforeEach, describe, expect, it } from "vitest";
import { MAX_PLAYING_MEDIA_APP_WIDE } from "./limits";
import { useMediaPlaybackStore } from "./mediaPlayback";

const store = () => useMediaPlaybackStore.getState();
const ids = () => store().sessions.map((session) => session.id);

beforeEach(() => store().stopAll());

describe("media playback policy", () => {
  it("records a playing element and its tab", () => {
    const outcome = store().start({ id: "a1", tabId: "tab-a" });
    expect(outcome).toEqual({ kind: "play", pause: [] });
    expect(store().sessions).toEqual([
      expect.objectContaining({ id: "a1", tabId: "tab-a", startedAt: 1 }),
    ]);
  });

  it("pauses the other element in the same tab instead of refusing", () => {
    store().start({ id: "a1", tabId: "tab-a" });
    const outcome = store().start({ id: "a2", tabId: "tab-a" });
    expect(outcome).toEqual({ kind: "play", pause: ["a1"] });
    expect(ids()).toEqual(["a2"]);
  });

  it("refuses beyond the approved application-wide ceiling", () => {
    for (let index = 0; index < MAX_PLAYING_MEDIA_APP_WIDE; index += 1) {
      store().start({ id: `s${index}`, tabId: `tab-${index}` });
    }
    const outcome = store().start({ id: "extra", tabId: "tab-extra" });
    expect(outcome.kind).toBe("refuse");
    if (outcome.kind !== "refuse") return;
    expect(outcome.blocking).toHaveLength(MAX_PLAYING_MEDIA_APP_WIDE);
    expect(outcome.alternatives).toContain("stop-other-playback");
    expect(ids()).toEqual(["s0", "s1", "s2"]);
  });

  it("names the blocking elements so the interface can act on them", () => {
    store().start({ id: "a1", tabId: "tab-a", label: "clip.webm" });
    store().start({ id: "b1", tabId: "tab-b", label: "song.mp3" });
    store().start({ id: "c1", tabId: "tab-c", label: "podcast.ogg" });
    const outcome = store().start({ id: "d1", tabId: "tab-d" });
    expect(outcome.kind).toBe("refuse");
    if (outcome.kind !== "refuse") return;
    expect(outcome.blockers).toEqual([
      { id: "a1", label: "clip.webm" },
      { id: "b1", label: "song.mp3" },
      { id: "c1", label: "podcast.ogg" },
    ]);
  });

  it("releases a tab's slot when it hides or closes", () => {
    store().start({ id: "a1", tabId: "tab-a" });
    store().stopTab("tab-a");
    expect(store().sessions).toHaveLength(0);
    for (let index = 0; index < MAX_PLAYING_MEDIA_APP_WIDE; index += 1) {
      expect(
        store().start({ id: `s${index}`, tabId: `tab-${index}` }).kind,
      ).toBe("play");
    }
  });

  it("frees an application-wide slot after stopping one element", () => {
    for (let index = 0; index < MAX_PLAYING_MEDIA_APP_WIDE; index += 1) {
      store().start({ id: `s${index}`, tabId: `tab-${index}` });
    }
    expect(store().start({ id: "extra", tabId: "tab-x" }).kind).toBe("refuse");
    store().stop("s1");
    expect(store().start({ id: "extra", tabId: "tab-x" }).kind).toBe("play");
  });

  it("stops an unknown or already stopped element without inventing a slot", () => {
    store().stop("missing");
    store().start({ id: "a1", tabId: "tab-a" });
    store().stop("a1");
    store().stop("a1");
    expect(store().sessions).toHaveLength(0);
  });
});
