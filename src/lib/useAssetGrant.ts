import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { assetScopes } from "@/lib/assetScopes";
import { useWorkspaceEnvStore, workspaceScopeKey } from "@/modules/workspace";

/**
 * A view grants only its displayed file or Markdown image directory.
 *
 * The grant is owned by a *tab scope*: it is revoked when this surface unmounts
 * and again when the tab closes, so a tab that goes away does not leave a usable
 * token behind. A grant that resolves after the scope closed (a slow native
 * call finishing during a close) is revoked instead of installed, and `urlFor`
 * refuses a token whose scope is no longer live.
 */
export function useAssetGrant(
  path: string | null,
  tabId: number | null = null,
) {
  const workspace = useWorkspaceEnvStore((state) => state.env);
  const [attempt, setAttempt] = useState(0);
  const key = `${workspaceScopeKey(workspace)}:${tabId ?? ""}:${path ?? ""}:${attempt}`;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const [grant, setGrant] = useState<{
    key: string;
    scope?: string;
    token?: string;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!path) return;
    const scope = assetScopes.open(tabId);
    let disposed = false;
    let token: string | null = null;
    const revokeLate = (value: string) =>
      void invoke("asset_revoke", { token: value }).catch(console.error);
    void invoke<string>("asset_grant", { path, workspace, scope })
      .then((value) => {
        // The scope is the authority, not this closure's `disposed` flag: a
        // tab close can revoke the scope before React unmounts the surface.
        if (disposed || !assetScopes.isLive(scope)) revokeLate(value);
        else {
          token = value;
          setGrant({ key, scope, token: value });
        }
      })
      .catch((error: unknown) => {
        if (!disposed) setGrant({ key, error: String(error) });
      });
    return () => {
      disposed = true;
      if (token) revokeLate(token);
      assetScopes.close(scope);
    };
  }, [path, workspace, key, tabId]);
  const tokenFor = useMemo(
    () => () =>
      grant?.key === key &&
      grant.token &&
      grant.scope &&
      assetScopes.isLive(grant.scope)
        ? grant.token
        : undefined,
    [grant, key],
  );
  const urlFor = useMemo(
    () => (asset: string) => {
      const token = tokenFor();
      return token ? `${convertFileSrc(asset)}?token=${token}` : undefined;
    },
    [tokenFor],
  );
  return {
    urlFor,
    /**
     * The grant's capability, for a surface that reads the bytes through IPC
     * instead of an element (the PDF reader). Same scope liveness as `urlFor`.
     */
    tokenFor,
    error: grant?.key === key ? grant.error : undefined,
    retry,
  };
}
