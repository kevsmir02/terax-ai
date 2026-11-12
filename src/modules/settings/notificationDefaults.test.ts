import { beforeEach, describe, expect, it, vi } from "vitest";

// `store` is created at module load, so the plugin mock must be in place
// before `./store` is imported.
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

describe("agent notification defaults", () => {
  beforeEach(() => {
    entries.value = [];
    vi.resetModules();
  });

  it("notifies by default, silently", async () => {
    const { DEFAULT_PREFERENCES } = await import("./store");
    expect(DEFAULT_PREFERENCES.agentNotifications).toBe(true);
    // Background agents must never make noise unless the user opts in.
    expect(DEFAULT_PREFERENCES.agentNotificationSound).toBe(false);
  });

  it("applies to users who never stored a choice", async () => {
    const { loadPreferences } = await import("./store");
    expect((await loadPreferences()).agentNotificationSound).toBe(false);
  });

  it("never overrides an explicit stored choice", async () => {
    entries.value = [["agentNotificationSound", true]];
    const { loadPreferences } = await import("./store");
    expect((await loadPreferences()).agentNotificationSound).toBe(true);
  });
});
