import { describe, expect, it } from "vitest";
import {
  checkFormatBaseline,
  commitBuffer,
  createSaveQueue,
  type DiskIo,
  overwriteReviewed,
  planReload,
  reloadDiscard,
  reviewConflict,
  saveCopy,
  type SaveConflict,
} from "./diskSync";

/**
 * Stand-in for the native write path. It enforces the same contract the Rust
 * coordination does (`src-tauri/tests/save_revision.rs` owns the real
 * semantics): a write is refused unless the opaque revision still matches, and
 * the refusal arrives as `{kind:"conflict", reason, current}`.
 */
function fakeDisk() {
  const files = new Map<string, string>();
  let inode = 0;
  let writes = 0;
  let held: { promise: Promise<void>; release: () => void } | null = null;
  const revisionOf = (path: string) =>
    files.has(path) ? `r1:${inode}:${files.get(path)}` : null;
  const io: DiskIo = {
    async write(path, content, expectedRevision) {
      const gate = held;
      held = null;
      if (gate) await gate.promise;
      const current = revisionOf(path);
      if (expectedRevision !== null && expectedRevision !== current) {
        throw {
          kind: "conflict",
          reason: current === null ? "missing" : "changed",
          current,
        };
      }
      inode += 1;
      writes += 1;
      files.set(path, content);
      return { mtime: 1, revision: `r1:${inode}:${content}` };
    },
    async read(path) {
      const content = files.get(path);
      if (content === undefined) throw "file no longer exists";
      return {
        content,
        revision: `r1:${inode}:${content}`,
        mtime: 1,
        size: content.length,
      };
    },
    async exists(path) {
      return files.has(path);
    },
    async revision(path) {
      const current = revisionOf(path);
      if (current === null) throw "file no longer exists";
      return current;
    },
  };
  return {
    io,
    files,
    put: (path: string, content: string) => {
      inode += 1;
      files.set(path, content);
    },
    read: (path: string) => files.get(path),
    writes: () => writes,
    revisionOf,
    /** Same-inode rewrite, i.e. another program edited the file in place. */
    edit: (path: string, content: string) => files.set(path, content),
    /** Suspends the next write until the returned release is called. */
    holdNextWrite: () => {
      let release = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      held = { promise, release };
      return release;
    },
  };
}

const note = "/spaces/w/note.txt";

async function conflictOf(result: Awaited<ReturnType<typeof commitBuffer>>) {
  if (result.status !== "conflict") {
    throw new Error(`expected a conflict, got ${result.status}`);
  }
  return result.conflict;
}

describe("disk revisions", () => {
  it("lets the first of two dirty buffers save and refuses the second", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    const baseline = disk.revisionOf(note) as string;

    const first = await commitBuffer(disk.io, {
      path: note,
      expectedRevision: baseline,
      buffer: () => "from space one\n",
    });
    expect(first.status).toBe("saved");
    expect(disk.read(note)).toBe("from space one\n");

    // The second buffer was edited from the same baseline: its text is kept and
    // never reaches the disk.
    const second = await commitBuffer(disk.io, {
      path: note,
      expectedRevision: baseline,
      buffer: () => "from space two\n",
    });
    const conflict = await conflictOf(second);
    expect(conflict.reason).toBe("changed");
    expect(conflict.bufferText).toBe("from space two\n");
    expect(conflict.currentRevision).toBe(disk.revisionOf(note));
    expect(disk.read(note)).toBe("from space one\n");
  });

  it("keeps writing fine from the revision the first save reported", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    const first = await commitBuffer(disk.io, {
      path: note,
      expectedRevision: disk.revisionOf(note) as string,
      buffer: () => "one\n",
    });
    if (first.status !== "saved") throw new Error("expected a save");

    const second = await commitBuffer(disk.io, {
      path: note,
      expectedRevision: first.revision,
      buffer: () => "two\n",
    });
    expect(second.status).toBe("saved");
    expect(disk.read(note)).toBe("two\n");
  });

  it("refuses a save after the disk changed, even with no clock or size signal", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    const baseline = disk.revisionOf(note) as string;
    // Same length, same "mtime" from the caller's point of view.
    disk.edit(note, "BASEline\n");

    const result = await commitBuffer(disk.io, {
      path: note,
      expectedRevision: baseline,
      buffer: () => "mine\n",
    });
    expect((await conflictOf(result)).reason).toBe("changed");
    expect(disk.read(note)).toBe("BASEline\n");
  });
});

