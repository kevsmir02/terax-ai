import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type CommandPaletteActionContext,
  createCommandItems,
} from "@/modules/command-palette/commands";
import { MAC_DEFAULTS, WIN_LINUX_DEFAULTS } from "@/modules/shortcuts/shortcutDefaults";
import {
  type KeyBinding,
  matchBinding,
  SHORTCUTS,
} from "@/modules/shortcuts/shortcuts";
import type { Tab } from "@/modules/tabs";

// The built-in AI feature no longer owns editor completion, AI edit review or
// Ask AI (ticket #13). Ordinary editing, CodeMirror completion and Git diff
// review are retained, so the removal has to be visible in the surfaces that
// route keys and commands and in the import graph, not just in deleted files.

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

describe("removed AI editor actions", () => {
  it("keeps AI completion and Ask AI out of the shortcut surface", () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id) as string[];
    expect(ids).not.toContain("editor.aiComplete");
    expect(ids).not.toContain("ai.askSelection");
    for (const { table } of PLATFORMS) {
      expect(Object.keys(table)).not.toContain("editor.aiComplete");
      expect(Object.keys(table)).not.toContain("ai.askSelection");
    }
  });

  it.each([
    ["Alt+\\", { alt: true, key: "\\" }],
    ["Cmd+J", { meta: true, key: "j" }],
    ["Ctrl+Shift+J", { ctrl: true, shift: true, key: "j" }],
  ] as const)("no longer routes %s anywhere", (_name, binding) => {
    for (const { table } of PLATFORMS)
      expect(routedBy(table, eventOf(binding))).toEqual([]);
  });

  it("offers no Ask AI command in the palette", () => {
    const ids = commandIds();
    expect(ids).not.toContain("ai.askSelection");
    expect(ids).not.toContain("editor.aiComplete");
    expect(ids).not.toContain("editor.askAi");
  });

  it("leaves no AI diff tab kind in the tab surface", () => {
    const leaks = filesUnder(srcRoot).filter((file) =>
      readFileSync(file, "utf8").includes("ai-diff"),
    );
    expect(leaks.map((file) => path.relative(repoRoot, file))).toEqual([]);
  });
});

describe("retained editing and terminal actions", () => {
  it("still routes the editor and terminal shortcuts", () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    for (const retained of [
      "editor.save",
      "editor.undo",
      "editor.redo",
      "editor.codeComplete",
      "search.focus",
      "terminal.clear",
      "pane.source",
    ])
      expect(ids, retained).toContain(retained);

    expect(routedBy(MAC, eventOf({ meta: true, key: "s" }))).toEqual([
      "editor.save",
    ]);
    expect(routedBy(LINUX, eventOf({ ctrl: true, key: "s" }))).toEqual([
      "editor.save",
    ]);
    // CodeMirror's own completion popup is not AI completion.
    expect(routedBy(MAC, eventOf({ ctrl: true, key: " " }))).toEqual([
      "editor.codeComplete",
    ]);
    expect(routedBy(LINUX, eventOf({ ctrl: true, key: " " }))).toEqual([
      "editor.codeComplete",
    ]);
    expect(routedBy(MAC, eventOf({ meta: true, key: "f" }))).toEqual([
      "search.focus",
    ]);
    expect(
      routedBy(LINUX, eventOf({ ctrl: true, shift: true, key: "f" })),
    ).toEqual(["search.focus"]);
    // Clearing a focused terminal stays ahead of the palette on macOS.
    expect(MAC["terminal.clear"].length).toBeGreaterThan(0);
  });

  it("keeps ordinary Git review in the palette", () => {
    const ids = commandIds();
    for (const retained of ["git.source", "git.graph", "history.open"])
      expect(ids, retained).toContain(retained);
  });
});

const AI_OWNED = ["src/modules/ai", "src/components/ai-elements"];

/** Modules that must never depend on the built-in AI feature again. */
const DETACHED = [
  "src/modules/editor",
  "src/modules/terminal",
  "src/modules/tabs",
];

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

describe("editor, terminal and tab ownership", () => {
  it("never depends on the built-in AI feature", () => {
    const leaks = DETACHED.flatMap((dir) =>
      filesUnder(path.join(repoRoot, dir)).flatMap((file) =>
        specifiersOf(file).flatMap((spec) => {
          const id = moduleId(spec, file);
          if (id === null) return [];
          const owner = AI_OWNED.find(
            (candidate) => id === candidate || id.startsWith(`${candidate}/`),
          );
          return owner ? [`${path.relative(repoRoot, file)} -> ${spec}`] : [];
        }),
      ),
    );
    expect(leaks).toEqual([]);
  });

  it("names the removed surfaces nowhere in the retained sources", () => {
    const removed = [
      "@/modules/editor/lib/autocomplete",
      "@/modules/editor/AiDiffPane",
      "@/modules/editor/AiDiffStack",
      "@/modules/ai/components/SelectionAskAi",
      "@/modules/ai/hooks/useSelectionAskAi",
    ];
    const leaks = filesUnder(srcRoot).flatMap((file) =>
      specifiersOf(file).flatMap((spec) =>
        removed.includes(spec)
          ? [`${path.relative(repoRoot, file)} -> ${spec}`]
          : [],
      ),
    );
    expect(leaks).toEqual([]);
  });
});
