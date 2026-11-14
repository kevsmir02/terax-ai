import {
  DEFAULT_THEME_ID,
  type Theme,
  type ThemeMode,
  type ThemeVariant,
} from "./types";

export interface ResolvedThemeVariant {
  readonly mode: ThemeMode;
  readonly variant: ThemeVariant;
}

export interface ResolvedTerminalSurface {
  readonly terminalBackground?: string;
  readonly terminalHeader?: string;
}

export interface ThemeSwatch {
  readonly stageBackground: string;
  readonly terminalHeader: string;
  readonly terminalBackground: string;
  readonly foreground: string;
  readonly accent: string;
  readonly muted: string;
  readonly border: string;
}

const DEFAULT_SWATCHES: Record<ThemeMode, ThemeSwatch> = {
  dark: {
    stageBackground: "#141414",
    terminalHeader: "#101012",
    terminalBackground: "#09090b",
    foreground: "#f7f7f7",
    accent: "#f7f7f7",
    muted: "#1d1d1d",
    border: "rgba(255, 255, 255, 0.15)",
  },
  light: {
    stageBackground: "#f4f4f5",
    terminalHeader: "#fafafa",
    terminalBackground: "#ffffff",
    foreground: "#111111",
    accent: "#111111",
    muted: "#e7e7ea",
    border: "rgba(0, 0, 0, 0.15)",
  },
};

