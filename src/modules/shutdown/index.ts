export {
  flushBlocksQuit,
  flushRecovery,
  QUIT_FLUSH_TIMEOUT_MS,
  quitDraftsFromStatuses,
  type QuitDraft,
  type QuitDraftState,
  type QuitFlushReport,
} from "./lib/flush";
export {
  initialQuitState,
  QUIT_TERMINATE_GRACE_MS,
  reduceQuit,
  type QuitEffect,
  type QuitEvent,
  type QuitNote,
  type QuitPhase,
  type QuitState,
  type QuitTransition,
} from "./lib/gate";
export {
  canOptOutOfQuitPrompt,
  describeDiscard,
  describeQuit,
  hasNewQuitHazards,
  quitHazardIds,
  quitNeedsResolution,
  surveyQuit,
  type DirtyBuffer,
  type DraftHazard,
  type ProcessHazard,
  type ProcessState,
  type QuitHazardIds,
  type QuitSpaceRef,
  type QuitSpaceSurvey,
  type QuitSurvey,
  type QuitSurveyInput,
  type QuitSurveyTotals,
} from "./lib/survey";
export {
  forceCloseTerminals,
  terminateAppOwnedWork,
  type TerminateReport,
} from "./native";
