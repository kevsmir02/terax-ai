import { describe, expect, it } from "vitest";
import {
  bufferIdFor,
  diskIdentityOf,
  isRecordablePath,
  parseRecord,
  RECOVERY_LIMITS,
  type RecoveryRecord,
} from "./model";

const record: RecoveryRecord = {
  version: 1,
  bufferId: "buf-s1-t3-x",
  spaceId: "sp-a",
  path: "/home/me/notes.txt",
  fileIdentity: "8-9",
  bufferRevision: 4,
  diskRevision: "r1:aa:12:8-9",
  text: "unsaved\n",
  bytes: 8,
  updatedAt: 1_700_000_000_000,
};

describe("recovery storage policy", () => {
  it("is the 10 MiB per file / 100 MiB total policy the spec discloses", () => {
    expect(RECOVERY_LIMITS.perFileBytes).toBe(10 * 1024 * 1024);
    expect(RECOVERY_LIMITS.totalBytes).toBe(100 * 1024 * 1024);
  });

  it("keeps recovery in its own directory, not the layout-persistence files", () => {
    // The native store creates `<app data>/recovery`; layout and preferences
    // are JSON files directly in the app data directory.
    expect(RECOVERY_LIMITS.directory).toBe("recovery");
    expect(RECOVERY_LIMITS.directory).not.toMatch(/\.json$/);
  });
});

describe("buffer identity", () => {
  it("is stable for one buffer instance", () => {
    const input = { sessionId: "s1", spaceId: "sp-a", tabId: 3 };
    expect(bufferIdFor(input)).toBe(bufferIdFor({ ...input }));
  });

  it("keeps two Spaces editing the same pathname independent", () => {
    // The path is deliberately absent from the identity: it is not the owner.
    const a = bufferIdFor({ sessionId: "s1", spaceId: "sp-a", tabId: 3 });
    const b = bufferIdFor({ sessionId: "s1", spaceId: "sp-b", tabId: 3 });
    expect(a).not.toBe(b);
    expect(a).not.toContain("notes.txt");
    expect(a).not.toContain("/");
  });

  it("gives two buffers in one Space distinct identities", () => {
    const first = bufferIdFor({ sessionId: "s1", spaceId: "sp-a", tabId: 3 });
    const second = bufferIdFor({ sessionId: "s1", spaceId: "sp-a", tabId: 4 });
    expect(first).not.toBe(second);
  });

  it("never reuses a pre-crash buffer's identity", () => {
    // A restarted process gets a new session id, so a recovered record is
    // orphaned (offered for restore) instead of silently owned by a new buffer.
    const before = bufferIdFor({ sessionId: "s1", spaceId: "sp-a", tabId: 3 });
    const after = bufferIdFor({ sessionId: "s2", spaceId: "sp-a", tabId: 3 });
    expect(before).not.toBe(after);
  });
});

describe("original-file identity", () => {
  it("extracts the file identity from a ticket-#15 disk revision", () => {
    expect(diskIdentityOf(`r1:${"ab".repeat(32)}:12:8-9`)).toBe("8-9");
    expect(diskIdentityOf(`r1:${"ab".repeat(32)}:0:0-0`)).toBe("0-0");
  });

  it("has no identity for unknown or foreign revisions", () => {
    for (const value of [
      null,
      "",
      "r2:aa:1:0-0",
      "nonsense",
      `r1:${"ab".repeat(32)}:12:`,
    ]) {
      expect(diskIdentityOf(value)).toBeNull();
    }
  });
});

describe("sensitive-path exclusion", () => {
  it("refuses the shared policy's known-sensitive paths instead of forking it", () => {
    for (const path of [
      "/home/me/project/.env",
      "/home/me/.ssh/config",
      "/home/me/deploy/id_rsa",
      "/home/me/secrets/service-account.json",
      "/home/me/.claude/settings.json",
      "/home/me/.claude.json",
      "/home/me/.local/share/codr/space-profiles/sp-a/claude/.credentials.json",
    ]) {
      const verdict = isRecordablePath(path);
      expect(verdict.recordable, path).toBe(false);
      if (!verdict.recordable) expect(verdict.reason).toBeTruthy();
    }
  });

  it("records ordinary project and note files", () => {
    for (const path of [
      "/home/me/notes.txt",
      "/home/me/project/src/a.ts",
      "/var/log/app.log",
      "C:\\work\\a.ts",
    ]) {
      expect(isRecordablePath(path).recordable, path).toBe(true);
    }
  });
});

describe("record parsing", () => {
  it("round-trips a record through its stored JSON form", () => {
    expect(parseRecord(JSON.stringify(record))).toEqual(record);
  });

  it("refuses anything this build did not write", () => {
    for (const raw of [
      "not json",
      JSON.stringify({ ...record, version: 2 }),
      JSON.stringify({ ...record, bufferRevision: 0 }),
      JSON.stringify({ ...record, bufferId: "" }),
      JSON.stringify({ ...record, text: 3 }),
      // The declared text size must match the text: a truncated draft is not
      // silently offered as recovery.
      JSON.stringify({ ...record, bytes: 99 }),
    ]) {
      expect(parseRecord(raw), raw).toBeNull();
    }
  });
});