describe("conflict outcomes", () => {
  it("binds an overwrite to the reviewed revision and refuses a stale consent", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    const baseline = disk.revisionOf(note) as string;

    disk.edit(note, "external one\n");
    const detected = await conflictOf(
      await commitBuffer(disk.io, {
        path: note,
        expectedRevision: baseline,
        buffer: () => "mine\n",
      }),
    );
    const reviewed = await reviewConflict(disk.io, detected);
    expect(reviewed.reviewedRevision).toBe(disk.revisionOf(note));
    expect(reviewed.reviewedText).toBe("external one\n");

    // A later change invalidates the consent the user gave.
    disk.edit(note, "external two\n");
    const stale = await overwriteReviewed(disk.io, reviewed, () => "mine\n");
    expect((await conflictOf(stale)).reason).toBe("changed");
    expect(disk.read(note)).toBe("external two\n");

    // The fresh round consents to the revision now on disk.
    const fresh = await reviewConflict(disk.io, await conflictOf(stale));
    const written = await overwriteReviewed(disk.io, fresh, () => "mine\n");
    expect(written.status).toBe("saved");
    expect(disk.read(note)).toBe("mine\n");
  });

  it("does not report a complete overwrite when newer typing arrived during the write", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    const baseline = disk.revisionOf(note) as string;
    disk.edit(note, "external\n");
    const reviewed = await reviewConflict(
      disk.io,
      await conflictOf(
        await commitBuffer(disk.io, {
          path: note,
          expectedRevision: baseline,
          buffer: () => "mine\n",
        }),
      ),
    );

    let typed = "mine\n";
    const pending = overwriteReviewed(disk.io, reviewed, () => typed);
    typed = "mine, then more\n";
    const result = await pending;
    if (result.status !== "saved") throw new Error("expected a save");
    // The overwrite persisted the reviewed snapshot; the newer text is still
    // the caller's to save, so the completion is not complete.
    expect(result.writtenText).toBe("mine\n");
    expect(result.complete).toBe(false);
    expect(disk.read(note)).toBe("mine\n");
  });

  it("cannot overwrite a target that no longer exists", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    const baseline = disk.revisionOf(note) as string;
    disk.files.delete(note);

    const detected = await conflictOf(
      await commitBuffer(disk.io, {
        path: note,
        expectedRevision: baseline,
        buffer: () => "mine\n",
      }),
    );
    expect(detected.reason).toBe("missing");
    const reviewed = await reviewConflict(disk.io, detected);
    expect(reviewed.reviewedRevision).toBeNull();

    const attempt = await overwriteReviewed(disk.io, reviewed, () => "mine\n");
    expect(attempt.status).toBe("failed");
    expect(disk.files.has(note)).toBe(false);
  });

  it("cannot overwrite a target the review could not read", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    const baseline = disk.revisionOf(note) as string;
    const unreadable: SaveConflict = {
      path: note,
      reason: "unreadable",
      expectedRevision: baseline,
      bufferText: "mine\n",
      currentRevision: baseline,
      reviewedRevision: null,
      reviewedText: null,
    };
    // The target vanished between the refusal and the review: there is nothing
    // to consent to, so overwriting is impossible rather than recreating it.
    disk.files.delete(note);
    const reviewed = await reviewConflict(disk.io, unreadable);
    expect(reviewed.reason).toBe("unreadable");
    expect(reviewed.reviewedRevision).toBeNull();
    expect(reviewed.reviewedText).toBeNull();

    const attempt = await overwriteReviewed(disk.io, reviewed, () => "mine\n");
    expect(attempt.status).toBe("failed");
    expect(disk.files.has(note)).toBe(false);
    expect(disk.writes()).toBe(0);
  });

  it("treats a replaced target as reviewable rather than silently overwritten", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    const baseline = disk.revisionOf(note) as string;
    // Replace the identity without changing the bytes: only the native side can
    // see this, so the fake reports it the way Rust does.
    disk.put(note, "baseline\n");

    const conflict: SaveConflict = {
      path: note,
      reason: "replaced",
      expectedRevision: baseline,
      bufferText: "mine\n",
      currentRevision: disk.revisionOf(note),
      reviewedRevision: null,
      reviewedText: null,
    };
    const reviewed = await reviewConflict(disk.io, conflict);
    expect(reviewed.reason).toBe("replaced");
    expect(reviewed.reviewedRevision).toBe(disk.revisionOf(note));
    const written = await overwriteReviewed(disk.io, reviewed, () => "mine\n");
    expect(written.status).toBe("saved");
    expect(disk.read(note)).toBe("mine\n");
  });

  it("reload/discard adopts the disk text and never writes the buffer", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    const baseline = disk.revisionOf(note) as string;
    disk.edit(note, "external\n");

    const conflict = await conflictOf(
      await commitBuffer(disk.io, {
        path: note,
        expectedRevision: baseline,
        buffer: () => "mine\n",
      }),
    );
    const reviewed = await reviewConflict(disk.io, conflict);
    expect(reviewed.reviewedText).toBe("external\n");

    const reloaded = await reloadDiscard(disk.io, note);
    expect(reloaded.status).toBe("reloaded");
    if (reloaded.status !== "reloaded") throw new Error("expected a reload");
    // The chosen content is the current disk text, not the abandoned buffer and
    // not the text reviewed a moment ago.
    expect(reloaded.disk.content).toBe("external\n");
    expect(reloaded.disk.revision).toBe(disk.revisionOf(note));
    expect(disk.read(note)).toBe("external\n");
    expect(disk.writes()).toBe(0);
  });

  it("reports a failed reload instead of recreating a missing file", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    disk.files.delete(note);

    const reloaded = await reloadDiscard(disk.io, note);
    expect(reloaded.status).toBe("failed");
    expect(disk.files.has(note)).toBe(false);
    expect(disk.writes()).toBe(0);
  });

  it("saves a copy elsewhere and leaves the conflicting file alone", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    disk.put("/spaces/w/other.txt", "someone else's work\n");

    const copy = await saveCopy(disk.io, {
      sourcePath: note,
      targetPath: "/spaces/w/note copy.txt",
      text: "mine\n",
    });
    expect(copy.status).toBe("saved");
    expect(disk.read("/spaces/w/note copy.txt")).toBe("mine\n");
    expect(disk.read(note)).toBe("baseline\n");

    // Save As is not a back door to a blind overwrite of the same file or of
    // another existing file.
    const same = await saveCopy(disk.io, {
      sourcePath: note,
      targetPath: note,
      text: "mine\n",
    });
    expect(same.status).toBe("failed");
    const existing = await saveCopy(disk.io, {
      sourcePath: note,
      targetPath: "/spaces/w/other.txt",
      text: "mine\n",
    });
    expect(existing.status).toBe("failed");
    expect(disk.read("/spaces/w/other.txt")).toBe("someone else's work\n");
    expect(disk.read(note)).toBe("baseline\n");
  });
});

