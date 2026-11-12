import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentHooksStatus,
  applyAgentHooksPlan,
  type HookActivation,
  type HooksPlan,
  type HooksStatus,
  planAgentHooks,
} from "./hooksConfig";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

const activation: HookActivation = {
  restartRequired: true,
  trustRequired: true,
  summary: "Restart the agent before it reads the file.",
  steps: ["Restart the session."],
  verified: false,
};

const plan: HooksPlan = {
  agent: "codex",
  action: "install",
  path: "/home/me/.codex/hooks.json",
  before: null,
  after: "{}\n",
  revision: "absent",
  changed: true,
  foreignGroups: 0,
  activation,
};

const status: HooksStatus = {
  agent: "codex",
  path: "/home/me/.codex/hooks.json",
  support: "supported",
  configState: "not-installed",
  installed: false,
  revision: "absent",
  foreignGroups: 0,
  activation,
  note: null,
};

beforeEach(() => {
  native.invoke.mockReset();
  native.invoke.mockResolvedValue(undefined);
});

describe("hooks configuration commands", () => {
  it("previews with the plan command", async () => {
    native.invoke.mockResolvedValueOnce(plan);
    await expect(planAgentHooks("codex", "install")).resolves.toEqual(plan);
    expect(native.invoke).toHaveBeenCalledWith("agent_hooks_plan", {
      agent: "codex",
      action: "install",
    });
  });

  it("applies against the reviewed revision, never the whole file", async () => {
    await applyAgentHooksPlan(plan);
    expect(native.invoke).toHaveBeenCalledWith("agent_hooks_apply", {
      agent: "codex",
      action: "install",
      revision: "absent",
    });
  });

  it("reports the configuration state of one agent", async () => {
    native.invoke.mockResolvedValueOnce(status);
    await expect(agentHooksStatus("codex")).resolves.toEqual(status);
    expect(native.invoke).toHaveBeenCalledWith("agent_hooks_status", {
      agent: "codex",
    });
  });
});
