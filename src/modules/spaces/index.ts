export {
  classifyCrossSpaceTabMove,
  duplicateSpaceMeta,
  duplicateSpaceOrganization,
  duplicateSpaceState,
  evaluateIsolationToggleGuard,
  type CrossSpaceTabMoveDecision,
  type IsolationToggleEvaluation,
  type IsolationToggleGuard,
} from "./lib/isolation";
export { preflightAgentLaunch } from "./lib/isolationSync";
export type {
  AccountIsolationMode,
  SpaceMeta,
  SpaceRuntimeStatus,
} from "./lib/store";
export { useSpacePersistence } from "./lib/useSpacePersistence";
export { useSpaces } from "./lib/useSpaces";
export { useSpacesBoot } from "./lib/useSpacesBoot";
export { SpaceSwitcher } from "./SpaceSwitcher";
