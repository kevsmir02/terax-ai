import type { HooksAction, HooksApply, HooksPlan } from "./hooksConfig";

/**
 * The review an install/removal goes through: nothing is written until the
 * user confirms the exact plan they were shown, and a plan computed from
 * stale file contents is refused instead of applied.
 */
export type HooksReviewPhase =
  | "idle"
  | "reviewing"
  | "applying"
  | "configured"
  | "stale"
  | "failed";

export type HooksReviewState = {
  phase: HooksReviewPhase;
  plan: HooksPlan | null;
  result: HooksApply | null;
  error: string | null;
};

export type HooksReviewEvent =
  | { type: "review"; plan: HooksPlan }
  | { type: "cancel" }
  | { type: "applying" }
  | { type: "applied"; result: HooksApply }
  | { type: "failed"; error: string };

export const emptyHooksReview: HooksReviewState = {
  phase: "idle",
  plan: null,
  result: null,
  error: null,
};

export function hooksReviewReducer(
  state: HooksReviewState,
  event: HooksReviewEvent,
): HooksReviewState {
  switch (event.type) {
    case "review":
      return {
        phase: "reviewing",
        plan: event.plan,
        result: null,
        error: null,
      };
    case "cancel":
      return emptyHooksReview;
    case "applying":
      return state.plan ? { ...state, phase: "applying", error: null } : state;
    case "applied":
      return {
        ...state,
        phase: event.result.outcome === "stale" ? "stale" : "configured",
        result: event.result,
        error: null,
      };
    case "failed":
      return { ...state, phase: "failed", error: event.error };
  }
}

/** Only a reviewed plan that has something to write can be confirmed. */
export function confirmable(state: HooksReviewState): boolean {
  return (
    state.phase === "reviewing" && state.plan !== null && state.plan.changed
  );
}

export type HooksReviewSummary = {
  path: string;
  actionLabel: string;
  confirmLabel: string;
  changeLabel: string;
  before: string;
  after: string;
  notes: string[];
  activation: string[];
  /** The only state a written file proves. Never "active". */
  readyLabel: string;
};

const ACTION_LABEL: Record<HooksAction, string> = {
  install: "Install hooks",
  uninstall: "Remove hooks",
};

function readyLabel(plan: HooksPlan): string {
  if (plan.activation.trustRequired) return "Configured — trust required";
  if (plan.activation.restartRequired) return "Configured — restart required";
  return "Configured";
}

/** Everything the review shows about one plan; purely derived from the plan. */
export function hooksReviewSummary(plan: HooksPlan): HooksReviewSummary {
  const notes: string[] = [];
  if (plan.foreignGroups > 0) {
    notes.push(
      `${plan.foreignGroups} hook group${
        plan.foreignGroups === 1 ? "" : "s"
      } from other tools or upstream Terax stay untouched.`,
    );
  }
  notes.push(
    plan.action === "install"
      ? "Only entries that call this fork's CLI are added; every other byte of the file is kept."
      : "Only entries that call this fork's CLI are removed; upstream and user entries stay byte for byte.",
  );

  const activation = [
    plan.activation.summary,
    ...plan.activation.steps,
    ...(plan.activation.verified
      ? []
      : [
          `Not yet verified against a real installed ${plan.agent} CLI: writing the file is configured, not active.`,
        ]),
  ];

  return {
    path: plan.path,
    actionLabel: ACTION_LABEL[plan.action],
    confirmLabel:
      plan.action === "install" ? "Install these hooks" : "Remove these hooks",
    changeLabel: plan.changed
      ? "Review the exact change below before confirming."
      : "Already configured — nothing would change.",
    before: plan.before ?? "(file does not exist yet — it will be created)",
    after: plan.after ?? "(file will be removed)",
    notes,
    activation,
    readyLabel: readyLabel(plan),
  };
}
