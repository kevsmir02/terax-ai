/**
 * Guard for the recovery module's non-negotiable boundary: it stores text and
 * hands it back to the editor buffer. It never runs a command, never touches the
 * network, and never writes a project file — Save As goes through the editor's
 * ordinary explicit-save path, to a path the user typed.
 *
 * Static on purpose: the claim is about what the code cannot do, and a future
 * import of a shell or write command is exactly what a behavior test would miss
 * until the wrong branch ran.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const here = import.meta.dirname;
const repoRoot = path.resolve(here, "../../../../..");

function sources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .filter((name) => !name.endsWith(".test.ts") && !name.endsWith(".test.tsx"))
    .map((name) => ({
      file: name,
      text: readFileSync(path.join(dir, name), "utf8"),
    }));
}

describe("recovery never executes or writes project files", () => {
  it("does not import a shell, command, network or project-write surface", () => {
    const forbidden = [
      "shell_run_command",
      "shellRunCommand",
      "fs_write_file",
      "fs_delete",
      "fs_rename",
      "pty_",
      "child_process",
      "Command::new",
      "fetch(",
    ];
    for (const { file, text } of sources(here)) {
      for (const needle of forbidden) {
        expect(text.includes(needle), `${file} contains ${needle}`).toBe(false);
      }
    }
  });

  it("keeps the native store confined to its own directory", () => {
    const native = readFileSync(
      path.join(repoRoot, "src-tauri/src/modules/recovery.rs"),
      "utf8",
    );
    // Only the production half: the test module writes fixture files on
    // purpose to prove a corrupt record is skipped.
    const production = native.split("#[cfg(test)]")[0];
    for (const needle of ["Command::new", "shell_run_command", "fs::write("]) {
      expect(
        production.includes(needle),
        `native recovery contains ${needle}`,
      ).toBe(false);
    }
    // Every durable write goes through the private atomic helper.
    expect(production).toContain("write_private_atomic");
  });
});
