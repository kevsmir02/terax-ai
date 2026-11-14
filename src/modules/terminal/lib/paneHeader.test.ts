import {
  formatPaneHeaderCwd,
  resolvePaneHeaderIdentity,
  shellBasename,
} from "@/modules/terminal/lib/paneHeader";
import { describe, expect, it } from "vitest";

describe("shellBasename", () => {
  it("extracts the executable basename and strips .exe", () => {
    expect(shellBasename("/bin/zsh")).toBe("zsh");
    expect(shellBasename("/usr/local/bin/fish")).toBe("fish");
    expect(shellBasename("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
    expect(shellBasename("pwsh.EXE")).toBe("pwsh");
  });

  it("returns null for empty, whitespace, or separator-only values", () => {
    expect(shellBasename("")).toBeNull();
    expect(shellBasename("   ")).toBeNull();
    expect(shellBasename("/")).toBeNull();
    expect(shellBasename("///")).toBeNull();
  });
});

describe("resolvePaneHeaderIdentity", () => {
  it("prioritizes active external agent over customTitle, shell, and Terminal", () => {
    expect(
      resolvePaneHeaderIdentity({
        activityAgent: "claude",
        activityPhase: "working",
        customTitle: "Build",
        terminalShell: "/bin/zsh",
      }),
    ).toEqual({
      kind: "agent",
      agent: "claude",
      label: "Claude Code",
      phase: "working",
    });

    expect(
      resolvePaneHeaderIdentity({
        sessionAgent: "codex",
        sessionStatus: "attention",
        customTitle: "Server",
        terminalShell: "/bin/bash",
      }),
    ).toEqual({
      kind: "agent",
      agent: "codex",
      label: "Codex",
      phase: "attention",
    });
  });

  it("prefers activityPhase over stale sessionStatus when activity store already updated", () => {
    expect(
      resolvePaneHeaderIdentity({
        activityAgent: "claude",
        activityPhase: "idle",
        sessionAgent: "claude",
        sessionStatus: "attention",
      }),
    ).toEqual({
      kind: "agent",
      agent: "claude",
      label: "Claude Code",
      phase: "idle",
    });
  });

  it("falls back through customTitle, configured shell, and literal Terminal", () => {
    expect(
      resolvePaneHeaderIdentity({
        customTitle: "  API Server  ",
        terminalShell: "/bin/zsh",
      }),
    ).toEqual({
      kind: "terminal",
      label: "API Server",
      phase: null,
    });

    expect(
      resolvePaneHeaderIdentity({
        customTitle: "   ",
        terminalShell: "/usr/bin/fish",
      }),
    ).toEqual({
      kind: "terminal",
      label: "fish",
      phase: null,
    });

    expect(
      resolvePaneHeaderIdentity({
        customTitle: "",
        terminalShell: "",
      }),
    ).toEqual({
      kind: "terminal",
      label: "Terminal",
      phase: null,
    });
  });
});

describe("formatPaneHeaderCwd", () => {
  it("returns null for missing or blank paths", () => {
    expect(formatPaneHeaderCwd(undefined, "/home/loba")).toBeNull();
    expect(formatPaneHeaderCwd(null, "/home/loba")).toBeNull();
    expect(formatPaneHeaderCwd("   ", "/home/loba")).toBeNull();
  });

  it("tildifies paths inside home without truncation when short", () => {
    expect(formatPaneHeaderCwd("/home/loba", "/home/loba")).toEqual({
      full: "~",
      display: "~",
    });
    expect(formatPaneHeaderCwd("/home/loba/terax-ai", "/home/loba")).toEqual({
      full: "~/terax-ai",
      display: "~/terax-ai",
    });
  });

  it("left-truncates long home paths with ~/... while keeping full tildified path", () => {
    const result = formatPaneHeaderCwd(
      "/home/loba/Documents/projects/personal/terax-ai/packages/core",
      "/home/loba",
      32,
    );
    expect(result).toEqual({
      full: "~/Documents/projects/personal/terax-ai/packages/core",
      display: "~/.../terax-ai/packages/core",
    });
  });

  it("left-truncates long paths outside home cleanly", () => {
    const result = formatPaneHeaderCwd(
      "/opt/company/platform/services/billing/handlers",
      "/home/loba",
      32,
    );
    expect(result).toEqual({
      full: "/opt/company/platform/services/billing/handlers",
      display: ".../services/billing/handlers",
    });
  });

  it("truncates an overly long single trailing segment cleanly", () => {
    const result = formatPaneHeaderCwd(
      "/home/loba/supercalifragilisticexpialidocious-directory",
      "/home/loba",
      24,
    );
    expect(result).toEqual({
      full: "~/supercalifragilisticexpialidocious-directory",
      display: "~/...lidocious-directory",
    });

    const nested = formatPaneHeaderCwd(
      "/home/loba/sub/supercalifragilisticexpialidocious-directory",
      "/home/loba",
      24,
    );
    expect(nested).toEqual({
      full: "~/sub/supercalifragilisticexpialidocious-directory",
      display: "~/.../idocious-directory",
    });
  });
});
