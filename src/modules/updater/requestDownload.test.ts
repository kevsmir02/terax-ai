import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvailableRelease } from "./releaseManifest";
import { requestDownload } from "./requestDownload";

const release: AvailableRelease = {
  version: "0.10.0",
  channel: "stable",
  notes: "fixture",
  publishedAt: "2026-10-01T12:00:00Z",
  trust: "fixture-unverified",
  artifact: {
    url: "http://127.0.0.1:8787/Terax_0.10.0_amd64.deb",
    signature: "untrusted comment: fixture\nAA==\ntrusted comment: fixture",
    size: 1234,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gated download request", () => {
  it("refuses without explicit approval", async () => {
    const result = await requestDownload({ release, approved: false });
    expect(result).toEqual({ kind: "refused", reason: "not-approved" });
  });

  it("leaves the install handoff to #39 instead of downloading anything", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const invoke = vi.fn();
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });

    const result = await requestDownload({ release, approved: true });

    expect(result.kind).toBe("not-implemented");
    if (result.kind !== "not-implemented") return;
    expect(result.ticket).toBe(39);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
