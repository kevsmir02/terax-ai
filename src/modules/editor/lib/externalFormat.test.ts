import { beforeEach, describe, expect, it, vi } from "vitest";

const shellRunCommand = vi.fn();

vi.mock("@/modules/workspace/native", () => ({
  native: {
    shellRunCommand: (...args: unknown[]) => shellRunCommand(...args),
  },
}));

import { resolveFormatter, runExternalFormatter } from "./externalFormat";

const prefs = (
  global: Parameters<typeof resolveFormatter>[1]["editorFormatter"],
  byLang: Record<string, never> | Record<string, "ruff" | "prettier"> = {},
  customCommand = "",
) => ({
  editorFormatter: global,
  editorFormatterByLang: byLang,
  editorCustomFormatCommand: customCommand,
});

describe("resolveFormatter", () => {
  it("explicit override wins over the global default", () => {
    expect(resolveFormatter("py", prefs("biome", { py: "ruff" }))).toBe("ruff");
    // Overrides run even for a language the tool does not advertise.
    expect(resolveFormatter("py", prefs("biome", { py: "prettier" }))).toBe(
      "prettier",
    );
  });

  it("global external applies only to languages it understands", () => {
    expect(resolveFormatter("ts", prefs("biome"))).toBe("biome");
    expect(resolveFormatter("svelte", prefs("prettier"))).toBe("prettier");
  });

  // With language servers removed there is no fallback formatter: a language
  // the configured tool does not understand saves unformatted.
  it("leaves unsupported languages and unknown files unformatted", () => {
    expect(resolveFormatter("py", prefs("biome"))).toBeNull();
    expect(resolveFormatter("rs", prefs("prettier"))).toBeNull();
    expect(resolveFormatter(null, prefs("biome"))).toBeNull();
  });

  it("runs the custom command once the user configures one", () => {
    expect(resolveFormatter("py", prefs("custom"))).toBeNull();
    // The custom command is language-agnostic, so unknown files still run it.
    expect(resolveFormatter("py", prefs("custom", {}, "mytool --fix"))).toBe(
      "custom",
    );
    expect(resolveFormatter(null, prefs("custom", {}, "mytool"))).toBe(
      "custom",
    );
    // An unrelated custom command never revives a tool that does not apply.
    expect(resolveFormatter("py", prefs("biome", {}, "mytool"))).toBeNull();
    expect(resolveFormatter("ts", prefs("biome", {}, "mytool"))).toBe("biome");
  });
});

describe("runExternalFormatter", () => {
  beforeEach(() => {
    shellRunCommand.mockReset();
  });

  it("runs the formatter in the edited file's directory", async () => {
    shellRunCommand.mockResolvedValue({
      stdout: "",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      truncated: false,
    });
    expect(
      await runExternalFormatter("biome", "/work/proj/src/main.ts"),
    ).toBeNull();
    expect(shellRunCommand).toHaveBeenCalledWith(
      "biome format --write '/work/proj/src/main.ts'",
      "/work/proj/src",
      20,
    );
  });

  it("surfaces the native cwd refusal instead of reporting success", async () => {
    // The shell seam authorizes `cwd` against the workspace registry: a file
    // opened outside every authorized root can be edited, but its formatter
    // run is refused (documented limitation, ticket #5 RS-3).
    shellRunCommand.mockRejectedValue(
      "cwd is outside the authorized workspace: /outside/proj",
    );
    const error = await runExternalFormatter("biome", "/outside/proj/main.ts");
    expect(error).toContain("outside the authorized workspace");
    expect(shellRunCommand).toHaveBeenCalledWith(
      "biome format --write '/outside/proj/main.ts'",
      "/outside/proj",
      20,
    );
  });

  it("reports a non-zero exit as the formatter's stderr", async () => {
    shellRunCommand.mockResolvedValue({
      stdout: "",
      stderr: "biome: parse error\n",
      exit_code: 1,
      timed_out: false,
      truncated: false,
    });
    expect(await runExternalFormatter("biome", "/work/proj/a.ts")).toBe(
      "biome: parse error",
    );
  });
});
