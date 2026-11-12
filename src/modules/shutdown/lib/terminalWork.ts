/**
 * The two id spaces quitting has to cross.
 *
 * A terminal *pane* is identified by a leaf id in the UI; its shell session is
 * identified by a PTY id in the native registry. Both are small integers, so
 * mistaking one for the other looks plausible and then signals a different
 * terminal than the one the survey described (and names the wrong survivor).
 * The app-lab caught exactly that: only the leaves that happened to share a
 * number with a live session were asked to exit.
 */

/**
 * PTY ids for the leaves that have a spawned session. A leaf that has not
 * spawned has nothing to signal: its shell starts after the window closes, if
 * at all.
 */
export function ptyIdsForLeaves(
  leafIds: readonly number[],
  ptyIdForLeaf: (leafId: number) => number | null,
): number[] {
  const ids: number[] = [];
  for (const leafId of leafIds) {
    const ptyId = ptyIdForLeaf(leafId);
    if (ptyId !== null && !ids.includes(ptyId)) ids.push(ptyId);
  }
  return ids;
}

/**
 * Maps the native survivors back to panes for the force prompt. An id that no
 * longer maps to a pane is kept as-is rather than dropped: a survivor must
 * never disappear from the question because a tab was re-laid out mid-quit.
 */
export function leavesForPtyIds(
  ptyIds: readonly number[],
  leafIdForPty: (ptyId: number) => number | null,
): number[] {
  return ptyIds.map((ptyId) => leafIdForPty(ptyId) ?? ptyId);
}
