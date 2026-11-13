import {
  createStoredDraftList,
  type StoredDraftListState,
  type StoredDraftSource,
} from "@/modules/editor/lib/recovery/draftList";
import {
  makeRecord,
  type RecoveryRecord,
} from "@/modules/editor/lib/recovery/model";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RecoveryDraftListBody } from "./RecoveryDraftList";

const MiB = 1024 * 1024;
const NOW = 1_700_000_000_000;

function draft(
  input: {
    bufferId?: string;
    path?: string;
    text?: string;
    ageMs?: number;
    revision?: number;
  } = {},
): RecoveryRecord {
  const ageMs = input.ageMs ?? 0;
  return makeRecord({
    bufferId: input.bufferId ?? "buf-notes",
    spaceId: "sp-a",
    path: input.path ?? "/home/me/notes.txt",
    diskRevision: null,
    // Keep the record envelope (and therefore its stored size) a fixed,
    // independently measured value: see the byte literals below.
    bufferRevision: input.revision ?? 1,
    text: input.text ?? "unsaved words",
    updatedAt: NOW - ageMs,
  });
}

function fakeSource(records: RecoveryRecord[]) {
  const stored = new Map(records.map((record) => [record.bufferId, record]));
  const discardDraft = vi.fn(async (record: RecoveryRecord) => {
    stored.delete(record.bufferId);
  });
  const source: StoredDraftSource = {
    async records() {
      return [...stored.values()];
    },
    discardDraft,
  };
  return { source, stored, discardDraft };
}

function render(
  state: StoredDraftListState,
  options: { discardError?: string | null } = {},
): string {
  return renderToStaticMarkup(
    createElement(RecoveryDraftListBody, {
      state,
      quotaBytes: 100 * MiB,
      discardError: options.discardError ?? null,
      onDiscard: () => undefined,
      onReload: () => undefined,
    }),
  );
}

