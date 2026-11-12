import { describe, expect, it } from "vitest";
import { RECOVERY_LIMITS } from "./model";
import { admitWrite, canResume, quotaPauseReason } from "./quota";

const MiB = 1024 * 1024;

describe("recovery quota admission", () => {
  it("admits a draft within the 10 MiB per-file bound", () => {
    expect(
      admitWrite({
        existingBytes: 0,
        incomingBytes: 10 * MiB,
        usedBytes: 0,
        limits: RECOVERY_LIMITS,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a single draft over 10 MiB for that buffer only", () => {
    expect(
      admitWrite({
        existingBytes: 0,
        incomingBytes: 10 * MiB + 1,
        usedBytes: 0,
        limits: RECOVERY_LIMITS,
      }),
    ).toEqual({ ok: false, reason: "file-limit" });
  });

  it("fills to 100 MiB total and then refuses growth", () => {
    const tenRecords = 10 * 10 * MiB;
    expect(
      admitWrite({
        existingBytes: 0,
        incomingBytes: 5 * MiB,
        usedBytes: tenRecords - 5 * MiB,
        limits: RECOVERY_LIMITS,
      }),
    ).toEqual({ ok: true });
    expect(
      admitWrite({
        existingBytes: 0,
        incomingBytes: 5 * MiB,
        usedBytes: tenRecords - 4 * MiB,
        limits: RECOVERY_LIMITS,
      }),
    ).toEqual({ ok: false, reason: "total-limit" });
  });

  it("re-writing an existing record replaces its own bytes instead of adding them", () => {
    // At the total bound, continuing to edit one buffer must not be paused:
    // its record is overwritten, so usage does not grow.
    const atLimit = RECOVERY_LIMITS.totalBytes;
    expect(
      admitWrite({
        existingBytes: 10 * MiB,
        incomingBytes: 10 * MiB,
        usedBytes: atLimit,
        limits: RECOVERY_LIMITS,
      }),
    ).toEqual({ ok: true });
  });

  it("accounts for a shrinking record", () => {
    expect(
      admitWrite({
        existingBytes: 9 * MiB,
        incomingBytes: 1 * MiB,
        usedBytes: RECOVERY_LIMITS.totalBytes,
        limits: RECOVERY_LIMITS,
      }),
    ).toEqual({ ok: true });
  });
});

describe("pausing instead of evicting", () => {
  it("reports the pause reason an admission refusal implies", () => {
    expect(quotaPauseReason("file-limit")).toBe("file-limit");
    expect(quotaPauseReason("total-limit")).toBe("total-limit");
  });

  it("resumes only once the pending draft fits again", () => {
    const used = RECOVERY_LIMITS.totalBytes - MiB;
    expect(
      canResume({
        pendingBytes: MiB,
        usedBytes: used,
        limits: RECOVERY_LIMITS,
      }),
    ).toBe(true);
    expect(
      canResume({
        pendingBytes: MiB + 1,
        usedBytes: used,
        limits: RECOVERY_LIMITS,
      }),
    ).toBe(false);
  });
});
