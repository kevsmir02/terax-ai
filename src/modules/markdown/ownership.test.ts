import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { traceEager } from "../../../scripts/eager-graph.mjs";

// Rendered Markdown used to be owned by the built-in AI feature, which is why
// its pieces lived under `components/ai-elements/`. It is now a retained
// workspace feature: the import graph must only ever run *out of* the Markdown
// module, never back into the AI feature, so removing the AI feature cannot
// break the preview and re-adding the dependency is caught here.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const srcRoot = path.join(repoRoot, "src");

const MARKDOWN_DIR = path.join(srcRoot, "modules/markdown");
const TEXT_SHIMMER = path.join(srcRoot, "components/text-shimmer.tsx");

/** Places only the AI feature may import from. */
const AI_OWNED = ["src/modules/ai", "src/components/ai-elements"];

/**
 * The AI-owned element aliases that used to re-export the Markdown renderer
 * were deleted with the built-in chat feature (ticket #12). Nothing may point
 * at those paths again.
 */
const LEGACY_ENTRY_POINTS = [
  "src/components/ai-elements/markdown-code",
  "src/components/ai-elements/chat-code",
  "src/components/ai-elements/chat-code-lezer",
  "src/components/ai-elements/shimmer",
];

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [full] : [];
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
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) specs.add(match[1]);
    }
  }
  return [...specs];
}

/** Repo-relative module id (`src/modules/markdown`) for a local specifier. */
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

function contains(id: string, owner: string): boolean {
  return id === owner || id.startsWith(`${owner}/`);
}

describe("rendered Markdown ownership", () => {
  it("never depends on the built-in AI feature", () => {
    const retained = [...filesUnder(MARKDOWN_DIR), TEXT_SHIMMER];
    const leaks = retained.flatMap((file) =>
      specifiersOf(file).flatMap((spec) => {
        const id = moduleId(spec, file);
        if (id === null) return [];
        const owner = AI_OWNED.find((candidate) => contains(id, candidate));
        return owner ? [`${path.relative(repoRoot, file)} -> ${spec}`] : [];
      }),
    );

    expect(leaks).toEqual([]);
  });

  it("has no consumer of a removed AI element alias", () => {
    const importers = filesUnder(srcRoot).flatMap((file) =>
      specifiersOf(file).flatMap((spec) => {
        const id = moduleId(spec, file);
        return id !== null && LEGACY_ENTRY_POINTS.includes(id)
          ? [`${path.relative(repoRoot, file)} -> ${spec}`]
          : [];
      }),
    );
    expect(importers).toEqual([]);
  });

  it("keeps the markdown tab kind behind its lazy boundary", () => {
    const { files, hits } = traceEager(
      "src/modules/markdown/MarkdownStackLazy.tsx",
    );
    const eager = [...files].map((file) =>
      path.relative(repoRoot, file).split(path.sep).join("/"),
    );

    expect(eager).not.toContain("src/modules/markdown/MarkdownStack.tsx");
    expect([...hits.keys()]).toEqual([]);
  });

  it("still renders through Streamdown, so that dependency cannot be dropped", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    expect(manifest.dependencies.streamdown).toBeTruthy();

    const { hits } = traceEager("src/modules/markdown/MarkdownStack.tsx", [
      "streamdown",
    ]);
    expect([...hits.keys()]).toEqual(["streamdown"]);
  });
});

// Keep the helper honest: a directory walk that silently found nothing would
// make the two graph assertions above pass by accident.
it("walks the retained Markdown sources", () => {
  expect(filesUnder(MARKDOWN_DIR).length).toBeGreaterThan(10);
  expect(statSync(TEXT_SHIMMER).isFile()).toBe(true);
});
