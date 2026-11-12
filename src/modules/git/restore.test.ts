import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatRestoreEffect,
  manualRestoreMessage,
  restorableRecoveryRefs,
  restorePrecondition,
} from "./restore";
import type {
  CheckpointGroups,
  ManualCheckpoint,
  ManualRestorePreview,
  ManualRestoreRefusal,
  ManualRestoreReport,
  RestoreEffect,
  RestoreFailureStage,
  SafetyRef,
} from "./types";

const root = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Variants of a `#[serde(rename_all = "camelCase")]` Rust enum, in TS spelling. */
function rustEnumVariants(source: string, name: string): string[] {
  const body =
    new RegExp(`pub enum ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ??
    "";
  return [...body.matchAll(/^\s{4}([A-Z][A-Za-z]*),/gm)]
    .map((match) => {
      const variant = match[1] ?? "";
      return variant[0]?.toLowerCase() + variant.slice(1);
    })
    .sort();
}

const manual = (id: string, name: string | null): ManualCheckpoint => ({
  ref: `refs/terax-workspace/manual-checkpoints/${id}`,
  id,
  name,
  commit: "c",
  tree: "t",
  parent: null,
  createdAtSecs: 1,
  capture: null,
});

const safety = (taskId: string, millis: number): SafetyRef => ({
  ref: `refs/terax-workspace/checkpoints/${taskId}/prerestore-${millis}`,
  taskId,
  commit: "c",
  tree: "t",
  parent: null,
  createdAtSecs: 1,
});

const groups = (
  manualCheckpoints: ManualCheckpoint[],
  safetyRefs: SafetyRef[] = [],
): CheckpointGroups => ({
  manual: manualCheckpoints,
  turns: [],
  safety: safetyRefs,
  storage: {
    looseObjects: 1,
    looseKib: 1,
    packedObjects: 0,
    packedKib: 0,
    ownedRefs: manualCheckpoints.length + safetyRefs.length,
    sharedObjects: true,
  },
});

const preview = (
  overrides: Partial<ManualRestorePreview> = {},
): ManualRestorePreview => ({
  ref: "refs/terax-workspace/manual-checkpoints/a",
  kind: "manual",
  name: "before refactor",
  commit: "c",
  tree: "t",
  parent: null,
  headMoved: false,
  headEffect: "unchanged",
  affected: [
    {
      path: "src/a.ts",
      status: "modified",
      effect: "written",
      staged: false,
      ignoredInTheWay: false,
    },
  ],
  affectedTotal: 1,
  affectedTruncated: false,
  skipped: [],
  stagedTotal: 0,
  stagedTruncated: false,
  ignoredInTheWay: 0,
  requiresSafetyCapture: true,
  capturesIndexState: false,
  capturesIgnoredFiles: false,
  atomic: false,
  fingerprint: "f",
  refusal: null,
  refusalDetail: null,
  ...overrides,
});

const report = (
  overrides: Partial<ManualRestoreReport> = {},
): ManualRestoreReport => ({
  restored: true,
  refusal: null,
  refusalDetail: null,
  kind: "manual",
  contentOnly: false,
  affected: preview().affected,
  affectedTotal: 1,
  skipped: [],
  stagedTotal: 0,
  written: 1,
  removed: 0,
  safety: { ref: "safety-ref", commit: "c", tree: "t" },
  safetyRetained: true,
  capturesIndexState: false,
  indexSynced: true,
  headEffect: "unchanged",
  headMoved: false,
  atomic: false,
  captureConsistent: true,
  captureWarnings: [],
  partial: false,
  failure: null,
  failureStage: null,
  retryRequiresFreshPreview: false,
  ...overrides,
});

describe("restore preconditions", () => {
  it("requires resolution of staged affected paths before opening a confirmation", () => {
    const refusal = restorePrecondition(
      preview({
        refusal: "stagedAffectedPaths",
        stagedTotal: 1,
        refusalDetail: "one affected path is staged",
      }),
    );
    expect(refusal).toContain("staged");
    expect(refusal).toContain("one affected path is staged");
  });

  it("treats a stale preview and a per-turn checkpoint as refusals", () => {
    expect(restorePrecondition(preview({ refusal: "stalePreview" }))).toContain(
      "fresh preview",
    );
    expect(
      restorePrecondition(preview({ refusal: "unsupportedCheckpointKind" })),
    ).toContain("retained");
    expect(restorePrecondition(preview())).toBeNull();
  });

  it("lists manual checkpoints and safety refs as restorable, never turns", () => {
    const restorable = restorableRecoveryRefs(
      groups([manual("a", "one")], [safety("a", 5)]),
    );
    expect(restorable.map((entry) => entry.ref)).toEqual([
      "refs/terax-workspace/manual-checkpoints/a",
      "refs/terax-workspace/checkpoints/a/prerestore-5",
    ]);
    expect(restorable.map((entry) => entry.kind)).toEqual(["manual", "safety"]);
  });

  it("names the effect on a path and the ignored-file exception", () => {
    const path = {
      path: "src/a.ts",
      status: "modified" as const,
      effect: "written" as const,
      staged: false,
      ignoredInTheWay: false,
    };
    expect(formatRestoreEffect(path)).toBe("restored");
    expect(
      formatRestoreEffect({
        ...path,
        effect: "removed",
        path: "gone.ts",
      }),
    ).toBe("removed");
  });
});

describe("restore result copy", () => {
  it("reports success with the safety ref and never claims a Git-state undo", () => {
    const message = manualRestoreMessage(report());
    expect(message).toContain("src/a.ts");
    expect(message).toContain("safety-ref");
    expect(message).toContain("HEAD is unchanged");
    expect(message).toContain("not a Git-state undo");
  });

  it("reports partial effects, the retained safety ref and the fresh-preview rule", () => {
    const message = manualRestoreMessage(
      report({
        restored: false,
        partial: true,
        written: 0,
        removed: 1,
        failure: "a later restore step failed",
        failureStage: "writes",
        retryRequiresFreshPreview: true,
      }),
    );
    expect(message).toContain("partially");
    expect(message).toContain("a later restore step failed");
    expect(message).toContain("safety-ref");
    expect(message).toContain("fresh preview");
  });

  it("labels safety-ref recovery as content recovery, not index restoration", () => {
    const message = manualRestoreMessage(
      report({ kind: "safety", contentOnly: true }),
    );
    expect(message).toContain("content was recovered");
    expect(message).toContain("staging is not restored");
  });

  it("reports a refusal without claiming that anything changed", () => {
    const message = manualRestoreMessage(
      report({
        restored: false,
        safety: null,
        refusal: "stalePreview",
        refusalDetail: "the working tree changed after this preview",
      }),
    );
    expect(message).toContain("Nothing was changed");
    expect(message).toContain("the working tree changed after this preview");
  });
});

describe("cross-language restore contracts", () => {
  const source = read("src-tauri/src/modules/git/checkpoint.rs");

  it("keeps the Rust refusal enum and the TS union in step", () => {
    const union: ManualRestoreRefusal[] = [
      "stagedAffectedPaths",
      "stalePreview",
      "unsupportedCheckpointKind",
    ];
    expect(rustEnumVariants(source, "ManualRestoreRefusal")).toEqual(
      [...union].sort(),
    );
  });

  it("keeps the Rust effect and failure-stage enums in step", () => {
    const effects: RestoreEffect[] = ["written", "removed"];
    const stages: RestoreFailureStage[] = ["writes", "indexSync"];
    expect(rustEnumVariants(source, "RestoreEffect")).toEqual(
      [...effects].sort(),
    );
    expect(rustEnumVariants(source, "RestoreFailureStage")).toEqual(
      [...stages].sort(),
    );
  });
});
