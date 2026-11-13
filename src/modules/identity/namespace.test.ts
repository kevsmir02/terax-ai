import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The names of this fork live in `namespace.json` (see modules::identity on the Rust
// side and scripts/linux_profile.py for the runners). This test locks the literals a
// build tool forces us to duplicate against that table, so a rename cannot silently
// leave one of them pointing at the upstream identity.
const root = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const readJson = <T>(path: string) => JSON.parse(read(path)) as T;

interface NamespaceTable {
  provisional: boolean;
  appIdentifier: string;
  namespace: string;
  envPrefix: string;
  packaging: {
    productName: string;
    vendor: string;
    packageName: string;
    cliBinaryName: string;
  };
  upstream: {
    appIdentifier: string;
    namespace: string;
    envPrefix: string;
    productName: string;
    publisher: string;
  };
}

const table = readJson<NamespaceTable>("src/modules/identity/namespace.json");

describe("fork identity namespace", () => {
  it("is a provisional identity distinct from upstream", () => {
    expect(table.provisional).toBe(true);
    expect(table.appIdentifier).not.toBe(table.upstream.appIdentifier);
    expect(table.appIdentifier.startsWith(table.upstream.appIdentifier)).toBe(
      false,
    );
    expect(table.namespace).not.toBe(table.upstream.namespace);
    expect(table.envPrefix).not.toBe(table.upstream.envPrefix);
  });

  it("does not adopt upstream's product or publisher name", () => {
    // The package metadata is what a distribution index shows. Reading a value from the identity
    // table is not enough if the value itself is upstream's: that is a silent upstream migration
    // (issue #40, acceptance 2), not an import.
    expect(table.packaging.productName).not.toBe(table.upstream.productName);
    expect(table.packaging.vendor).not.toBe(table.upstream.publisher);
    expect(table.packaging.packageName).toBe(table.namespace);
    expect(
      table.packaging.cliBinaryName.startsWith(`${table.namespace}-`),
    ).toBe(true);
  });

  it("matches the Tauri config literal", () => {
    const config = readJson<{ identifier: string }>(
      "src-tauri/tauri.conf.json",
    );
    expect(config.identifier).toBe(table.appIdentifier);
  });

  it("is the data directory the shared path policy refuses to readers", () => {
    const policy = readJson<{ protectedDirs: string[] }>(
      "src/modules/workspace/pathPolicy.json",
    );
    const dataDir = `/.local/share/${table.appIdentifier.toLowerCase()}`;
    expect(policy.protectedDirs).toContain(dataDir);
    // Upstream's data directory stays refused too: this application never reads it.
    expect(policy.protectedDirs).toContain(
      `/.local/share/${table.upstream.appIdentifier}`,
    );
  });

  it("is the cache namespace the runners treat as disposable", () => {
    // scripts/linux_profile.py reads the same table instead of hardcoding a product
    // identifier or an upstream namespace (see scripts/tests/test_linux_profile.py).
    const profile = read("scripts/linux_profile.py");
    expect(profile).toContain("namespace.json");
    expect(profile).not.toContain(
      `PRODUCT_IDENTIFIER = "${table.upstream.appIdentifier}"`,
    );
  });
});
