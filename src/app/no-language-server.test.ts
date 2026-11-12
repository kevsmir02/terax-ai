import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { traceEager } from "../../scripts/eager-graph.mjs";

// Locks the language-server removal (issue #11): configuration/code files stay
// editable through CodeMirror only, so nothing may start a server, probe PATH
// for one, or ship its client code. Assertions are over source ownership and
// the eager import graph, not over component structure.
const root = fileURLToPath(new URL("../..", import.meta.url));
const srcRoot = join(root, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(?:ts|tsx|mts|mjs)$/.test(entry) ? [full] : [];
  });
}

const rel = (file: string) => relative(root, file).replace(/\\/g, "/");

const productionFiles = walk(srcRoot).filter(
  (file) => !/\.test\.tsx?$/.test(file),
);

/** Production modules whose text matches `pattern`, as repo-relative paths. */
function mentions(pattern: RegExp): string[] {
  return productionFiles
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map(rel);
}

const LSP_NATIVE_COMMANDS =
  /\blsp_(?:spawn|detect|send|kill|host_pid|resolve_root)\b/;

// Matches the feature/UI naming, not incidental words such as
// "terminalScrollSpeed" (which contains "lSp").
const LSP_SETTINGS_UI =
  /\bLsp[A-Z]|\bLsp\b|\blsp(?:Activation|CustomServers)\b|"lsp"|language[- ]servers?/;

describe("language-server removal", () => {
  it("removes the language-server feature module", () => {
    expect(existsSync(join(srcRoot, "modules", "lsp"))).toBe(false);
  });

  it("removes language-server imports from production sources", () => {
    expect(
      mentions(
        /from\s+["'](?:@\/modules\/lsp|codemirror-languageserver|vscode-languageserver-protocol)["']/,
      ),
    ).toEqual([]);
  });

  it.each(["src/main.tsx", "src/settings/main.tsx"])(
    "keeps language-server code out of the %s startup graph",
    (entry) => {
      const { files, hits } = traceEager(entry, [
        "codemirror-languageserver",
        "vscode-languageserver-protocol",
      ]);
      expect([...hits.keys()]).toEqual([]);
      expect(
        [...files].filter((f) => /[/\\]modules[/\\]lsp[/\\]/.test(f)),
      ).toEqual([]);
    },
  );

  it("never issues a language-server native command", () => {
    expect(mentions(LSP_NATIVE_COMMANDS)).toEqual([]);
  });

  it("no longer exposes or persists language-server settings", () => {
    const settings = productionFiles
      .filter((file) => rel(file).startsWith("src/settings/"))
      .filter((file) => LSP_SETTINGS_UI.test(readFileSync(file, "utf8")))
      .map(rel);
    expect(settings).toEqual([]);
  });

  it("removes native language-server process hosting", () => {
    const rustSources = walk(join(root, "src-tauri", "src")).filter((file) =>
      /\.rs$/.test(file),
    );
    expect(
      rustSources
        .filter((file) =>
          /\bmod lsp;|\bLspState\b|lsp::/.test(readFileSync(file, "utf8")),
        )
        .map(rel),
    ).toEqual([]);
    // `which` existed only for the LSP binary/PATH probe.
    expect(
      readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8"),
    ).not.toMatch(/^which\s*=/m);
  });
});
