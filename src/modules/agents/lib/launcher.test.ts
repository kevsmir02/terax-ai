import { leafIds } from "@/modules/terminal";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_LAUNCHERS,
  createAgentPanePlan,
  DEFAULT_AGENT_LAUNCH_COMMANDS,
  findAgentLauncher,
  normalizeAgentLaunchCommands,
  resolveAgentLaunchCommand,
  validateAgentLaunchCommand,
  type AgentInstanceCount,
} from "./launcher";

function allocator(start = 1) {
  let id = start;
  return () => id++;
}

describe("agent launch commands", () => {
  it("defines a non-empty default for every launcher", () => {
    for (const launcher of AGENT_LAUNCHERS) {
      expect(DEFAULT_AGENT_LAUNCH_COMMANDS[launcher.id]).toBe(
        launcher.defaultCommand,
      );
    }
  });

  it("accepts aliases and arguments while trimming whitespace", () => {
    expect(validateAgentLaunchCommand("  cc --model opus  ")).toEqual({
      ok: true,
      command: "cc --model opus",
    });
  });

  it("rejects blank, multiline, and oversized commands", () => {
    expect(validateAgentLaunchCommand(" ")).toMatchObject({ ok: false });
    expect(validateAgentLaunchCommand("codex\nwhoami")).toMatchObject({
      ok: false,
    });
    expect(validateAgentLaunchCommand("x".repeat(257))).toMatchObject({
      ok: false,
    });
  });

  it("falls back per agent when persisted preferences are malformed", () => {
    expect(
      normalizeAgentLaunchCommands({
        claude: "cc",
        codex: "",
        gemini: 42,
        pi: "pi --provider local",
        unknown: "ignored",
      }),
    ).toEqual({
      claude: "cc",
      codex: "codex",
      gemini: "gemini",
      pi: "pi --provider local",
      opencode: "opencode",
      grok: "grok",
      antigravity: "antigravity",
    });
  });
});

describe("Antigravity CLI versus its desktop app", () => {
  it("offers the terminal CLI, not the GUI, as the launcher", () => {
    const launcher = findAgentLauncher("antigravity");

    expect(launcher).toMatchObject({
      id: "antigravity",
      label: "Antigravity CLI",
      defaultCommand: "antigravity",
      supportsHooks: false,
    });
  });

  it("launches the terminal CLI, with aliases and flags", () => {
    expect(resolveAgentLaunchCommand("antigravity", " ag --model x ")).toEqual({
      ok: true,
      command: "ag --model x",
    });
  });

  it("refuses desktop-app commands instead of pretending to control the GUI", () => {
    for (const gui of [
      "antigravity-desktop",
      "antigravity-gui --new-window",
      "open -a Antigravity",
      "open -n -a Antigravity /workspace",
      "xdg-open /usr/share/applications/antigravity.desktop",
      "/Applications/Antigravity.app/Contents/MacOS/Antigravity",
      "gio open antigravity.desktop",
    ]) {
      const result = resolveAgentLaunchCommand("antigravity", gui);

      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.error).toMatch(/terminal CLI/);
    }
  });

  it("keeps every other agent's command untouched", () => {
    expect(resolveAgentLaunchCommand("claude", "open -a Claude")).toEqual({
      ok: true,
      command: "open -a Claude",
    });
  });

  it("keeps blank and multiline commands refused", () => {
    expect(resolveAgentLaunchCommand("antigravity", "  ")).toMatchObject({
      ok: false,
    });
    expect(resolveAgentLaunchCommand("antigravity", "a\nb")).toMatchObject({
      ok: false,
    });
  });
});

describe("createAgentPanePlan", () => {
  it.each([1, 2, 3, 4] as AgentInstanceCount[])(
    "creates %i unique leaves with the requested cwd",
    (instances) => {
      const plan = createAgentPanePlan(instances, allocator(), "/workspace");
      const ids = leafIds(plan.paneTree);
      expect(ids).toEqual(plan.leafIds);
      expect(new Set(ids).size).toBe(instances);

      const visit = (node: typeof plan.paneTree) => {
        if (node.kind === "leaf") {
          expect(node.cwd).toBe("/workspace");
          return;
        }
        node.children.forEach(visit);
      };
      visit(plan.paneTree);
    },
  );

  it("balances four agents into a two by two grid", () => {
    const { paneTree } = createAgentPanePlan(4, allocator());
    expect(paneTree.kind).toBe("split");
    if (paneTree.kind !== "split") return;
    expect(paneTree.dir).toBe("row");
    expect(paneTree.children).toHaveLength(2);
    expect(
      paneTree.children.every(
        (child) =>
          child.kind === "split" &&
          child.dir === "col" &&
          child.children.length === 2,
      ),
    ).toBe(true);
  });

  it("rejects counts outside the renderer pool limit", () => {
    expect(() =>
      createAgentPanePlan(0 as AgentInstanceCount, allocator()),
    ).toThrow(RangeError);
    expect(() =>
      createAgentPanePlan(5 as AgentInstanceCount, allocator()),
    ).toThrow(RangeError);
  });
});

// Launching is a composition inside `App.tsx` and this suite renders no React
// tree, so the invariant the ticket needs is an absence: an ordinary launch must
// not install agent hooks. Hook installation stays an explicit command
// (`control/lib/hooksConfig.ts`, covered by `hooksConfig.test.ts`).
describe("hook-free launching", () => {
  it("does not enable hooks from the launch path", () => {
    const app = readFileSync(
      new URL("../../../app/App.tsx", import.meta.url),
      "utf8",
    );

    expect(app.match(/agent_enable_hooks/g) ?? []).toEqual([]);
    // Hook capability must not shape launching either: every launcher writes the
    // configured command and nothing else.
    expect(app.match(/supportsHooks/g) ?? []).toEqual([]);
  });
});
