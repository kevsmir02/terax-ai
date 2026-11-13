import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  COMMAND_GROUPS,
  createCommandItems,
  type CommandPaletteActionContext,
} from "@/modules/command-palette/commands";
import { StatusBar } from "@/modules/statusbar";
import {
  MAC_DEFAULTS,
  WIN_LINUX_DEFAULTS,
} from "@/modules/shortcuts/shortcutDefaults";
import {
  type KeyBinding,
  matchBinding,
  SHORTCUTS,
} from "@/modules/shortcuts/shortcuts";
import type { Tab } from "@/modules/tabs";
import { normalizeSettingsTab, SETTINGS_TABS } from "@/settings/lib/tabRouting";
import { traceEager } from "../../scripts/eager-graph.mjs";

// Built-in AI chat, its composer, conversations and provider/model selection
// are removed (ticket #12). External-agent notifications and control stay, so
// the removal has to be visible in the surfaces that route keys, commands and
// settings links, in the startup graph, and in the chrome — not just in
// deleted files.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const srcRoot = path.join(repoRoot, "src");

const MAC = MAC_DEFAULTS;
const LINUX = WIN_LINUX_DEFAULTS;

type Platform = { name: string; table: typeof MAC };

const PLATFORMS: Platform[] = [
  { name: "macOS", table: MAC },
  { name: "Windows/Linux", table: LINUX },
];

function eventOf(binding: Partial<KeyBinding>): KeyboardEvent {
  return {
    key: binding.key ?? "",
    code: "",
    ctrlKey: !!binding.ctrl,
    shiftKey: !!binding.shift,
    altKey: !!binding.alt,
    metaKey: !!binding.meta,
  } as KeyboardEvent;
}

/** Shortcut ids whose default bindings claim the given chord. */
function routedBy(table: typeof MAC, event: KeyboardEvent): string[] {
  return SHORTCUTS.filter((shortcut) =>
    (table[shortcut.id] ?? []).some((binding) =>
      matchBinding(event, binding, shortcut.id),
    ),
  ).map((shortcut) => shortcut.id);
}

function terminalTab(id = 1): Tab {
  return {
    id,
    kind: "terminal",
    spaceId: "space",
    title: "shell",
    paneTree: { kind: "leaf", id: id * 10 },
    activeLeafId: id * 10,
  } as unknown as Tab;
}

function commandIds(): string[] {
  const noop = () => {};
  const ctx: CommandPaletteActionContext = {
    tabs: [terminalTab()],
    activeId: 1,
    searchTarget: "content" as never,
    explorerRoot: "/workspace",
    home: "/home/me",
    spaces: [],
    activeSpaceId: null,
    openNewTab: noop,
    openNewBlock: noop,
    openNewEditor: noop,
    openNewPreview: noop,
    openGitGraph: noop,
    toggleSourceControl: noop,
    closeActiveTabOrPane: noop,
    splitPaneRight: noop,
    splitPaneDown: noop,
    focusSearch: noop,
    focusExplorerSearch: noop,
    toggleSidebar: noop,
    toggleHiddenFiles: noop,
    openSettings: noop,
    openKeyboardShortcuts: noop,
    openSpacesOverview: noop,
    newSpace: noop,
    switchSpace: noop,
  };
  return createCommandItems(ctx).map((item) => item.id);
}

function filesUnder(dir: string, includeTests = false): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, includeTests);
    if (!/\.(?:ts|tsx)$/.test(entry.name)) return [];
    return includeTests || !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Every module a file names: static, `import type`, and `import()`. */
function specifiersOf(file: string): string[] {
  const code = readFileSync(file, "utf8");
  const specs = new Set<string>();
  for (const pattern of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ]) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) specs.add(match[1]);
    }
  }
  return [...specs];
}

function moduleId(spec: string, fromFile: string): string | null {
  let absolute: string;
  if (spec.startsWith("@/")) absolute = path.join(srcRoot, spec.slice(2));
  else if (spec.startsWith("."))
    absolute = path.resolve(path.dirname(fromFile), spec);
  else return null;
  return path
    .relative(repoRoot, absolute)
    .split(path.sep)
    .join("/")
    .replace(/\.(?:ts|tsx|js|jsx)$/, "")
    .replace(/\/index$/, "");
}

describe("removed built-in chat entry points", () => {
  it("keeps the chat, composer and input-mode shortcuts out of the keymap", () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id) as string[];
    for (const removed of [
      "ai.toggle",
      "ai.toggleMini",
      "terminal.toggleInput",
    ])
      expect(ids).not.toContain(removed);
    for (const { table } of PLATFORMS) {
      expect(Object.keys(table)).not.toContain("ai.toggle");
      expect(Object.keys(table)).not.toContain("ai.toggleMini");
      expect(Object.keys(table)).not.toContain("terminal.toggleInput");
    }
  });

  it.each([
    ["Cmd+I", { meta: true, key: "i" }],
    ["Shift+Cmd+I", { shift: true, meta: true, key: "i" }],
    ["Ctrl+Shift+I", { ctrl: true, shift: true, key: "i" }],
    ["Ctrl+Shift+Y", { ctrl: true, shift: true, key: "y" }],
  ] as const)("no longer routes %s anywhere", (_name, binding) => {
    for (const { table } of PLATFORMS)
      expect(routedBy(table, eventOf(binding))).toEqual([]);
  });

  it("offers no chat command or group in the palette", () => {
    const ids = commandIds();
    expect(ids).not.toContain("ai.toggle");
    expect(COMMAND_GROUPS as readonly string[]).not.toContain("AI");
    expect(ids).not.toContain("chat.open");
    expect(ids).not.toContain("composer.open");
  });

  it("routes settings deep links away from the removed AI sections", () => {
    expect(SETTINGS_TABS).not.toContain("models");
    for (const legacy of ["ai", "connections", "models"])
      expect(normalizeSettingsTab(legacy)).toBe("general");
    // Retained external-agent hook configuration keeps its tab.
    expect(normalizeSettingsTab("agents")).toBe("agents");
    expect(normalizeSettingsTab("editor")).toBe("editor");
    expect(normalizeSettingsTab("nonsense")).toBeNull();
  });

  it("exposes no chat controls in the status bar or the input bar", () => {
    const statusbar = renderToStaticMarkup(
      createElement(StatusBar, {
        cwd: "/workspace/project",
        filePath: null,
        home: "/home/me",
        onCd: () => {},
        onWorkspaceChange: () => {},
      }),
    );
    expect(statusbar).not.toMatch(/Open AI agent|AI chat|AI panel|composer/i);
    expect(statusbar).toContain("project");
  });
});