interface Oklab {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

const DARK_AUTO_DEEPEN_WEIGHT = 0.28;
const DARK_HEADER_FG_WEIGHT = 0.045;
const LIGHT_HEADER_FG_WEIGHT = 0.025;
const MIN_HEADER_BLACK_L = 0.165;

/**
 * Picks the effective variant and records whether the selected palette is
 * dark or light (even when requested under the opposite mode as a fallback).
 */
export function resolveThemeVariant(
  theme: Theme,
  requestedMode: ThemeMode,
): ResolvedThemeVariant | null {
  const exact = theme.variants[requestedMode];
  if (exact) return { mode: requestedMode, variant: exact };
  if (theme.variants.dark)
    return { mode: "dark", variant: theme.variants.dark };
  if (theme.variants.light) {
    return { mode: "light", variant: theme.variants.light };
  }
  return null;
}

/**
 * Resolves the terminal canvas background and opaque header surface for a
 * theme variant. Explicit `terminal.background` wins verbatim; otherwise dark
 * variants auto-deepen from `colors.background` while light variants stay
 * bright.
 */
export function resolveTerminalSurface(
  variant: ThemeVariant,
  variantMode: ThemeMode,
): ResolvedTerminalSurface {
  const stageBg = nonEmpty(variant.colors?.background);
  const explicitTerminalBg = nonEmpty(variant.terminal?.background);
  const terminalBackground =
    explicitTerminalBg ??
    (stageBg
      ? variantMode === "dark"
        ? autoDeepenHex(stageBg)
        : stageBg
      : undefined);

  if (!terminalBackground) {
    return {};
  }

  const headerTarget =
    nonEmpty(variant.terminal?.foreground) ??
    nonEmpty(variant.colors?.foreground) ??
    (variantMode === "dark" ? "#f7f7f7" : "#111111");

  return {
    terminalBackground,
    terminalHeader: deriveTerminalHeader(
      terminalBackground,
      headerTarget,
      variantMode,
    ),
  };
}

/**
 * Resolves explicit swatch colors for a theme card in Settings, keeping
 * `terax-default` anchored to its CSS defaults instead of reading active
 * window custom properties.
 */
export function resolveThemeSwatch(
  theme: Theme,
  requestedMode: ThemeMode,
): ThemeSwatch {
  if (theme.id === DEFAULT_THEME_ID) {
    return DEFAULT_SWATCHES[requestedMode];
  }
  const resolved = resolveThemeVariant(theme, requestedMode);
  if (!resolved) {
    return DEFAULT_SWATCHES[requestedMode];
  }
  const { variant, mode: variantMode } = resolved;
  const fallback = DEFAULT_SWATCHES[variantMode];
  const surface = resolveTerminalSurface(variant, variantMode);
  const c = variant.colors;

  return {
    stageBackground: nonEmpty(c?.background) ?? fallback.stageBackground,
    terminalHeader: surface.terminalHeader ?? fallback.terminalHeader,
    terminalBackground:
      surface.terminalBackground ?? fallback.terminalBackground,
    foreground: nonEmpty(c?.foreground) ?? fallback.foreground,
    accent: nonEmpty(c?.primary) ?? nonEmpty(c?.accent) ?? fallback.accent,
    muted: nonEmpty(c?.muted) ?? fallback.muted,
    border: nonEmpty(c?.border) ?? fallback.border,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function autoDeepenHex(background: string): string {
  const parsed = parseHexRgb(background);
  if (!parsed) {
    return `color-mix(in oklab, ${background} 72%, #000000)`;
  }
  const lab = rgbToOklab(parsed);
  return oklabToHex({
    L: lab.L * (1 - DARK_AUTO_DEEPEN_WEIGHT),
    a: lab.a * (1 - DARK_AUTO_DEEPEN_WEIGHT),
    b: lab.b * (1 - DARK_AUTO_DEEPEN_WEIGHT),
  });
}

function deriveTerminalHeader(
  terminalBackground: string,
  foreground: string,
  mode: ThemeMode,
): string {
  const bgRgb = parseHexRgb(terminalBackground);
  const fgRgb = parseHexRgb(foreground);
  if (!bgRgb || !fgRgb) {
    const keepPct = mode === "dark" ? "95.5%" : "97.5%";
    return `color-mix(in oklab, ${terminalBackground} ${keepPct}, ${foreground})`;
  }

  const weight =
    mode === "dark" ? DARK_HEADER_FG_WEIGHT : LIGHT_HEADER_FG_WEIGHT;
  const bgLab = rgbToOklab(bgRgb);
  const fgLab = rgbToOklab(fgRgb);
  let mixed = mixOklab(bgLab, fgLab, weight);
  let result = oklabToHex(mixed);

  if (result === normalizeHex(terminalBackground)) {
    mixed = {
      L:
        mode === "dark"
          ? Math.max(bgLab.L + 0.04, MIN_HEADER_BLACK_L)
          : Math.max(0, bgLab.L - 0.04),
      a: bgLab.a,
      b: bgLab.b,
    };
    result = oklabToHex(mixed);
  }
  return result;
}

function normalizeHex(hex: string): string {
  const rgb = parseHexRgb(hex);
  if (!rgb) return hex.trim().toLowerCase();
  return rgbToHex(rgb[0], rgb[1], rgb[2]);
}

function parseHexRgb(input: string): readonly [number, number, number] | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("#")) return null;
  const raw = trimmed.slice(1);
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return [
      Number.parseInt(raw[0] + raw[0], 16),
      Number.parseInt(raw[1] + raw[1], 16),
      Number.parseInt(raw[2] + raw[2], 16),
    ];
  }
  if (/^[0-9a-f]{6}$/i.test(raw) || /^[0-9a-f]{8}$/i.test(raw)) {
    return [
      Number.parseInt(raw.slice(0, 2), 16),
      Number.parseInt(raw.slice(2, 4), 16),
      Number.parseInt(raw.slice(4, 6), 16),
    ];
  }
  return null;
}

function mixOklab(a: Oklab, b: Oklab, weightB: number): Oklab {
  const weightA = 1 - weightB;
  return {
    L: a.L * weightA + b.L * weightB,
    a: a.a * weightA + b.a * weightB,
    b: a.b * weightA + b.b * weightB,
  };
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const clamped = Math.min(1, Math.max(0, channel));
  const encoded =
    clamped <= 0.0031308
      ? 12.92 * clamped
      : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
}

function rgbToOklab([r8, g8, b8]: readonly [number, number, number]): Oklab {
  const r = srgbToLinear(r8);
  const g = srgbToLinear(g8);
  const b = srgbToLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToHex({ L, a, b }: Oklab): string {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const r = linearToSrgb(
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
  );
  const g = linearToSrgb(
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
  );
  const bl = linearToSrgb(
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  );
  return rgbToHex(r, g, bl);
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

function toHexByte(n: number): string {
  return n.toString(16).padStart(2, "0");
}
