import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { assetScopes } from "@/lib/assetScopes";
import { useWorkspaceEnvStore, workspaceScopeKey } from "@/modules/workspace";

type GrantState = {
  key: string;
  scope?: string;
  /** Native tokens, keyed by the path whose grant produced them. */
  tokens?: Record<string, string>;
  error?: string;
};

function normalized(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** True when `asset` is the granted file or lies beneath a granted folder. */
function covers(grantPath: string, asset: string): boolean {
  const root = normalized(grantPath);
  const target = normalized(asset);
  const caseInsensitive = /^[a-zA-Z]:/.test(root);
  const a = caseInsensitive ? target.toLowerCase() : target;
  const r = caseInsensitive ? root.toLowerCase() : root;
  return a === r || a.startsWith(`${r}/`);
}

/**
 * A view grants only the paths it draws content from.
 *
 * Every grant is owned by *one tab scope*: it is revoked when this surface
 * unmounts and again when the tab closes, so a tab that goes away does not
 * leave a usable token behind. A grant that resolves after the scope closed (a
 * slow native call finishing during a close) is revoked instead of installed,
 * and `urlFor` refuses a token whose scope is no longer live.
 *
 * Multiple paths share the scope because a Markdown document draws from its
 * boundary directory plus the individual outside files the person explicitly
 * allowed. A failed grant does not discard the others; the error is reported so
 * the pane can explain the missing image.
 */
export function useAssetGrants(
  paths: readonly (string | null | undefined)[],
  tabId: number | null = null,
) {
  const workspace = useWorkspaceEnvStore((state) => state.env);
  const [attempt, setAttempt] = useState(0);
  const list = [...new Set(paths.filter((path): path is string => !!path))];
  const listKey = list.join("\u0000");
  const key = `${workspaceScopeKey(workspace)}:${tabId ?? ""}:${listKey}:${attempt}`;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const [grant, setGrant] = useState<GrantState | null>(null);
  // Bumped whenever the native grant set changes, so a surface can remount the
  // rendered content (Streamdown memoizes on the text, not on the URL policy).
  const [version, setVersion] = useState(0);

  // `list` is reconstructed every render; `listKey` is its identity, so the
  // effect runs only when the set of paths (or the tab/workspace) changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listKey is `list`.
  useEffect(() => {
    if (list.length === 0) return;
    const scope = assetScopes.open(tabId);
    let disposed = false;
    const tokens: Record<string, string> = {};
    const revokeLate = (value: string) =>
      void invoke("asset_revoke", { token: value }).catch(console.error);

    void Promise.all(
      list.map(async (path) => {
        try {
          const token = await invoke<string>("asset_grant", {
            path,
            workspace,
            scope,
          });
          // The scope is the authority, not this closure's `disposed` flag: a
          // tab close can revoke the scope before React unmounts the surface.
          if (disposed || !assetScopes.isLive(scope)) {
            revokeLate(token);
            return null;
          }
          tokens[path] = token;
          return null;
        } catch (error: unknown) {
          return String(error);
        }
      }),
    ).then((results) => {
      if (disposed || !assetScopes.isLive(scope)) return;
      const error = results.find((result): result is string => !!result);
      setVersion((value) => value + 1);
      setGrant({
        key,
        scope,
        tokens: { ...tokens },
        ...(error ? { error } : {}),
      });
    });

    return () => {
      disposed = true;
      for (const token of Object.values(tokens)) revokeLate(token);
      assetScopes.close(scope);
    };
  }, [listKey, workspace, key, tabId]);

  const urlFor = useMemo(
    () => (asset: string) => {
      if (
        !grant?.key ||
        grant.key !== key ||
        !grant.tokens ||
        !grant.scope ||
        !assetScopes.isLive(grant.scope)
      ) {
        return undefined;
      }
      // An exact file grant wins; otherwise the first granted folder that
      // contains the asset.
      const exact = grant.tokens[asset];
      const token =
        exact ??
        Object.entries(grant.tokens).find(([grantPath]) =>
          covers(grantPath, asset),
        )?.[1];
      return token ? `${convertFileSrc(asset)}?token=${token}` : undefined;
    },
    [grant, key],
  );

  return {
    urlFor,
    error: grant?.key === key ? grant.error : undefined,
    /** Changes when the native grant set changes (tokens, retry, refusal). */
    version: grant?.key === key ? version : 0,
    retry,
  };
}

/**
 * The single-path form used by surfaces that draw exactly one file or folder
 * (the editor's media preview). Markdown uses {@link useAssetGrants}.
 */
export function useAssetGrant(
  path: string | null,
  tabId: number | null = null,
) {
  return useAssetGrants([path], tabId);
}
