import { describe, expect, it } from "vitest";
import { agentNotificationContent } from "./notificationContent";

describe("agentNotificationContent", () => {
  it("names the agent and the kind of attention", () => {
    expect(
      agentNotificationContent({
        agent: "claude",
        kind: "attention",
        spaceName: "api",
      }),
    ).toEqual({ title: "Claude Code needs attention", body: "Space: api" });
  });

  it("calls a finished turn a turn, not a completed agent", () => {
    expect(
      agentNotificationContent({
        agent: "codex",
        kind: "turn-finished",
        spaceName: "api",
      }),
    ).toEqual({ title: "Codex turn finished", body: "Space: api" });
  });

  it("labels a failed run without quoting the failure", () => {
    expect(
      agentNotificationContent({
        agent: "opencode",
        kind: "error",
        spaceName: "api",
      }),
    ).toEqual({ title: "OpenCode run failed", body: "Space: api" });
  });

  it("keeps the Antigravity CLI distinct from its desktop app", () => {
    expect(
      agentNotificationContent({
        agent: "antigravity",
        kind: "attention",
        spaceName: "api",
      }).title,
    ).toBe("Antigravity CLI needs attention");
  });

  it("keeps unknown Space identity generic instead of guessing", () => {
    expect(
      agentNotificationContent({ agent: "pi", kind: "attention" }),
    ).toEqual({ title: "Pi needs attention", body: "Workspace" });
    expect(
      agentNotificationContent({
        agent: "pi",
        kind: "attention",
        spaceName: "   ",
      }).body,
    ).toBe("Workspace");
  });

  it("trims the Space name into one line", () => {
    expect(
      agentNotificationContent({
        agent: "gemini",
        kind: "attention",
        spaceName: "  api\nwork  ",
      }).body,
    ).toBe("Space: api work");
  });
});
