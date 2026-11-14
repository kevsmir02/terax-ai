import {
  getBuiltinTheme,
  getDefaultTheme,
  listBuiltinThemes,
} from "@/modules/theme/themes/index";
import { DEFAULT_THEME_ID } from "@/modules/theme/types";
import { validateTheme } from "@/modules/theme/validateTheme";
import { describe, expect, it } from "vitest";

type Rgba = readonly [number, number, number, number];

function parseColor(value: string): Rgba {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) {
    const raw = trimmed.slice(1);
    const hex =
      raw.length === 3
        ? raw
            .split("")
            .map((c) => c + c)
            .join("")
        : raw;
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
      hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
    ];
  }
  const match = trimmed.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/,
  );
  if (!match) throw new Error(`Unsupported color in builtin theme: ${value}`);
  return [
    Number.parseFloat(match[1]),
    Number.parseFloat(match[2]),
    Number.parseFloat(match[3]),
    match[4] === undefined ? 1 : Number.parseFloat(match[4]),
  ];
}

function requireColor(value: string | undefined, label: string): Rgba {
  expect(value, label).toBeDefined();
  return parseColor(value as string);
}

function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ];
}

function relativeLuminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const n = c / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe("builtin theme registry", () => {
  it("exposes a non-empty list of themes", () => {
    expect(listBuiltinThemes().length).toBeGreaterThan(0);
  });

  it("has a unique id per theme", () => {
    const ids = listBuiltinThemes().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves every listed theme by its id", () => {
    for (const theme of listBuiltinThemes()) {
      expect(getBuiltinTheme(theme.id)).toBe(theme);
    }
  });

  it("returns undefined for an unknown id", () => {
    expect(getBuiltinTheme("no-such-theme")).toBeUndefined();
  });

  it("resolves the default theme through the registered-theme lookup", () => {
    expect(getDefaultTheme()).toBe(getBuiltinTheme(DEFAULT_THEME_ID));
  });

  it("falls back to the first registered theme if the default is missing", () => {
    const ids = listBuiltinThemes().map((t) => t.id);
    expect(ids).not.toContain("__fallback__");
    expect(getBuiltinTheme("__fallback__")).toBeUndefined();
    expect(getDefaultTheme()).toBe(listBuiltinThemes()[0]);
  });

  it("validates every themed builtin preset and enforces contrast baselines", () => {
    for (const theme of listBuiltinThemes()) {
      if (theme.id === DEFAULT_THEME_ID) continue;
      const validation = validateTheme(theme);
      expect(validation.ok, `${theme.id} validation`).toBe(true);

      for (const [mode, variant] of Object.entries(theme.variants)) {
        const c = variant?.colors;
        expect(c, `${theme.id}.${mode} colors`).toBeDefined();
        if (!c) continue;

        const bg = requireColor(c.background, `${theme.id}.${mode} background`);
        const card = requireColor(c.card, `${theme.id}.${mode} card`);
        const sidebar = requireColor(c.sidebar, `${theme.id}.${mode} sidebar`);
        const fg = requireColor(c.foreground, `${theme.id}.${mode} foreground`);
        const mutedFg = requireColor(
          c.mutedForeground,
          `${theme.id}.${mode} mutedForeground`,
        );
        const border = requireColor(c.border, `${theme.id}.${mode} border`);
        const sidebarBorder = requireColor(
          c.sidebarBorder,
          `${theme.id}.${mode} sidebarBorder`,
        );

        expect(
          contrastRatio(mutedFg, bg),
          `${theme.id}.${mode} mutedForeground vs background`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(mutedFg, card),
          `${theme.id}.${mode} mutedForeground vs card`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(mutedFg, sidebar),
          `${theme.id}.${mode} mutedForeground vs sidebar`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(fg, bg),
          `${theme.id}.${mode} foreground stronger than mutedForeground`,
        ).toBeGreaterThan(contrastRatio(mutedFg, bg));
        expect(
          contrastRatio(composite(border, bg), bg),
          `${theme.id}.${mode} border vs background`,
        ).toBeGreaterThanOrEqual(1.38);
        expect(
          contrastRatio(composite(border, card), card),
          `${theme.id}.${mode} border vs card`,
        ).toBeGreaterThanOrEqual(1.38);
        expect(
          contrastRatio(composite(sidebarBorder, sidebar), sidebar),
          `${theme.id}.${mode} sidebarBorder vs sidebar`,
        ).toBeGreaterThanOrEqual(1.38);
      }
    }
  });
});