describe("a save racing newer typing", () => {
  it("persists the snapshot, reports incompleteness and keeps the newer text", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    let typed = "typed once\n";

    const pending = commitBuffer(disk.io, {
      path: note,
      expectedRevision: disk.revisionOf(note) as string,
      buffer: () => typed,
    });
    // Typed while the write is in flight.
    typed = "typed once, then more\n";
    const first = await pending;
    if (first.status !== "saved") throw new Error("expected a save");

    expect(first.writtenText).toBe("typed once\n");
    expect(first.complete).toBe(false);
    expect(disk.read(note)).toBe("typed once\n");
    expect(typed).toBe("typed once, then more\n");

    // The next save persists the newer text against the revision just written;
    // nothing reverts to the older snapshot.
    const second = await commitBuffer(disk.io, {
      path: note,
      expectedRevision: first.revision,
      buffer: () => typed,
    });
    if (second.status !== "saved") throw new Error("expected a save");
    expect(second.complete).toBe(true);
    expect(disk.read(note)).toBe("typed once, then more\n");
  });

  it("queues the next save so it writes newer text against the revision the previous save left", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    const queue = createSaveQueue();
    const starts: string[] = [];
    // What `useDocument` tracks: updated only when a save completes.
    let expected = disk.revisionOf(note) as string;
    let typed = "one\n";

    const save = () =>
      queue.run(async () => {
        starts.push(typed);
        const result = await commitBuffer(disk.io, {
          path: note,
          expectedRevision: expected,
          buffer: () => typed,
        });
        if (result.status !== "saved") {
          throw new Error(`unexpected conflict: ${JSON.stringify(result)}`);
        }
        expected = result.revision;
        return result;
      });

    const release = disk.holdNextWrite();
    const first = save();
    // Let the first save snapshot "one" and block in the write, then type and
    // ask for another save while it is still in flight.
    await Promise.resolve();
    typed = "one, then two\n";
    const second = save();
    release();

    const [a, b] = await Promise.all([first, second]);
    // The queued save did not start from the stale baseline: it saw the newer
    // text and the revision the first save left, so it saved instead of
    // manufacturing a conflict against our own commit.
    expect(starts).toEqual(["one\n", "one, then two\n"]);
    expect(a.writtenText).toBe("one\n");
    expect(a.complete).toBe(false);
    expect(b.status).toBe("saved");
    expect(b.writtenText).toBe("one, then two\n");
    expect(b.complete).toBe(true);
    expect(disk.writes()).toBe(2);
    expect(disk.read(note)).toBe("one, then two\n");
  });

  it("keeps the queue usable after a save fails", async () => {
    const queue = createSaveQueue();
    const starts: string[] = [];
    const first = queue.run(async () => {
      starts.push("first");
      throw new Error("disk full");
    });
    const second = queue.run(async () => {
      starts.push("second");
      return "saved";
    });

    await expect(first).rejects.toThrow("disk full");
    await expect(second).resolves.toBe("saved");
    expect(starts).toEqual(["first", "second"]);
  });
});

