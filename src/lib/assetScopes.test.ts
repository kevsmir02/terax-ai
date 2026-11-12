import { describe, expect, it } from "vitest";
import { AssetScopeRegistry } from "./assetScopes";

function registry() {
  const revoked: string[] = [];
  return {
    revoked,
    scopes: new AssetScopeRegistry((scope) => revoked.push(scope)),
  };
}

describe("asset scope registry", () => {
  it("keeps one tab's scopes independent of another's", () => {
    const { revoked, scopes } = registry();
    const first = scopes.open(1);
    const second = scopes.open(2);

    scopes.closeTab(1);

    expect(scopes.isLive(first)).toBe(false);
    expect(scopes.isLive(second)).toBe(true);
    expect(revoked).toEqual([first]);
    scopes.closeTab(2);
    expect(revoked).toEqual([first, second]);
    expect(scopes.size).toBe(0);
  });

  it("revokes every scope a tab opened", () => {
    const { revoked, scopes } = registry();
    const markdown = scopes.open(7);
    const media = scopes.open(7);
    scopes.closeTab(7);
    expect(revoked.sort()).toEqual([markdown, media].sort());
    expect(scopes.size).toBe(0);
  });

  it("revokes a scope once, even if it is closed twice", () => {
    const { revoked, scopes } = registry();
    const scope = scopes.open(null);
    scopes.close(scope);
    scopes.close(scope);
    scopes.closeTab(3);
    expect(revoked).toEqual([scope]);
  });

  it("never revokes a scope it did not open", () => {
    const { revoked, scopes } = registry();
    scopes.close("asset-scope-404");
    expect(revoked).toEqual([]);
  });

  it("reports a closed scope as stale so a late grant cannot install", () => {
    const { scopes } = registry();
    const scope = scopes.open(1);
    expect(scopes.isLive(scope)).toBe(true);
    scopes.closeTab(1);
    expect(scopes.isLive(scope)).toBe(false);
    // A remount gets a fresh scope: the old one never comes back to life.
    const reopened = scopes.open(1);
    expect(reopened).not.toBe(scope);
    expect(scopes.isLive(reopened)).toBe(true);
  });

  it("does not track scopes opened without a tab", () => {
    const { revoked, scopes } = registry();
    const scope = scopes.open(null);
    scopes.closeTab(1);
    expect(scopes.isLive(scope)).toBe(true);
    scopes.close(scope);
    expect(revoked).toEqual([scope]);
  });

  it("keeps the tab map bounded once scopes close", () => {
    const { scopes } = registry();
    for (let index = 0; index < 5; index += 1) {
      scopes.open(index);
      scopes.closeTab(index);
    }
    expect(scopes.size).toBe(0);
  });
});
