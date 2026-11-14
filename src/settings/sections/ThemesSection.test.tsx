// @vitest-environment jsdom
import {
  DEFAULT_THEME_ID,
  type Theme,
  type ThemeMode,
} from "@/modules/theme/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemesSection } from "./ThemesSection";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockThemeState = {
  themeId: DEFAULT_THEME_ID,
  setThemeId: vi.fn(),
  resolvedMode: "dark" as ThemeMode,
  customThemes: [] as Theme[],
};

const mockBackdropKind = vi.fn(
  async () => "none" as "none" | "vibrancy" | "mica",
);

vi.mock("@/modules/theme", () => ({
  useTheme: () => mockThemeState,
}));

vi.mock("@/modules/theme/vibrancy", () => ({
  getBackdropKind: () => mockBackdropKind(),
}));

vi.mock("@/modules/settings/preferences", () => {
  const state = {
    editorTheme: "auto",
    backgroundKind: "none",
    backgroundImageId: null,
    backgroundOpacity: 1,
    backgroundBlur: 0,
    windowVibrancy: false,
  };
  return {
    usePreferencesStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

vi.mock("@/modules/settings/store", () => ({
  EDITOR_THEME_AUTO: "auto",
  EDITOR_THEME_LABELS: {},
  EDITOR_THEME_MODE: {},
  EDITOR_THEMES: [],
  setBackgroundBlur: vi.fn(),
  setBackgroundImageId: vi.fn(),
  setBackgroundKind: vi.fn(),
  setBackgroundOpacity: vi.fn(),
  setEditorTheme: vi.fn(),
  setWindowVibrancy: vi.fn(),
}));

vi.mock("@/modules/theme/bgImageStore", () => ({
  deleteBgImage: vi.fn(),
  importBgImageFromFile: vi.fn(),
}));

vi.mock("@/modules/theme/customThemes", () => ({
  deleteCustomTheme: vi.fn(),
  saveCustomTheme: vi.fn(),
}));

vi.mock("@/modules/theme/themeFiles", () => ({
  deleteThemeFile: vi.fn(),
  handOffThemeEdit: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: vi.fn() }),
}));

function parseRgbCss(color: string): readonly [number, number, number] {
  const trimmed = color.trim();
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }
  const m = trimmed.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (!m) throw new Error(`Expected concrete RGB/hex color, got: "${color}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function luminance(rgb: readonly [number, number, number]): number {
  const lin = (c: number) => {
    const n = c / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

describe("ThemesSection swatches and vibrancy copy", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockThemeState.themeId = DEFAULT_THEME_ID;
    mockThemeState.resolvedMode = "dark";
    mockThemeState.customThemes = [];
    mockBackdropKind.mockResolvedValue("none");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function renderSection() {
    await act(async () => {
      root.render(<ThemesSection />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function querySwatch(id: string) {
    const stage = container.querySelector<HTMLElement>(
      `[data-theme-swatch="${id}"]`,
    );
    const header = stage?.querySelector<HTMLElement>(
      '[data-swatch-role="header"]',
    );
    const terminal = stage?.querySelector<HTMLElement>(
      '[data-swatch-role="terminal"]',
    );
    if (!stage || !header || !terminal) {
      throw new Error(`Missing swatch elements for ${id}`);
    }
    return { stage, header, terminal };
  }

  it("renders terax-default dark swatch with literal 4-step defaults even when another theme is selected", async () => {
    mockThemeState.themeId = "catppuccin";
    mockThemeState.resolvedMode = "dark";
    await renderSection();

    const { stage, header, terminal } = querySwatch(DEFAULT_THEME_ID);
    expect(parseRgbCss(stage.style.background)).toEqual([20, 20, 20]);
    expect(parseRgbCss(header.style.background)).toEqual([16, 16, 18]);
    expect(parseRgbCss(terminal.style.background)).toEqual([9, 9, 11]);
  });

  it("renders terax-default light swatch with tinted stage, opaque header, and white terminal", async () => {
    mockThemeState.resolvedMode = "light";
    await renderSection();

    const { stage, header, terminal } = querySwatch(DEFAULT_THEME_ID);
    expect(parseRgbCss(stage.style.background)).toEqual([244, 244, 245]);
    expect(parseRgbCss(header.style.background)).toEqual([250, 250, 250]);
    expect(parseRgbCss(terminal.style.background)).toEqual([255, 255, 255]);
  });

  it("reflects auto-deepened terminal surface on dark presets and bright surface on light presets", async () => {
    mockThemeState.resolvedMode = "dark";
    await renderSection();

    const darkSwatch = querySwatch("catppuccin");
    const darkStageRgb = parseRgbCss(darkSwatch.stage.style.background);
    const darkTermRgb = parseRgbCss(darkSwatch.terminal.style.background);
    expect(darkStageRgb).toEqual([30, 30, 46]);
    expect(luminance(darkTermRgb)).toBeLessThan(luminance(darkStageRgb));

    mockThemeState.resolvedMode = "light";
    await renderSection();

    const lightSwatch = querySwatch("catppuccin");
    const lightStageRgb = parseRgbCss(lightSwatch.stage.style.background);
    const lightTermRgb = parseRgbCss(lightSwatch.terminal.style.background);
    expect(lightStageRgb).toEqual([239, 241, 245]);
    expect(lightTermRgb).toEqual([239, 241, 245]);
  });

  it("renders explicit custom terminal.background verbatim in preview swatches", async () => {
    mockThemeState.resolvedMode = "dark";
    mockThemeState.customThemes = [
      {
        id: "custom-deep",
        name: "Custom Deep",
        author: "Tester",
        description: "Explicit terminal surface",
        variants: {
          dark: {
            colors: {
              background: "#1c1f2b",
              foreground: "#eef1f8",
              primary: "#7aa2f7",
              muted: "#262a3a",
            },
            terminal: {
              background: "#05070c",
            },
          },
        },
      },
    ];
    await renderSection();

    const { stage, terminal } = querySwatch("custom-deep");
    expect(parseRgbCss(stage.style.background)).toEqual([28, 31, 43]);
    expect(parseRgbCss(terminal.style.background)).toEqual([5, 7, 12]);
  });

  it("describes window vibrancy and mica as shell frame translucency with solid stage and terminals", async () => {
    mockBackdropKind.mockResolvedValue("vibrancy");
    await renderSection();
    expect(container.textContent).toContain("shell frame");
    expect(container.textContent).not.toContain("gutters");
    expect(container.textContent).not.toContain("Panes stay solid");

    mockBackdropKind.mockResolvedValue("mica");
    await renderSection();
    expect(container.textContent).toContain("shell frame");
    expect(container.textContent).not.toContain("gutters");
  });
});
