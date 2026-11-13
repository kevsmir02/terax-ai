import { invoke } from "@tauri-apps/api/core";

/**
 * Tab-owned asset grants.
 *
 * A preview surface reports the dir it draws content from and gets a grant
 * token back. The token is only useful while the *scope* that requested it is
 * live: a tab close revokes every scope it owns in the native layer, and a grant
 * that was already in flight when the scope closed must not install a URL into
 * a tab that no longer exists. Late completions are therefore checked against
 * this registry before they reach component state, and a token that arrives too
 * late is revoked instead of used.
 *
 * Pure bookkeeping plus one thin revoke call; no React here so the lifecycle is
 * testable without a DOM.
 */

/** Revokes every native grant made under `scope`. */
export type ScopeRevoker = (scope: string) => void;

export class AssetScopeRegistry {
  private readonly live = new Set<string>();
  private readonly byTab = new Map<number, Set<string>>();
  private next = 0;

  constructor(private readonly revoke: ScopeRevoker) {}

  /** Opens a scope for one mounted preview surface. */
  open(tabId: number | null): string {
    const scope = `asset-scope-${++this.next}`;
    this.live.add(scope);
    if (tabId !== null) {
      let scopes = this.byTab.get(tabId);
      if (!scopes) {
        scopes = new Set();
        this.byTab.set(tabId, scopes);
      }
      scopes.add(scope);
    }
    return scope;
  }

  /** False once the scope was closed; a late token must not be installed. */
  isLive(scope: string): boolean {
    return this.live.has(scope);
  }

  /** Closes one scope and revokes whatever the native layer granted under it. */
  close(scope: string): void {
    if (!this.live.delete(scope)) return;
    for (const [tabId, scopes] of this.byTab) {
      scopes.delete(scope);
      if (scopes.size === 0) this.byTab.delete(tabId);
    }
    this.revoke(scope);
  }

  /** Closes every scope a tab owns (tab close, Space removal). */
  closeTab(tabId: number): void {
    const scopes = this.byTab.get(tabId);
    if (!scopes) return;
    for (const scope of [...scopes]) this.close(scope);
  }

  /** Number of open scopes; exposed for tests and leak assertions. */
  get size(): number {
    return this.live.size;
  }
}

export const assetScopes = new AssetScopeRegistry((scope) => {
  void invoke("asset_revoke_scope", { scope }).catch((error: unknown) => {
    console.error("asset_revoke_scope failed:", error);
  });
});