describe("app-owned format steps", () => {
  it("allows formatting only the revision the editor just saved", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    const saved = await commitBuffer(disk.io, {
      path: note,
      expectedRevision: disk.revisionOf(note) as string,
      buffer: () => "formatted candidate\n",
    });
    if (saved.status !== "saved") throw new Error("expected a save");

    expect(
      await checkFormatBaseline(disk.io, {
        path: note,
        expectedRevision: saved.revision,
        bufferText: "formatted candidate\n",
      }),
    ).toEqual({ ok: true });

    // Someone else wrote the file between the save and the formatter: the
    // formatter must not run over their text.
    disk.edit(note, "someone else\n");
    const blocked = await checkFormatBaseline(disk.io, {
      path: note,
      expectedRevision: saved.revision,
      bufferText: "formatted candidate\n",
    });
    if (blocked.ok) throw new Error("expected the format step to be refused");
    expect(blocked.conflict.reason).toBe("changed");
    expect(blocked.conflict.currentRevision).toBe(disk.revisionOf(note));
    expect(disk.read(note)).toBe("someone else\n");
  });

  it("refuses to format a file that disappeared", async () => {
    const disk = fakeDisk();
    disk.put(note, "baseline\n");
    const saved = await commitBuffer(disk.io, {
      path: note,
      expectedRevision: disk.revisionOf(note) as string,
      buffer: () => "mine\n",
    });
    if (saved.status !== "saved") throw new Error("expected a save");
    disk.files.delete(note);

    const blocked = await checkFormatBaseline(disk.io, {
      path: note,
      expectedRevision: saved.revision,
      bufferText: "mine\n",
    });
    if (blocked.ok) throw new Error("expected the format step to be refused");
    expect(blocked.conflict.reason).toBe("missing");
  });
});

describe("buffer fidelity", () => {
  it("writes the caller's bytes verbatim, line endings included", async () => {
    // The coordination layer never normalizes: EOL and indentation belong to
    // the caller (the editor restores its detected EOL before the write).
    const disk = fakeDisk();
    disk.put(note, "one\r\n  two\r\n");
    const result = await commitBuffer(disk.io, {
      path: note,
      expectedRevision: disk.revisionOf(note) as string,
      buffer: () => "one\r\n    two, indented\r\n",
    });
    expect(result.status).toBe("saved");
    expect(disk.read(note)).toBe("one\r\n    two, indented\r\n");
  });
});

describe("reread policy", () => {
  it("never replaces a dirty buffer", () => {
    expect(
      planReload({ dirty: true, visible: true, pendingReread: false }),
    ).toBe("withhold");
    expect(
      planReload({ dirty: true, visible: false, pendingReread: false }),
    ).toBe("withhold");
  });

  it("defers a clean hidden buffer until it is visible again", () => {
    expect(
      planReload({ dirty: false, visible: false, pendingReread: false }),
    ).toBe("defer");
    expect(
      planReload({ dirty: false, visible: false, pendingReread: true }),
    ).toBe("defer");
  });

  it("rereads a clean visible buffer, including a deferred one", () => {
    expect(
      planReload({ dirty: false, visible: true, pendingReread: false }),
    ).toBe("reread");
    expect(
      planReload({ dirty: false, visible: true, pendingReread: true }),
    ).toBe("reread");
  });
});
