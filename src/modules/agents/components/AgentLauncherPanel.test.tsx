// @vitest-environment jsdom
import { DEFAULT_AGENT_LAUNCH_COMMANDS } from "@/modules/agents/lib/launcher";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { type SpaceMeta, useSpaces } from "@/modules/spaces";
import { LOCAL_WORKSPACE } from "@/modules/workspace";
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

function makeSpace(
  id: string,
  accountIsolation: SpaceMeta["accountIsolation"],
): SpaceMeta {
  return {
    id,
    name: id,
    root: "/work/project",
    env: LOCAL_WORKSPACE,
    accountIsolation,
    createdAt: 1,
    updatedAt: 1,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  usePreferencesStore.setState({
    hydrated: true,
    agentLaunchCommands: { ...DEFAULT_AGENT_LAUNCH_COMMANDS },
  });
  useSpaces.getState().hydrate([makeSpace("sp-default", "default")], "sp-default");
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

  it("disables agy, codex, gemini, and grok in isolated Spaces with concise unsupported reasons while keeping claude, pi, and opencode enabled", async () => {
    useSpaces
      .getState()
      .hydrate(
        [makeSpace("sp-default", "default"), makeSpace("sp-iso", "isolated")],
        "sp-iso",
      );
    const onLaunch = vi.fn(async () => true);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<AgentLauncherPanel onBack={vi.fn()} onLaunch={onLaunch} />);
    });

    const slotFor = (id: string) =>
      container?.querySelector<HTMLButtonElement>(
        `button[data-agent-slot="${id}"]`,
      ) ?? null;

    for (const id of ["codex", "gemini", "grok", "antigravity"]) {
      const btn = slotFor(id);
      expect(btn, id).not.toBeNull();
      expect(btn?.disabled, id).toBe(true);
      expect(btn?.title, id).toContain("Account isolation is not supported yet");
    }

    for (const id of ["claude", "pi", "opencode"]) {
      const btn = slotFor(id);
      expect(btn, id).not.toBeNull();
      expect(btn?.disabled, id).toBe(false);
    }

    expect(container.textContent).toContain(
      "Account isolation is not supported yet",
    );

    await act(async () => {
      slotFor("opencode")?.click();
      await Promise.resolve();
    });
    const submit = container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit?.click();
      await Promise.resolve();
    });

    expect(onLaunch).toHaveBeenCalledWith({
      agent: "opencode",
      command: "opencode",
      instances: 2,
    });
  });

  it("blocks programmatic form submission when the active Space becomes isolated with an unsupported slot selected", async () => {
    useSpaces
      .getState()
      .hydrate(
        [makeSpace("sp-default", "default"), makeSpace("sp-iso", "isolated")],
        "sp-default",
      );
    const onLaunch = vi.fn(async () => true);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<AgentLauncherPanel onBack={vi.fn()} onLaunch={onLaunch} />);
    });

    const codexBtn = container.querySelector<HTMLButtonElement>(
      'button[data-agent-slot="codex"]',
    );
    expect(codexBtn?.disabled).toBe(false);

    await act(async () => {
      codexBtn?.click();
      await Promise.resolve();
    });

    await act(async () => {
      useSpaces.setState({ activeId: "sp-iso" });
      await Promise.resolve();
    });

    const submit = container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    expect(submit?.disabled).toBe(true);

    const form = container.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(onLaunch).not.toHaveBeenCalled();
    const errorEl = container.querySelector("[data-agent-launch-error]");
    expect(errorEl?.textContent).toContain(
      "Account isolation is not supported yet",
    );
  });
});
