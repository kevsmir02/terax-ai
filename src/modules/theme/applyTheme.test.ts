import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme, ThemeVariant } from "./types";

function hexLuminance(hex: string): number {
  const clean = hex.trim().replace(/^#/, "");
  const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
  const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
  const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const removed: string[] = [];
const written = new Map<string, string>();

function stubDocument() {
  const root = {
    style: {
      removeProperty: vi.fn((v: string) => {
        removed.push(v);
        written.delete(v);
      }),
      setProperty: vi.fn((k: string, v: string) => {
        written.set(k, v);
      }),
    },
  };
  vi.stubGlobal("document", { documentElement: root });
}

function variant(partial: Partial<ThemeVariant>): ThemeVariant {
  return partial;
}

function theme(variants: Theme["variants"], id = "test-theme"): Theme {
  return { id, name: "Test", author: "", description: "", variants };
}

async function loadModule() {
  return await import("./applyTheme");
}

describe("theme application", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    removed.length = 0;
    written.clear();
    stubDocument();
  });

  it("writes color and terminal variables for the requested mode", async () => {
    const { applyTheme } = await loadModule();

    applyTheme(
      theme({
        dark: variant({
          colors: {
            background: "#111111",
            cardForeground: "#eeeeee",
            radius: "8px",
          },
          terminal: {
            background: "#000000",
            cursor: "#ffffff",
            ansi: [
              "#010101",
              "#020202",
              "#030303",
              "#040404",
              "#050505",
              "#060606",
              "#070707",
              "#080808",
              "#090909",
              "#0a0a0a",
              "#0b0b0b",
              "#0c0c0c",
              "#0d0d0d",
              "#0e0e0e",
              "#0f0f0f",
              "#101010",
            ],
          },
        }),
      }),
      "dark",
    );

    expect(written.get("--background")).toBe("#111111");
    expect(written.get("--card-foreground")).toBe("#eeeeee");
    expect(written.get("--radius")).toBe("8px");
    expect(written.get("--terminal-background")).toBe("#000000");
    expect(written.get("--terminal-cursor")).toBe("#ffffff");
    expect(written.get("--terminal-ansi-black")).toBe("#010101");
    expect(written.get("--terminal-ansi-red")).toBe("#020202");
    expect(written.get("--terminal-ansi-bright-white")).toBe("#101010");
  });

  it("falls back to dark then light when the mode is missing", async () => {
    const { applyTheme } = await loadModule();
    const onlyLight = theme({
      light: variant({ colors: { background: "#fafafa" } }),
    });

    applyTheme(onlyLight, "dark");

    expect(written.get("--background")).toBe("#fafafa");
  });

  it("clears every variable before writing so stale keys never linger", async () => {
    const { applyTheme } = await loadModule();

    applyTheme(
      theme({
        dark: variant({
          colors: { primary: "#123456" },
          terminal: { cursor: "#abcdef" },
        }),
      }),
      "dark",
    );
    removed.length = 0;

    applyTheme(
      theme({ dark: variant({ colors: { accent: "#654321" } }) }),
      "dark",
    );

    const removedSet = new Set(removed);
    expect(removedSet.has("--primary")).toBe(true);
    expect(removedSet.has("--terminal-cursor")).toBe(true);
    expect(written.has("--primary")).toBe(false);
    expect(written.get("--accent")).toBe("#654321");
  });

  it("clears the surface when a theme has no usable variant", async () => {
    const { applyTheme, clearTheme } = await loadModule();
    applyTheme(
      theme({ dark: variant({ colors: { primary: "#123456" } }) }),
      "dark",
    );
    expect(written.size).toBeGreaterThan(0);

    applyTheme(theme({}), "dark");

    expect(written.size).toBe(0);

    clearTheme();
    clearTheme();
    expect(written.size).toBe(0);
  });

  it("ignores empty-string color values instead of writing them", async () => {
    const { applyTheme } = await loadModule();

    applyTheme(
      theme({
        dark: variant({ colors: { background: "", foreground: "#ffffff" } }),
      }),
      "dark",
    );

    expect(written.has("--background")).toBe(false);
    expect(written.has("--terminal-background")).toBe(false);
    expect(written.has("--terminal-header")).toBe(false);
    expect(written.get("--foreground")).toBe("#ffffff");
  });

  it("preserves explicit terminal.background verbatim and emits opaque --terminal-header", async () => {
    const { applyTheme } = await loadModule();

    applyTheme(
      theme({
        dark: variant({
          colors: { background: "#0d0d10", foreground: "#ededf2" },
          terminal: { background: "#0d0d10" },
        }),
        light: variant({
          colors: { background: "#f4f4f5", foreground: "#111111" },
          terminal: { background: "#fffef8" },
        }),
      }),
      "dark",
    );

    expect(written.get("--terminal-background")).toBe("#0d0d10");
    const darkHeader = written.get("--terminal-header");
    expect(darkHeader).toBeDefined();
    expect(darkHeader).not.toBe("#0d0d10");
    expect(darkHeader).not.toContain("transparent");
    expect(darkHeader).toMatch(/^#[0-9a-f]{6}$/i);

    applyTheme(
      theme({
        dark: variant({
          colors: { background: "#0d0d10", foreground: "#ededf2" },
          terminal: { background: "#0d0d10" },
        }),
        light: variant({
          colors: { background: "#f4f4f5", foreground: "#111111" },
          terminal: { background: "#fffef8" },
        }),
      }),
      "light",
    );

    expect(written.get("--terminal-background")).toBe("#fffef8");
    const lightHeader = written.get("--terminal-header");
    expect(lightHeader).toBeDefined();
    expect(lightHeader).not.toBe("#fffef8");
    expect(lightHeader).not.toContain("transparent");
    expect(lightHeader).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("auto-deepens --terminal-background on dark variants omitting terminal.background", async () => {
    const { applyTheme } = await loadModule();

    applyTheme(
      theme({
        dark: variant({
          colors: { background: "#1e1e2e", foreground: "#cdd6f4" },
        }),
      }),
      "dark",
    );

    const termBg = written.get("--terminal-background") ?? "";
    const termHeader = written.get("--terminal-header") ?? "";
    expect(termBg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(hexLuminance(termBg)).toBeLessThan(hexLuminance("#1e1e2e"));
    expect(termHeader).toMatch(/^#[0-9a-f]{6}$/i);
    expect(hexLuminance(termHeader)).toBeGreaterThan(hexLuminance(termBg));
    expect(hexLuminance(termHeader)).toBeLessThan(hexLuminance("#1e1e2e"));
  });

  it("preserves bright terminal surface on light variants including light-only dark fallback", async () => {
    const { applyTheme } = await loadModule();
    const onlyLight = theme({
      light: variant({
        colors: { background: "#eff1f5", foreground: "#4c4f69" },
      }),
    });

    applyTheme(onlyLight, "light");
    expect(written.get("--terminal-background")).toBe("#eff1f5");
    const lightHeader = written.get("--terminal-header") ?? "";
    expect(lightHeader).toMatch(/^#[0-9a-f]{6}$/i);
    expect(hexLuminance(lightHeader)).toBeGreaterThan(hexLuminance("#eff1f5"));

    applyTheme(onlyLight, "dark");
    expect(written.get("--terminal-background")).toBe("#eff1f5");
    const fallbackHeader = written.get("--terminal-header") ?? "";
    expect(fallbackHeader).toMatch(/^#[0-9a-f]{6}$/i);
    expect(hexLuminance(fallbackHeader)).toBeGreaterThan(
      hexLuminance("#eff1f5"),
    );
  });

  it("clears --terminal-header and derived --terminal-background on switch and clearTheme", async () => {
    const { applyTheme, clearTheme } = await loadModule();

    applyTheme(
      theme({
        dark: variant({
          colors: { background: "#1e1e2e", foreground: "#cdd6f4" },
        }),
      }),
      "dark",
    );
    expect(written.has("--terminal-background")).toBe(true);
    expect(written.has("--terminal-header")).toBe(true);

    removed.length = 0;
    applyTheme(
      theme({ dark: variant({ colors: { accent: "#654321" } }) }),
      "dark",
    );
    expect(removed).toContain("--terminal-background");
    expect(removed).toContain("--terminal-header");
    expect(written.has("--terminal-header")).toBe(false);

    applyTheme(
      theme({
        dark: variant({
          colors: { background: "#282a36", foreground: "#f8f8f2" },
        }),
      }),
      "dark",
    );
    clearTheme();
    expect(written.has("--terminal-background")).toBe(false);
    expect(written.has("--terminal-header")).toBe(false);
  });

  it("falls back to opaque color-mix for non-hex CSS color literals", async () => {
    const { applyTheme } = await loadModule();

    applyTheme(
      theme({
        dark: variant({
          colors: {
            background: "oklch(0.2 0.02 260)",
            foreground: "oklch(0.92 0.01 260)",
          },
        }),
      }),
      "dark",
    );

    const termBg = written.get("--terminal-background");
    const termHeader = written.get("--terminal-header");
    expect(termBg).toContain("color-mix(in oklab");
    expect(termBg).not.toContain("transparent");
    expect(termHeader).toContain("color-mix(in oklab");
    expect(termHeader).not.toContain("transparent");
  });
});
