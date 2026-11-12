/**
 * Worktree removal: what the native preflight reports, in words, and the one
 * thing `force` can never decide.
 *
 * The native command is the authority. A dirty, unmerged, ignored or
 * unconcluded check is an on-disk blocker the user may force past; a locked
 * worktree and a retained recovery point are not. A checkpoint or pre-restore
 * safety ref belongs to the repository but is *owned* by one worktree through a
 * marker in that worktree's administrative directory, which removal deletes.
 * Keeping the ref then would leave it with no owner to list, restore or clean
 * it, so removal is refused until the caller deletes exactly those refs
 * (`git_checkpoint_cleanup_at`), one explicit action per worktree.
 *
 * Nothing here runs `git worktree prune` or `git gc`, deletes a branch, or
 * reaches into another worktree: the cleanup list is built only from the
 * groups the preflight attributed to this worktree.
 */

import type {
  CheckpointGroups,
  WorktreeRemoveBlocker,
  WorktreeRemoveReport,
} from "@/modules/git/types";

export type RemovalBlockerLine = {
  kind: WorktreeRemoveBlocker;
  text: string;
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function changedText(report: WorktreeRemoveReport): string {
  const parts: string[] = [];
  if (report.dirtyTotal > 0) {
    parts.push(plural(report.dirtyTotal, "changed file", "changed files"));
  }
  if (report.untrackedCount > 0) {
    parts.push(
      plural(report.untrackedCount, "untracked file", "untracked files"),
    );
  }
  return parts.join(" and ");
}

/**
 * One line per native blocker, in the order a reader needs: what the files are,
 * what the commits are, what only the delete would lose, then the two refusals
 * `force` cannot touch.
 */
export function removalBlockers(
  report: WorktreeRemoveReport,
): RemovalBlockerLine[] {
  const lines: RemovalBlockerLine[] = [];
  for (const blocker of report.blockers) {
    switch (blocker) {
      case "dirty": {
        const changed = changedText(report);
        const sample = report.dirtyFiles
          .slice(0, 5)
          .map((file) => file.path)
          .join(", ");
        lines.push({
          kind: blocker,
          text: `${changed} would be deleted${sample ? ` (${sample}${report.dirtyTotal > 5 ? ", …" : ""})` : ""}.`,
        });
        break;
      }
      case "unmerged":
        lines.push({
          kind: blocker,
          text: `${plural(report.unmergedCommits, "commit exists", "commits exist")} only here: ${
            report.branch
              ? `they are not on any other branch, remote or tag besides ${report.branch}.`
              : "the worktree is detached, so no branch names them."
          } The branch is kept; the working files are not.`,
        });
        break;
      case "ignored": {
        const sample = report.ignoredFiles.slice(0, 5).join(", ");
        const rest =
          report.ignoredTotal > report.ignoredFiles.length ? ", …" : "";
        lines.push({
          kind: blocker,
          text: `${plural(report.ignoredTotal, "ignored file a rebuild would not restore", "ignored files a rebuild would not restore")} would be deleted${
            sample ? `: ${sample}${rest}` : ""
          }.`,
        });
        break;
      }
      case "inconclusive":
        lines.push({
          kind: blocker,
          text: `The ${report.inconclusive.join(", ")} check${report.inconclusive.length === 1 ? "" : "s"} could not finish, so what removal would lose is unknown.`,
        });
        break;
      case "locked":
        lines.push({
          kind: blocker,
          text: `This worktree is locked${report.lockReason ? ` (${report.lockReason})` : ""}. Unlock it before removing it; force does not remove a locked worktree.`,
        });
        break;
      case "recoveryRefs": {
        const parts = [
          plural(report.recovery.manual, "checkpoint", "checkpoints"),
          plural(report.recovery.turns, "turn checkpoint", "turn checkpoints"),
          plural(
            report.recovery.safety,
            "restore safety snapshot",
            "restore safety snapshots",
          ),
        ].filter((part) => !part.startsWith("0 "));
        lines.push({
          kind: blocker,
          text: `${plural(report.recovery.total, "recovery point", "recovery points")} still ${report.recovery.total === 1 ? "belongs" : "belong"} to this worktree (${parts.join(", ")}). Delete ${report.recovery.total === 1 ? "it" : "them"} explicitly before removing it; force does not delete or strand ${report.recovery.total === 1 ? "it" : "them"}.`,
        });
        break;
      }
    }
  }
  return lines;
}

/**
 * Whether `force` is a meaningful choice. It never overrides a lock or a
 * retained recovery point; only explicit cleanup removes the latter.
 */
export function canForceRemoval(report: WorktreeRemoveReport): boolean {
  return (
    !report.blockers.includes("locked") &&
    !report.blockers.includes("recoveryRefs")
  );
}

/**
 * The refs an explicit cleanup may delete: every recovery ref the native
 * preflight attributed to *this* worktree, nothing else. An empty listing is an
 * empty selection, never "clean everything".
 */
export function recoveryRefsToDelete(groups: CheckpointGroups): string[] {
  return [
    ...groups.manual.map((checkpoint) => checkpoint.ref),
    ...groups.turns.map((checkpoint) => checkpoint.ref),
    ...groups.safety.map((snapshot) => snapshot.ref),
  ];
}

/** Why a native removal call refused, as the dialog shows it. */
export function removalRefusal(report: WorktreeRemoveReport): string {
  const reasons = removalBlockers(report).map((line) => line.text);
  if (reasons.length === 0) {
    return "The worktree could not be removed. Nothing was deleted.";
  }
  return `Removal was refused. ${reasons.join(" ")} Nothing was deleted.`;
}

/** What a successful removal did and did not touch. */
export function removalResultText(report: WorktreeRemoveReport): string {
  const branch = report.branch
    ? `Branch ${report.branch} and its commits were kept.`
    : "The detached commits were kept; no branch was deleted.";
  return `${report.path} was removed from this repository. ${branch} Only the file access derived from this worktree was revoked. Nothing else on disk was deleted.`;
}

/**
 * Spaces whose terminals have a working directory inside the worktree. Removing
 * it does not close them: they stay as they are, and the caller is told before
 * confirming instead of discovering it afterwards.
 */
export function affectedSpaces(
  activeWork: readonly { spaceName: string; cwd: string }[],
): string[] {
  return [...new Set(activeWork.map((work) => work.spaceName))];
}
