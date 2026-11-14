import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

type Rgba = readonly [number, number, number, number];

function parseColor(value: string): Rgba {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) {
    const hex =
      trimmed.length === 4
        ? trimmed
            .slice(1)
            .split("")
            .map((c) => c + c)
            .join("")
        : trimmed.slice(1);
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
      1,
    ];
  }
  const match = trimmed.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/,
  );
  if (!match) throw new Error(`Unsupported CSS color literal: ${value}`);
  return [
    Number.parseFloat(match[1]),
    Number.parseFloat(match[2]),
    Number.parseFloat(match[3]),
    match[4] === undefined ? 1 : Number.parseFloat(match[4]),
  ];
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
  const channel = (c: number) => {
    const n = c / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function extractRuleBlock(selectorPattern: RegExp): string {
  const match = css.match(selectorPattern);
  if (!match) {
    throw new Error(`Missing CSS block for ${selectorPattern.source}`);
  }
  return match[1];
}

function readVar(block: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`${escaped}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing CSS variable ${name}`);
  return match[1].trim();
}

describe("default theme tokens and tonal hierarchy", () => {
  const themeInline = extractRuleBlock(/@theme inline\s*\{([^}]*)\n\}/);
  const lightBase = extractRuleBlock(
    /\n:root\s*\{([^}]*--background:[^}]*)\n\}/,
  );
  const darkBase = extractRuleBlock(
    /\n\.dark\s*\{([^}]*--background:[^}]*)\n\}/,
  );
  const lightTerminal = extractRuleBlock(
    /\n:root\s*\{([^}]*--terminal-background:[^}]*)\n\}/,
  );
  const darkTerminal = extractRuleBlock(
    /\n\.dark\s*\{([^}]*--terminal-ansi-black:[^}]*)\n\}/,
  );

  it("exposes decoupled terminal surface and header colors in @theme inline", () => {
    expect(readVar(themeInline, "--color-terminal-background")).toBe(
      "var(--terminal-background)",
    );
    expect(readVar(themeInline, "--color-terminal-header")).toBe(
      "var(--terminal-header)",
    );
  });

  it("establishes a four-step tonal hierarchy in light default with crisp white terminal over tinted stage", () => {
    const stageBg = readVar(lightBase, "--background");
    const cardBg = readVar(lightBase, "--card");
    const termBg = readVar(lightTerminal, "--terminal-background");
    const termHeader = readVar(lightTerminal, "--terminal-header");

    expect(stageBg).toBe("#f4f4f5");
    expect(termBg).toBe("#ffffff");
    expect(termBg).not.toBe("var(--background)");
    expect(parseColor(cardBg)[3]).toBe(1);
    expect(parseColor(termHeader)[3]).toBe(1);
    expect(relativeLuminance(parseColor(cardBg))).toBeLessThan(
      relativeLuminance(parseColor(stageBg)),
    );
    expect(relativeLuminance(parseColor(stageBg))).toBeLessThan(
      relativeLuminance(parseColor(termHeader)),
    );
    expect(relativeLuminance(parseColor(termHeader))).toBeLessThan(
      relativeLuminance(parseColor(termBg)),
    );
    expect(readVar(lightTerminal, "--terminal-cursor-accent")).toBe(
      "var(--terminal-background)",
    );
  });

  it("establishes a four-step tonal hierarchy in dark default with near-black terminal below stage", () => {
    const stageBg = readVar(darkBase, "--background");
    const cardBg = readVar(darkBase, "--card");
    const termBg = readVar(darkTerminal, "--terminal-background");
    const termHeader = readVar(darkTerminal, "--terminal-header");

    expect(stageBg).toBe("#141414");
    expect(parseColor(termBg)[3]).toBe(1);
    expect(parseColor(termHeader)[3]).toBe(1);
    expect(relativeLuminance(parseColor(termBg))).toBeLessThan(
      relativeLuminance(parseColor(termHeader)),
    );
    expect(relativeLuminance(parseColor(termHeader))).toBeLessThan(
      relativeLuminance(parseColor(stageBg)),
    );
    expect(relativeLuminance(parseColor(stageBg))).toBeLessThan(
      relativeLuminance(parseColor(cardBg)),
    );
  });

  it("raises default border, sidebar-border, and muted-foreground contrast baselines", () => {
    for (const block of [lightBase, darkBase]) {
      const bg = parseColor(readVar(block, "--background"));
      const card = parseColor(readVar(block, "--card"));
      const sidebar = parseColor(readVar(block, "--sidebar"));
      const mutedFg = parseColor(readVar(block, "--muted-foreground"));
      const border = parseColor(readVar(block, "--border"));
      const sidebarBorder = parseColor(readVar(block, "--sidebar-border"));

      expect(contrastRatio(mutedFg, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(mutedFg, card)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(composite(border, bg), bg)).toBeGreaterThanOrEqual(
        1.38,
      );
      expect(
        contrastRatio(composite(sidebarBorder, sidebar), sidebar),
      ).toBeGreaterThanOrEqual(1.38);
    }
  });

  it("scopes data-vibrancy translucency exclusively to --frame", () => {
    const vibrancyMatches = [
      ...css.matchAll(/html\[data-vibrancy="on"\][^{]*\{([\s\S]*?)\}/g),
    ];
    expect(vibrancyMatches.length).toBeGreaterThan(0);
    const vibrancyCss = vibrancyMatches.map((m) => m[1]).join("\n");
    expect(vibrancyCss).toContain("--frame:");
    expect(vibrancyCss).not.toContain("--background:");
    expect(vibrancyCss).not.toContain("--terminal-background:");
    expect(vibrancyCss).not.toContain("--terminal-header:");
  });

  it("removes floating .terax-pane chrome while keeping --frame and borderless outer window rules", () => {
    expect(css).not.toMatch(/\.terax-pane(?![a-zA-Z0-9_-])/);
    expect(css).not.toContain("--pane-radius");
    expect(css).not.toContain("--pane-shadow");
    expect(css).toContain("--frame:");
    expect(css).toMatch(
      /html\[data-chrome="borderless"\]\s+#root[\s\S]*border-radius:\s*12px/,
    );
    expect(css).toMatch(
      /html\[data-chrome="borderless"\]\s+#root[\s\S]*border:\s*1px solid var\(--border\)/,
    );
  });
});