describe("no built-in conversation or AI-session startup work", () => {
  it("keeps the built-in AI feature and its vendors out of the eager startup graph", () => {
    const { files, hits } = traceEager("src/main.tsx");
    const eager = [...files].map((file) =>
      path.relative(repoRoot, file).split(path.sep).join("/"),
    );
    expect(eager.filter((file) => file.includes("modules/ai"))).toEqual([]);
    expect(
      eager.filter((file) => file.includes("components/ai-elements")),
    ).toEqual([]);
    expect([...hits.keys()]).toEqual([]);
  });

  it("names no chat hydration, session restore or chat persistence path", () => {
    const needles = [
      /\bhydrateSessions\b/,
      /\bflushSessionWrites\b/,
      /\bflushPersist\b/,
      /\bloadMessages\b/,
      /\bgetOrCreateChat\b/,
      /\bAiComposerProvider\b/,
    ];
    const hits = filesUnder(srcRoot).flatMap((file) => {
      const code = readFileSync(file, "utf8");
      return needles
        .filter((needle) => needle.test(code))
        .map((needle) => `${path.relative(repoRoot, file)}: ${needle}`);
    });
    expect(hits).toEqual([]);
  });

  it("does not ship the built-in AI SDK or its client-only helpers", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(manifest.dependencies ?? {});
    expect(
      deps.filter((name) => name === "ai" || name.startsWith("@ai-sdk/")),
    ).toEqual([]);
    expect(deps).not.toContain("use-stick-to-bottom");
    expect(deps).not.toContain("zod");
  });

  it("keeps the preferences hydration that retained chrome depends on", () => {
    const app = readFileSync(path.join(srcRoot, "app/App.tsx"), "utf8");
    expect(app).toContain("usePreferencesBootstrap");
    // The shell must not gain a startup-conditional provider wrapper: that is
    // what remounted the tree (and respawned live PTYs) when keys loaded.
    expect(app).not.toMatch(/hasComposer|keysLoaded/);
    expect(app).toMatch(/return shell;/);
  });
});

/** Modules that may no longer exist or be imported anywhere in `src`. */
const REMOVED = [
  "src/modules/ai",
  "src/components/ai-elements",
  "src/lib/usePresence",
];

const REMOVED_PACKAGES = ["ai", "@ai-sdk", "use-stick-to-bottom", "zod"];

describe("built-in chat ownership", () => {
  it("has no retained module importing the removed feature", () => {
    const leaks = filesUnder(srcRoot).flatMap((file) =>
      specifiersOf(file).flatMap((spec) => {
        const id = moduleId(spec, file);
        const local =
          id !== null &&
          REMOVED.some((owner) => id === owner || id.startsWith(`${owner}/`));
        const pkg = REMOVED_PACKAGES.some(
          (name) => spec === name || spec.startsWith(`${name}/`),
        );
        return local || pkg
          ? [`${path.relative(repoRoot, file)} -> ${spec}`]
          : [];
      }),
    );
    expect(leaks).toEqual([]);
  });

  it("leaves no chat tab kind in the tab surface", () => {
    const leaks = filesUnder(path.join(srcRoot, "modules/tabs")).filter(
      (file) => {
        const code = readFileSync(file, "utf8");
        return /kind:\s*["'](?:ai|chat)["']|ai-diff/.test(code);
      },
    );
    expect(leaks.map((file) => path.relative(repoRoot, file))).toEqual([]);
  });
});

describe("retained workspace and external-agent surfaces", () => {
  it("still routes the terminal, file, Git and editor shortcuts", () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    for (const retained of [
      "editor.save",
      "editor.codeComplete",
      "search.focus",
      "pane.source",
      "agent.focusAttention",
      "settings.open",
    ])
      expect(ids, retained).toContain(retained);

    expect(routedBy(MAC, eventOf({ meta: true, key: "s" }))).toEqual([
      "editor.save",
    ]);
    expect(routedBy(LINUX, eventOf({ ctrl: true, key: "s" }))).toEqual([
      "editor.save",
    ]);
    expect(
      routedBy(LINUX, eventOf({ ctrl: true, shift: true, key: "a" })),
    ).toEqual(["agent.focusAttention"]);
  });

  it("keeps terminal, file and Git commands in the palette", () => {
    const ids = commandIds();
    for (const retained of [
      "tab.new",
      "tab.newEditor",
      "explorer.search",
      "git.source",
      "git.graph",
      "history.open",
      "settings.open",
    ])
      expect(ids, retained).toContain(retained);
  });
});
