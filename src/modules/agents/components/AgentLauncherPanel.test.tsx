// @vitest-environment jsdom
import { DEFAULT_AGENT_LAUNCH_COMMANDS } from "@/modules/agents/lib/launcher";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLauncherPanel } from "./AgentLauncherPanel";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/modules/settings/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/modules/settings/store")>();
  return {
    ...actual,
    loadPreferences: vi.fn(async () => ({})),
    onPreferencesChange: vi.fn(() => () => {}),
    setAgentLaunchCommands: vi.fn(async () => {}),
  };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  usePreferencesStore.setState({
    hydrated: true,
    agentLaunchCommands: { ...DEFAULT_AGENT_LAUNCH_COMMANDS },
  });
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

describe("AgentLauncherPanel", () => {
  it("surfaces fail-closed Rust preflight rejection without clearing the launcher", async () => {
    const onLaunch = vi.fn(async () => {
      throw new Error(
        "Installed Claude CLI did not honor CLAUDE_CONFIG_DIR; update Claude Code before launching isolated Spaces.",
      );
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<AgentLauncherPanel onBack={vi.fn()} onLaunch={onLaunch} />);
    });

    const submit = container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    expect(submit).not.toBeNull();

    await act(async () => {
      submit?.click();
      await Promise.resolve();
    });

    expect(onLaunch).toHaveBeenCalledTimes(1);
    const errorEl = container.querySelector("[data-agent-launch-error]");
    expect(errorEl?.textContent).toContain("CLAUDE_CONFIG_DIR");
  });
});
