import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { makeRecord } from "./model";
import { nativeRecoveryStorage } from "./nativeStorage";

const bufferRecord = makeRecord({
  bufferId: "buf-a",
  spaceId: "sp-a",
  path: "/home/me/notes.txt",
  diskRevision: null,
  bufferRevision: 3,
  text: "draft",
  updatedAt: 1,
});

beforeEach(() => {
  invoke.mockReset();
});

describe("native recovery adapter", () => {
  it("sends a record to recovery_put verbatim and reports the byte total", async () => {
    invoke.mockResolvedValue({ bytes: 120, totalBytes: 240 });
    const outcome = await nativeRecoveryStorage.write(bufferRecord);

    expect(invoke).toHaveBeenCalledWith("recovery_put", {
      record: JSON.stringify(bufferRecord),
    });
    expect(outcome).toEqual({ bytes: 120, totalBytes: 240 });
  });

  it("passes the resolved revision to a revision-aware delete", async () => {
    invoke.mockResolvedValue({ removed: true, revision: 3, totalBytes: 0 });
    await nativeRecoveryStorage.remove("buf-a", 3);
    expect(invoke).toHaveBeenCalledWith("recovery_remove", {
      bufferId: "buf-a",
      upToRevision: 3,
    });
  });

  it("ignores records this build did not write instead of offering them", async () => {
    invoke.mockResolvedValue([
      JSON.stringify(bufferRecord),
      "{not json",
      JSON.stringify({ ...bufferRecord, version: 99 }),
      JSON.stringify({ ...bufferRecord, bufferId: "buf-b" }),
    ]);
    const records = await nativeRecoveryStorage.list();
    expect(records.map((r) => r.bufferId)).toEqual(["buf-a", "buf-b"]);
  });

  it("reports usage as a byte total", async () => {
    invoke.mockResolvedValue({ totalBytes: 4096, records: 2 });
    await expect(nativeRecoveryStorage.usage()).resolves.toBe(4096);
  });
});
