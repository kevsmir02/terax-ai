/**
 * Reading the Rust producer's source in a cross-language contract test.
 *
 * The application's wire contracts (blocker names, report fields, enum
 * variants) are produced by Rust and mirrored by TypeScript. A contract test
 * has to compare the two, so it parses the Rust declaration instead of
 * restating its values in a second place: a rename then fails the test rather
 * than rendering an unknown field as "nothing to report".
 *
 * Every parser here throws when the declaration is missing. A silent empty
 * result would turn a renamed struct into a passing test that asserts nothing,
 * which is worse than the drift it was meant to catch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Repository root, resolved from this file's own location (`src/test`). */
export const repoRoot = join(import.meta.dirname, "../..");

/** One repository file as text, relative to the root. */
export function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

export type RustEnum = {
  /** The `rename_all` convention serde declares, or `null` when absent. */
  rename: string | null;
  /** Variant names in declaration order, as spelled in Rust. */
  variants: string[];
};

export type RustWireEnum = { rename: string; variants: string[] };

/**
 * Variants of a Rust `pub enum`, with the serde `rename_all` it declares.
 *
 * `requireRenameAll` is for contracts where the wire spelling is the point: a
 * missing convention would make every variant's on-wire name unverifiable, so
 * the caller gets a non-null convention (or a throw) instead of a maybe.
 */
export function rustEnum(
  source: string,
  name: string,
  options: { requireRenameAll: true },
): RustWireEnum;
export function rustEnum(
  source: string,
  name: string,
  options?: { requireRenameAll?: false },
): RustEnum;
export function rustEnum(
  source: string,
  name: string,
  options: { requireRenameAll?: boolean } = {},
): RustEnum {
  const block = new RegExp(
    `(?:#\\[serde\\(([^)]*)\\)\\]\\s*)?pub enum ${name} \\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  if (!block) throw new Error(`enum ${name} not found in the Rust source`);
  const rename =
    /rename_all = "([A-Za-z-]+)"/.exec(block[1] ?? "")?.[1] ?? null;
  if (options.requireRenameAll && !rename) {
    throw new Error(`enum ${name} declares no rename_all`);
  }
  const variants = [
    ...(block[2] ?? "").matchAll(/^\s{4}([A-Z][A-Za-z]*),/gm),
  ].map((match) => match[1] ?? "");
  return { rename, variants };
}

/**
 * Variant names as they appear on the wire, under the enum's declared serde
 * convention.
 */
export function rustEnumWireNames(source: string, name: string): string[] {
  const { rename, variants } = rustEnum(source, name, {
    requireRenameAll: true,
  });
  return variants.map((variant) => wireName(variant, rename));
}

/**
 * The `pub` fields of a Rust struct, in declaration order.
 *
 * Field names are the serialized names when the struct uses
 * `rename_all = "camelCase"`; that convention is what makes the TypeScript
 * mirror a straight copy. A field with an explicit `#[serde(rename = …)]`
 * keeps its Rust name here, so a rename is not silently invisible.
 */
export function rustStructFields(source: string, name: string): string[] {
  const block = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`).exec(
    source,
  );
  if (!block) throw new Error(`struct ${name} not found in the Rust source`);
  return [...(block[1] ?? "").matchAll(/^\s{4}pub (\w+):/gm)].map(
    (match) => match[1] ?? "",
  );
}

/** The string serde derives for a variant under a `rename_all` convention. */
export function wireName(variant: string, rename: string): string {
  switch (rename) {
    case "kebab-case":
      return variant.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    case "snake_case":
      return variant.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    case "camelCase":
      return variant[0]?.toLowerCase() + variant.slice(1);
    case "lowercase":
      return variant.toLowerCase();
    case "UPPERCASE":
      return variant.toUpperCase();
    default:
      throw new Error(`unsupported rename convention ${rename}`);
  }
}

/** The TypeScript spelling of a snake_case Rust field. */
export function camelFieldName(field: string): string {
  return field.replace(/_([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}
