import { describe, expect, it } from "vitest";
import { leavesForPtyIds, ptyIdsForLeaves } from "./terminalWork";

describe("terminal id spaces", () => {
  // Panes have leaf ids; native sessions have PTY ids. They are small integers
  // in both spaces, so confusing them usually looks plausible and terminates
  // (or names) the wrong terminal — this was a real defect found in the app-lab.
  const ptyIdForLeaf = (leafId: number) =>
    ({ 4: 11, 5: 12, 9: 13 })[leafId] ?? null;
  const leafIdForPty = (ptyId: number) =>
    ({ 11: 4, 12: 5, 13: 9 })[ptyId] ?? null;

  it("asks native about PTY sessions, not leaves", () => {
    expect(ptyIdsForLeaves([4, 5, 9], ptyIdForLeaf)).toEqual([11, 12, 13]);
  });

  it("skips leaves whose session has not spawned yet", () => {
    expect(ptyIdsForLeaves([4, 77], ptyIdForLeaf)).toEqual([11]);
  });

  it("asks each session once when two leaves resolve to one terminal", () => {
    expect(ptyIdsForLeaves([4, 4], ptyIdForLeaf)).toEqual([11]);
  });

  it("names survivors by pane, so the prompt lists the right terminal", () => {
    expect(leavesForPtyIds([12], leafIdForPty)).toEqual([5]);
  });

  it("never drops a survivor that no longer maps to a pane", () => {
    // A terminal whose tab was re-laid out mid-quit must still be reported;
    // silently omitting it would hide work from the force prompt.
    expect(leavesForPtyIds([12, 99], leafIdForPty)).toEqual([5, 99]);
  });
});
