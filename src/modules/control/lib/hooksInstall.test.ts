import { describe, expect, it } from "vitest";
import type { HookActivation, HooksApply, HooksPlan } from "./hooksConfig";
import {
  confirmable,
  emptyHooksReview,
  hooksReviewReducer,
  hooksReviewSummary,
  type HooksReviewState,
} from "./hooksInstall";

const activation: HookActivation = {
  restartRequired: true,
  trustRequired: true,
  summary:
    "The file is configured; Claude Code still has to load and trust it.",
  steps: ["Restart the session.", "Approve the group that calls the fork CLI."],
  verified: false,
};

const plan = (overrides: Partial<HooksPlan> = {}): HooksPlan => ({
  agent: "claude",
  action: "install",
  path: "/home/me/.claude/settings.json",
  before: '{\n  "model": "opus"\n}\n',
  after:
    '{\n  "model": "opus",\n  "hooks": { "Stop": [ { "hooks": [ { "command": "[ -n \\"$CODR_CLI\\" ]" } ] } ] }\n}\n',
  revision: "42:00000000deadbeef",
  changed: true,
  foreignGroups: 2,
  activation,
  ...overrides,
});

const applied = (outcome: HooksApply["outcome"]): HooksApply => ({
  outcome,
  revision: outcome === "stale" ? "43:1111111122222222" : "42:00000000deadbeef",
  status: {
    agent: "claude",
    path: "/home/me/.claude/settings.json",
    support: "supported",
    configState: outcome === "stale" ? "not-installed" : "installed",
    installed: outcome !== "stale",
    revision: "42:00000000deadbeef",
    foreignGroups: 2,
    activation,
    note: null,
  },
});

function reviewed(value: HooksPlan): HooksReviewState {
  return hooksReviewReducer(emptyHooksReview, { type: "review", plan: value });
}

describe("agent hook review state machine", () => {
  it("starts idle with nothing to confirm", () => {
    expect(emptyHooksReview.phase).toBe("idle");
    expect(emptyHooksReview.plan).toBeNull();
    expect(confirmable(emptyHooksReview)).toBe(false);
  });

  it("reviews a plan without writing anything", () => {
    const state = reviewed(plan());
    expect(state.phase).toBe("reviewing");
    expect(state.plan).toEqual(plan());
    expect(state.result).toBeNull();
    expect(confirmable(state)).toBe(true);
  });

  it("never confirms a plan that has no changes to write", () => {
    const state = reviewed(
      plan({ changed: false, before: "same", after: "same" }),
    );
    expect(state.phase).toBe("reviewing");
    expect(confirmable(state)).toBe(false);
  });

  it("records an applied plan as configured and keeps the result", () => {
    const state = hooksReviewReducer(
      hooksReviewReducer(reviewed(plan()), { type: "applying" }),
      { type: "applied", result: applied("applied") },
    );
    expect(state.phase).toBe("configured");
    expect(state.result?.outcome).toBe("applied");
    expect(state.result?.status.installed).toBe(true);
    expect(confirmable(state)).toBe(false);
  });

  it("treats an unchanged apply as configured rather than a new write", () => {
    const state = hooksReviewReducer(reviewed(plan()), {
      type: "applied",
      result: applied("unchanged"),
    });
    expect(state.phase).toBe("configured");
    expect(state.result?.outcome).toBe("unchanged");
  });

  it("refuses a stale apply and demands a fresh review", () => {
    const state = hooksReviewReducer(reviewed(plan()), {
      type: "applied",
      result: applied("stale"),
    });
    expect(state.phase).toBe("stale");
    expect(state.result?.outcome).toBe("stale");
    expect(confirmable(state)).toBe(false);

    // Only a newly computed preview returns to a confirmable state.
    const fresh = plan({ revision: "43:1111111122222222" });
    const again = hooksReviewReducer(state, { type: "review", plan: fresh });
    expect(again.phase).toBe("reviewing");
    expect(again.plan?.revision).toBe("43:1111111122222222");
    expect(confirmable(again)).toBe(true);
  });

  it("keeps a failure visible and cannot confirm it", () => {
    const state = hooksReviewReducer(reviewed(plan()), {
      type: "failed",
      error: "/home/me/.claude/settings.json is not valid JSON",
    });
    expect(state.phase).toBe("failed");
    expect(state.error).toContain("not valid JSON");
    expect(confirmable(state)).toBe(false);
  });

  it("dismisses back to idle", () => {
    const state = hooksReviewReducer(reviewed(plan()), { type: "cancel" });
    expect(state).toEqual(emptyHooksReview);
  });
});

describe("agent hook review summary", () => {
  it("shows the exact before and after text", () => {
    const summary = hooksReviewSummary(plan());
    expect(summary.path).toBe("/home/me/.claude/settings.json");
    expect(summary.before).toBe(plan().before);
    expect(summary.after).toBe(plan().after);
    expect(summary.actionLabel).toBe("Install hooks");
    expect(summary.confirmLabel).toBe("Install these hooks");
  });

  it("labels a removal and an unchanged file", () => {
    expect(
      hooksReviewSummary(plan({ action: "uninstall", after: null }))
        .actionLabel,
    ).toBe("Remove hooks");
    expect(
      hooksReviewSummary(plan({ changed: false, after: plan().before }))
        .changeLabel,
    ).toMatch(/already/i);
  });

  it("states that a missing file will be created and a removed file deleted", () => {
    const create = hooksReviewSummary(plan({ before: null }));
    expect(create.before).toContain("does not exist");
    const remove = hooksReviewSummary(
      plan({ action: "uninstall", after: null }),
    );
    expect(remove.after).toContain("removed");
  });

  it("reports foreign hook groups that stay untouched", () => {
    expect(hooksReviewSummary(plan()).notes.join(" ")).toContain(
      "2 hook groups",
    );
    expect(
      hooksReviewSummary(plan({ foreignGroups: 0 })).notes.join(" "),
    ).not.toContain("hook groups");
  });

  it("explains the activation and trust requirements honestly", () => {
    const summary = hooksReviewSummary(plan());
    expect(summary.activation.join(" ")).toContain("Restart the session.");
    expect(summary.activation.join(" ")).toContain(
      "Approve the group that calls the fork CLI.",
    );
    expect(summary.activation.join(" ")).toMatch(/not .*verified/i);
    expect(summary.readyLabel).not.toMatch(/^active$/i);
    expect(summary.readyLabel).toBe("Configured — trust required");
  });

  it("does not claim trust is required where it is not", () => {
    const summary = hooksReviewSummary(
      plan({
        activation: { ...activation, trustRequired: false },
      }),
    );
    expect(summary.readyLabel).toBe("Configured — restart required");
    const none = hooksReviewSummary(
      plan({
        activation: {
          ...activation,
          trustRequired: false,
          restartRequired: false,
        },
      }),
    );
    expect(none.readyLabel).toBe("Configured");
  });
});
