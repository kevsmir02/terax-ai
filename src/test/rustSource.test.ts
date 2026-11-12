/**
 * The parsers every cross-language contract test depends on.
 *
 * If these are lenient, every contract test built on them is lenient too: a
 * misspelled struct name would yield an empty field list, and an assertion
 * comparing that empty list to an empty expectation would pass while the real
 * contract drifted. So the failure modes are asserted here once.
 */

import { describe, expect, it } from "vitest";
import {
  camelFieldName,
  readRepoFile,
  rustEnum,
  rustStructFields,
  wireName,
} from "./rustSource";

const checkpointRust = readRepoFile("src-tauri/src/modules/git/checkpoint.rs");

describe("rustStructFields", () => {
  it("reads the producer's fields in declaration order", () => {
    // The independent source of truth is the Rust file itself; this pins the
    // parser against a struct whose shape is also asserted by the contract
    // test that owns it.
    expect(rustStructFields(checkpointRust, "OwnedRecoveryRefs")).toEqual([
      "total",
      "manual",
      "turns",
      "safety",
      "sample",
    ]);
  });

  it("throws instead of returning no fields when the struct is missing", () => {
    // A typo in a test must fail, not pass with an empty comparison.
    expect(() => rustStructFields(checkpointRust, "NotAStruct")).toThrow(
      "struct NotAStruct not found in the Rust source",
    );
  });
});

describe("rustEnum", () => {
  it("reads the variants and the declared serde convention", () => {
    expect(rustEnum(checkpointRust, "RecoveryKind")).toEqual({
      rename: "camelCase",
      variants: ["Manual", "Turn", "Safety"],
    });
  });

  it("throws when the enum is missing, and when a required convention is absent", () => {
    expect(() => rustEnum(checkpointRust, "NotAnEnum")).toThrow(
      "enum NotAnEnum not found in the Rust source",
    );
    const source = "pub enum Bare {\n    One,\n}\n";
    expect(rustEnum(source, "Bare")).toEqual({
      rename: null,
      variants: ["One"],
    });
    expect(() => rustEnum(source, "Bare", { requireRenameAll: true })).toThrow(
      "enum Bare declares no rename_all",
    );
  });
});

describe("wireName", () => {
  it("spells a variant the way serde would", () => {
    expect(wireName("FileTooLarge", "kebab-case")).toBe("file-too-large");
    expect(wireName("Quota", "lowercase")).toBe("quota");
    expect(wireName("RecoveryRefs", "camelCase")).toBe("recoveryRefs");
    expect(wireName("FileTooLarge", "snake_case")).toBe("file_too_large");
    expect(() => wireName("Quota", "title-case")).toThrow(
      "unsupported rename convention title-case",
    );
  });
});

describe("camelFieldName", () => {
  it("maps a snake_case field to its TypeScript spelling", () => {
    expect(camelFieldName("shared_objects")).toBe("sharedObjects");
    expect(camelFieldName("loose_kib")).toBe("looseKib");
    expect(camelFieldName("total")).toBe("total");
  });
});