describe("stored drafts are listed where the quota tells you to discard one", () => {
  it("lists every stored draft newest first with size, age, count and total", async () => {
    const older = draft({
      bufferId: "buf-older",
      path: "/home/me/older.txt",
      text: "older unsaved words",
      ageMs: 2 * 60 * 60 * 1000,
    });
    const newer = draft({
      bufferId: "buf-newer",
      path: "/home/me/newer.txt",
      text: "newer unsaved words",
      ageMs: 5 * 60 * 1000,
      revision: 3,
    });
    const { source } = fakeSource([older, newer]);
    const list = createStoredDraftList({ source, now: () => NOW });

    const state = await list.load();
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;

    expect(state.count).toBe(2);
    expect(state.rows.map((row) => row.bufferId)).toEqual([
      "buf-newer",
      "buf-older",
    ]);
    const html = render(state);
    expect(html).toContain("/home/me/newer.txt");
    expect(html).toContain("/home/me/older.txt");
    expect(html.indexOf("/home/me/newer.txt")).toBeLessThan(
      html.indexOf("/home/me/older.txt"),
    );
    expect(html).toContain("2 stored drafts");
    expect(html).toContain("of 100 MiB");
    expect(html).toContain("5 min old");
    expect(html).toContain("2 h old");
    // The stored size is what the quota spends, not the text length: the
    // envelope of this fixed record serializes to 204 bytes (measured once by
    // serializing the same literal record, not by calling recordBytes here).
    expect(html).toContain("204 B");
    expect(state.totalBytes).toBe(408);
  });

  it("discards exactly the offered record once and drops its row", async () => {
    const first = draft({ bufferId: "buf-first", path: "/home/me/first.txt" });
    const second = draft({
      bufferId: "buf-second",
      path: "/home/me/second.txt",
      revision: 2,
    });
    const { source, discardDraft, stored } = fakeSource([first, second]);
    const list = createStoredDraftList({ source, now: () => NOW });
    const before = await list.load();
    if (before.kind !== "ready") throw new Error("expected a ready list");

    const result = await list.discard(before.rows[0].record);

    expect(result.ok).toBe(true);
    expect(discardDraft).toHaveBeenCalledTimes(1);
    expect(discardDraft).toHaveBeenCalledWith(first);
    expect(stored.has("buf-first")).toBe(false);
    expect(stored.has("buf-second")).toBe(true);
    const after = result.state;
    expect(after.kind).toBe("ready");
    if (after.kind !== "ready") return;
    expect(after.rows.map((row) => row.bufferId)).toEqual(["buf-second"]);
    expect(render(after)).not.toContain("/home/me/first.txt");
    expect(render(after)).toContain("/home/me/second.txt");
    expect(render(after)).toContain("1 stored draft");
  });

  it("says what discarding does, and never claims the file is deleted", async () => {
    const { source } = fakeSource([draft()]);
    const state = await createStoredDraftList({
      source,
      now: () => NOW,
    }).load();
    const html = render(state);
    expect(html).toContain("Discard");
    expect(html).toContain("your file on disk is untouched");
    expect(html.toLowerCase()).not.toContain("delete the file");
  });

  it("shows an empty state instead of inventing a row", async () => {
    const state = await createStoredDraftList({
      source: fakeSource([]).source,
      now: () => NOW,
    }).load();
    expect(state.kind).toBe("ready");
    const html = render(state);
    expect(html).toContain("No stored drafts");
    expect(html).not.toContain("Discard");
  });

  it("never lists a record for an excluded sensitive path", async () => {
    const sensitive = draft({
      bufferId: "buf-env",
      path: "/home/me/project/.env",
    });
    const ordinary = draft({ bufferId: "buf-notes" });
    const state = await createStoredDraftList({
      source: fakeSource([sensitive, ordinary]).source,
      now: () => NOW,
    }).load();
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.rows.map((row) => row.bufferId)).toEqual(["buf-notes"]);
    expect(render(state)).not.toContain(".env");
  });

  it("names an unknown path explicitly rather than showing a blank row", async () => {
    const state = await createStoredDraftList({
      source: fakeSource([draft({ path: "   " })]).source,
      now: () => NOW,
    }).load();
    const html = render(state);
    expect(html).toContain("Unknown path");
  });

  it("reports unavailable storage without a row", async () => {
    const source: StoredDraftSource = {
      async records() {
        throw { kind: "unavailable", message: "read-only volume" };
      },
      async discardDraft() {
        throw new Error("unreachable");
      },
    };
    const state = await createStoredDraftList({
      source,
      now: () => NOW,
    }).load();
    expect(state.kind).toBe("unavailable");
    const html = render(state);
    expect(html).toContain("unavailable");
    expect(html).not.toContain("Discard");
  });

  it("reports a failed read, keeping retry honest", async () => {
    const source: StoredDraftSource = {
      async records() {
        throw new Error("permission denied");
      },
      async discardDraft() {
        throw new Error("unreachable");
      },
    };
    const state = await createStoredDraftList({
      source,
      now: () => NOW,
    }).load();
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") return;
    expect(state.message).toBe("permission denied");
    expect(render(state)).toContain("Try again");
  });

  it("shows a loading state before the first read resolves", () => {
    expect(render({ kind: "loading" })).toContain("Loading stored drafts");
  });

  it("keeps the row and says why when a discard fails", async () => {
    const { source, discardDraft } = fakeSource([draft()]);
    discardDraft.mockRejectedValueOnce(new Error("storage is busy"));
    const list = createStoredDraftList({ source, now: () => NOW });
    const before = await list.load();
    if (before.kind !== "ready") throw new Error("expected a ready list");

    const result = await list.discard(before.rows[0].record);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("storage is busy");
    expect(result.state.kind).toBe("ready");
    if (result.state.kind !== "ready") return;
    expect(result.state.rows).toHaveLength(1);
    const html = render(result.state, { discardError: result.message });
    expect(html).toContain("/home/me/notes.txt");
    expect(html).toContain("storage is busy");
  });
});
