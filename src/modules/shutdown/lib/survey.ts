/**
 * What quitting would cost, summarised across every Space.
 *
 * The survey is deliberately a *snapshot of evidence*, not of intent: it takes
 * the dirty buffers the caller resolved (an editor handle can be newer than the
 * tab's last published flag), the process probes (including the ones that could
 * not be answered), and the recovery drafts whose newest text is not durable.
 * Nothing here decides to quit; `gate.ts` owns that and never lets a repeated
 * close request stand in for an answer.
 */

import type { QuitDraft } from "./flush";

export type QuitSpaceRef = { id: string; name: string };

export type DirtyBuffer = {
  spaceId: string;
  tabId: number;
  title: string;
};

export type ProcessState = "running" | "uncertain";

export type ProcessHazard = {
  spaceId: string;
  leafId: number;
  state: ProcessState;
};

/** A draft whose newest text would be lost: same shape as the flush report. */
export type DraftHazard = QuitDraft;

export type QuitSurveyInput = {
  spaces: readonly QuitSpaceRef[];
  buffers: readonly DirtyBuffer[];
  processes: readonly ProcessHazard[];
  drafts: readonly DraftHazard[];
};

export type QuitSpaceSurvey = QuitSpaceRef & {
  buffers: DirtyBuffer[];
  processes: ProcessHazard[];
  drafts: DraftHazard[];
};

export type QuitSurveyTotals = {
  buffers: number;
  processes: number;
  uncertainProcesses: number;
  drafts: number;
};

export type QuitSurvey = {
  /** Only Spaces with something at stake, in the application's Space order. */
  spaces: QuitSpaceSurvey[];
  totals: QuitSurveyTotals;
};

/** The identities a user's "quit anyway" covered, for a re-check. */
export type QuitHazardIds = {
  buffers: number[];
  processes: number[];
};

function bySpace<T extends { spaceId: string }>(
  items: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const list = grouped.get(item.spaceId);
    if (list) list.push(item);
    else grouped.set(item.spaceId, [item]);
  }
  return grouped;
}

export function surveyQuit(input: QuitSurveyInput): QuitSurvey {
  const buffers = bySpace(input.buffers);
  const processes = bySpace(input.processes);
  const drafts = bySpace(input.drafts);

  const spaces: QuitSpaceSurvey[] = [];
  for (const space of input.spaces) {
    const spaceBuffers = buffers.get(space.id) ?? [];
    const spaceProcesses = processes.get(space.id) ?? [];
    const spaceDrafts = drafts.get(space.id) ?? [];
    if (
      spaceBuffers.length === 0 &&
      spaceProcesses.length === 0 &&
      spaceDrafts.length === 0
    ) {
      continue;
    }
    spaces.push({
      id: space.id,
      name: space.name,
      buffers: spaceBuffers,
      processes: spaceProcesses,
      drafts: spaceDrafts,
    });
  }

  return {
    spaces,
    totals: {
      buffers: input.buffers.length,
      processes: input.processes.length,
      uncertainProcesses: input.processes.filter(
        (process) => process.state === "uncertain",
      ).length,
      drafts: input.drafts.length,
    },
  };
}

export function quitNeedsResolution(survey: QuitSurvey): boolean {
  const { buffers, processes, drafts } = survey.totals;
  return buffers + processes + drafts > 0;
}

/**
 * The "don't ask again about running processes" opt-out only covers running
 * processes, so it stays hidden whenever the same prompt is also the last
 * warning before discarding unsaved text or unflushed drafts.
 */
export function canOptOutOfQuitPrompt(survey: QuitSurvey): boolean {
  return (
    survey.totals.processes > 0 &&
    survey.totals.buffers === 0 &&
    survey.totals.drafts === 0
  );
}

export function quitHazardIds(survey: QuitSurvey): QuitHazardIds {
  const buffers = new Set<number>();
  const processes = new Set<number>();
  for (const space of survey.spaces) {
    for (const buffer of space.buffers) buffers.add(buffer.tabId);
    for (const process of space.processes) processes.add(process.leafId);
  }
  return { buffers: [...buffers], processes: [...processes] };
}

/**
 * Whether work appeared after the user answered the question. A vanished
 * hazard is not a new one: the confirmation still covers what is left.
 */
export function hasNewQuitHazards(
  acknowledged: QuitHazardIds,
  survey: QuitSurvey,
): boolean {
  const buffers = new Set(acknowledged.buffers);
  const processes = new Set(acknowledged.processes);
  for (const space of survey.spaces) {
    if (space.buffers.some((buffer) => !buffers.has(buffer.tabId))) return true;
    if (space.processes.some((process) => !processes.has(process.leafId))) {
      return true;
    }
  }
  return false;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function draftSentence(draft: DraftHazard): string {
  switch (draft.state) {
    case "failed":
      return "a recovery draft could not be saved";
    case "unsettled":
      return "a recovery draft did not finish saving";
    case "paused":
      return "a recovery draft is paused because recovery storage is full";
    case "unavailable":
      return "a recovery draft cannot be written because recovery storage is unavailable";
    default:
      return "a recovery draft has not been saved yet";
  }
}

/**
 * The sentence the dialog shows. It states what is at stake and, just as
 * importantly, what quitting cannot reach: services the user detached from the
 * terminal and anything about the next launch.
 */
export function describeQuit(survey: QuitSurvey): string {
  const lines: string[] = [];
  for (const space of survey.spaces) {
    const parts: string[] = [];
    if (space.buffers.length > 0) {
      parts.push(
        `${space.buffers.length} ${plural(space.buffers.length, "file", "files")} with unsaved changes`,
      );
    }
    const running = space.processes.filter(
      (process) => process.state === "running",
    ).length;
    if (running > 0) {
      parts.push(
        `${running} running ${plural(running, "process", "processes")}`,
      );
    }
    const uncertain = space.processes.length - running;
    if (uncertain > 0) {
      parts.push(
        `${uncertain} ${plural(uncertain, "process", "processes")} that could not be checked (the terminal did not report its state, so treat ${plural(uncertain, "it", "them")} as running)`,
      );
    }
    if (space.drafts.length > 0) {
      parts.push(
        `${space.drafts.length} ${plural(space.drafts.length, "recovery draft", "recovery drafts")} that ${plural(space.drafts.length, "is", "are")} not saved (${list(space.drafts.map(draftSentence))})`,
      );
    }
    lines.push(`${space.name}: ${list(parts)}.`);
  }

  lines.push(
    "Quitting terminates the processes Terax started in these terminals. Processes you detached from a terminal, or started outside Terax entirely, keep running: Terax cannot confirm their state and does not manage them.",
  );
  lines.push(
    "Reopening restores Spaces, tabs and file locations only; it does not restart these processes or replay commands.",
  );
  return lines.join(" ");
}
