import { describe, expect, it } from "vitest";
import { createDocumentLoad, type LoadOutcome } from "./documentLoad";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createDocumentLoad", () => {
  it("publishes the latest completion", async () => {
    const first = deferred<string>();
    const applied: Array<LoadOutcome<string>> = [];
    const gate = createDocumentLoad(
      () => first.promise,
      (outcome) => applied.push(outcome),
    );
    gate.load();
    first.resolve("hello");
    await settle();
    expect(applied).toEqual([{ ok: true, value: "hello" }]);
  });

  it("ignores a completion that lands after the document closed", async () => {
    const first = deferred<string>();
    const applied: Array<LoadOutcome<string>> = [];
    const gate = createDocumentLoad(
      () => first.promise,
      (outcome) => applied.push(outcome),
    );
    gate.load();
    gate.close();
    first.resolve("stale");
    await settle();
    expect(applied).toEqual([]);
  });

  it("does not let an older read replace a newer one", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const queue = [first.promise, second.promise];
    const applied: Array<LoadOutcome<string>> = [];
    const next = () =>
      queue.shift() ?? Promise.reject(new Error("no read queued"));
    const gate = createDocumentLoad(next, (outcome) => applied.push(outcome));
    gate.load();
    gate.load();
    second.resolve("new");
    await settle();
    first.resolve("old");
    await settle();
    expect(applied).toEqual([{ ok: true, value: "new" }]);
  });

  it("reports a failure once and stops after close", async () => {
    const first = deferred<string>();
    const applied: Array<LoadOutcome<string>> = [];
    const gate = createDocumentLoad(
      () => first.promise,
      (outcome) => applied.push(outcome),
    );
    gate.load();
    first.reject(new Error("permission denied"));
    await settle();
    expect(applied).toEqual([
      { ok: false, error: new Error("permission denied") },
    ]);

    const late = deferred<string>();
    const closed = createDocumentLoad(
      () => late.promise,
      (outcome) => applied.push(outcome),
    );
    closed.load();
    closed.close();
    late.reject(new Error("late"));
    await settle();
    expect(applied).toHaveLength(1);
  });
});
