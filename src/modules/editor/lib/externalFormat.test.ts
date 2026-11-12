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
) => ({ editorFormatter: global, editorFormatterByLang: byLang });

describe("resolveFormatter", () => {
  it("explicit override wins over the global default", () => {
    expect(resolveFormatter("py", prefs("biome", { py: "ruff" }))).toBe("ruff");
  });

  it("global external applies only to languages it understands", () => {
    expect(resolveFormatter("ts", prefs("biome"))).toBe("biome");
    expect(resolveFormatter("py", prefs("biome"))).toBe("lsp");
    expect(resolveFormatter("rs", prefs("prettier"))).toBe("lsp");
    expect(resolveFormatter("svelte", prefs("prettier"))).toBe("prettier");
  });

  it("lsp and custom globals always apply", () => {
    expect(resolveFormatter("py", prefs("lsp"))).toBe("lsp");
    expect(resolveFormatter("py", prefs("custom"))).toBe("custom");
  });

  it("unknown language falls back to lsp for external globals", () => {
    expect(resolveFormatter(null, prefs("biome"))).toBe("lsp");
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
