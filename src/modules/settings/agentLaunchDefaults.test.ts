import { beforeEach, describe, expect, it, vi } from "vitest";

const entries = vi.hoisted(() => ({ value: [] as [string, unknown][] }));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    entries = async () => entries.value;
    get = async () => undefined;
    set = async () => undefined;
    save = async () => undefined;
  },
  Store: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: async () => undefined,
  listen: async () => () => undefined,
}));

describe("agent launch command preferences", () => {
  beforeEach(() => {
    entries.value = [];
    vi.resetModules();
  });

  it("defaults Antigravity CLI to agy", async () => {
    const { DEFAULT_PREFERENCES, loadPreferences } = await import("./store");
    expect(DEFAULT_PREFERENCES.agentLaunchCommands.antigravity).toBe("agy");
    expect((await loadPreferences()).agentLaunchCommands.antigravity).toBe(
      "agy",
    );
  });

  it("normalizes a stored desktop antigravity command back to agy", async () => {
    entries.value = [
      [
        "agentLaunchCommands",
        {
          claude: "cc",
          antigravity: "antigravity",
        },
      ],
    ];
    const { loadPreferences } = await import("./store");
    const prefs = await loadPreferences();
    expect(prefs.agentLaunchCommands.antigravity).toBe("agy");
    expect(prefs.agentLaunchCommands.claude).toBe("cc");
  });

  it("preserves a custom Antigravity CLI command", async () => {
    entries.value = [
      [
        "agentLaunchCommands",
        {
          antigravity: "agy --model gemini",
        },
      ],
    ];
    const { loadPreferences } = await import("./store");
    expect((await loadPreferences()).agentLaunchCommands.antigravity).toBe(
      "agy --model gemini",
    );
  });
});
