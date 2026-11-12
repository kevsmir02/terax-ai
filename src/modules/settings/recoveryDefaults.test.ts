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

describe("recovery draft defaults", () => {
  beforeEach(() => {
    entries.value = [];
    vi.resetModules();
  });

  it("is opt-in: off for a user who never chose", async () => {
    const { DEFAULT_PREFERENCES, loadPreferences } = await import("./store");
    expect(DEFAULT_PREFERENCES.editorRecoveryDrafts).toBe(false);
    expect((await loadPreferences()).editorRecoveryDrafts).toBe(false);
  });

  it("never overrides an explicit stored choice", async () => {
    entries.value = [["editorRecoveryDrafts", true]];
    const { loadPreferences } = await import("./store");
    expect((await loadPreferences()).editorRecoveryDrafts).toBe(true);
  });

  it("is not the same switch as auto save of the original file", async () => {
    // Recovery is a separate opt-in from autosave: enabling one must not mean
    // the other, or "autosave off" would silently start writing drafts.
    entries.value = [["editorRecoveryDrafts", true]];
    const { loadPreferences } = await import("./store");
    const prefs = await loadPreferences();
    expect(prefs.editorRecoveryDrafts).toBe(true);
    expect(prefs.editorAutoSave).toBe(false);
  });
});
