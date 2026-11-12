/**
 * Manual-checkpoint restore copy and grouping.
 *
 * The native preflight is the authority on what a restore changes; this module
 * turns its result into the words the panel shows, so a partial failure or a
 * safety-ref recovery can never be mistaken for a complete Git-state undo.
 */

import type {
  CheckpointCapture,
  CheckpointGroups,
  ManualRestorePreview,
  ManualRestoreReport,
  RestorePath,
} from "./types";

export type RestorableCheckpoint =
  | {
      kind: "manual";
      ref: string;
      id: string;
      name: string | null;
      createdAtSecs: number;
      capture: CheckpointCapture | null;
    }
  | {
      kind: "safety";
      ref: string;
      taskId: string;
      createdAtSecs: number;
      capture: null;
    };

/**
 * What the panel may restore: manual checkpoints and the safety refs a restore
 * produced. Retained per-turn checkpoints keep their own restore path.
 */
export function restorableRecoveryRefs(
  groups: CheckpointGroups,
): RestorableCheckpoint[] {
  return [
    ...groups.manual.map(
      (checkpoint): RestorableCheckpoint => ({
        kind: "manual",
        ref: checkpoint.ref,
        id: checkpoint.id,
        name: checkpoint.name,
        createdAtSecs: checkpoint.createdAtSecs,
        capture: checkpoint.capture,
      }),
    ),
    ...groups.safety.map(
      (snapshot): RestorableCheckpoint => ({
        kind: "safety",
        ref: snapshot.ref,
        taskId: snapshot.taskId,
        createdAtSecs: snapshot.createdAtSecs,
        capture: null,
      }),
    ),
  ];
}

/** `null` when the preview may open a confirmation. */
export function restorePrecondition(
  preview: ManualRestorePreview,
): string | null {
  if (preview.refusal === null) return null;
  const detail = preview.refusalDetail ? ` ${preview.refusalDetail}` : "";
  switch (preview.refusal) {
    case "stagedAffectedPaths":
      return `Affected paths with staged changes must be resolved first: staging is not part of a safety capture.${detail}`;
    case "stalePreview":
      return `The working tree changed after this preview; review a fresh preview before retrying.${detail}`;
    case "unsupportedCheckpointKind":
      return `Per-turn checkpoints use the retained restore path.${detail}`;
  }
}

export function formatRestoreEffect(path: RestorePath): string {
  return path.effect === "removed" ? "removed" : "restored";
}

function fileCount(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function subjectOf(report: ManualRestoreReport): string {
  return report.affected.length === 1
    ? `"${report.affected[0]?.path ?? "file"}"`
    : fileCount(report.affectedTotal);
}

/**
 * The panel's result line. A refusal changed nothing; a partial failure keeps
 * the safety ref and demands a fresh preview; a safety-ref target recovers
 * content only.
 */
export function manualRestoreMessage(report: ManualRestoreReport): string {
  if (report.refusal !== null) {
    const detail = report.refusalDetail ? ` ${report.refusalDetail}` : "";
    return `Nothing was changed.${detail}`;
  }
  if (report.partial) {
    const writes =
      report.failureStage === "writes"
        ? "write effects are not known exactly"
        : `${report.written} written`;
    const parts = [
      `The restore partially completed: ${report.removed} removed, ${writes}.`,
    ];
    if (report.failure) parts.push(`${report.failure}.`);
    if (report.safety) {
      parts.push(
        `The safety ref ${report.safety.ref} keeps the pre-restore content.`,
      );
    }
    parts.push(
      report.retryRequiresFreshPreview
        ? "Review a fresh preview before retrying; the previous plan no longer describes the working tree."
        : "Review the partial effects before retrying.",
    );
    return parts.join(" ");
  }
  if (!report.restored) {
    return "The restore did not run; nothing is claimed to have changed.";
  }
  const safety = report.safety
    ? ` The safety ref ${report.safety.ref} keeps the pre-restore content.`
    : "";
  if (report.contentOnly) {
    return `The ${subjectOf(report)} content was recovered from the safety ref.${safety} HEAD is unchanged and staging is not restored: this is content recovery, not a Git-state undo.`;
  }
  return `Restored ${subjectOf(report)}. HEAD is unchanged; the index entries of touched paths were reset to HEAD.${safety} Captured content is recovered, not a Git-state undo.`;
}
