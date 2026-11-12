import { describe, expect, it } from "vitest";
import {
  processStatusLabel,
  signalStatus,
  sessionStatusLabel,
  type StatusSignalKind,
} from "./status";

const KINDS: StatusSignalKind[] = [
  "started",
  "working",
  "attention",
  "finished",
  "exited",
];

describe("signalStatus", () => {
  it("treats the process lifecycle as running/exited, never as a finished turn", () => {
    expect(signalStatus("started")).toMatchObject({
      status: "running",
      evidence: "process",
      turnEnded: false,
    });
    expect(signalStatus("working")).toMatchObject({
      status: "running",
      evidence: "process",
      turnEnded: false,
    });
    expect(signalStatus("exited")).toMatchObject({
      status: null,
      evidence: "process",
      turnEnded: false,
    });
  });

  it("keeps the process running after a turn-finished event", () => {
    // A stop/turn hook says the turn ended; it says nothing about the process,
    // which is still attached to the pane and may run another turn.
    expect(signalStatus("finished")).toMatchObject({
      status: "running",
      evidence: "event",
      event: "turn-finished",
      turnEnded: true,
    });
  });

  it("reports attention from an event, not from process aliveness", () => {
    expect(signalStatus("attention")).toMatchObject({
      status: "attention",
      evidence: "event",
      turnEnded: false,
    });
  });

  it("lets only an agent event claim the turn ended", () => {
    const claiming = KINDS.filter((kind) => signalStatus(kind).turnEnded);

    expect(claiming).toEqual(["finished"]);
  });
});

describe("labels", () => {
  it("describes the two session statuses by their evidence", () => {
    expect(sessionStatusLabel("running")).toBe("running");
    expect(sessionStatusLabel("attention")).toBe("needs attention");
  });

  it("describes a process status without claiming a turn result", () => {
    expect(processStatusLabel("running", "process")).toBe("running");
    expect(processStatusLabel("exited", "process")).toBe("process exited");
    expect(processStatusLabel("turn-finished", "event")).toBe("turn finished");
    expect(processStatusLabel("attention", "event")).toBe("needs attention");
  });
});
