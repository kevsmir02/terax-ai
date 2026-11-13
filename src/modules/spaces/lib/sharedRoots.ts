import type { SpaceMeta } from "./store";

export type SharedRoot = {
  root: string;
  spaceIds: string[];
  names: string[];
};

/** Folder identity as saved: both separators and trailing ones are one path. */
export function normalizeSpaceRoot(root: string): string {
  const slashed = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return slashed === "" ? "/" : slashed;
}

/**
 * Groups Spaces whose saved project root is the same folder. This is textual
 * identity of the saved root, not a filesystem check: symlinked or differently
 * spelled paths can still reach the same directory, and saying so would promise
 * more than Spaces mean.
 */
export function sharedRoots(spaces: readonly SpaceMeta[]): SharedRoot[] {
  const groups = new Map<string, SharedRoot>();
  for (const space of spaces) {
    if (!space.root) continue;
    const root = normalizeSpaceRoot(space.root);
    const group = groups.get(root);
    if (group) {
      group.spaceIds.push(space.id);
      group.names.push(space.name);
    } else {
      groups.set(root, {
        root,
        spaceIds: [space.id],
        names: [space.name],
      });
    }
  }
  return [...groups.values()].filter((group) => group.spaceIds.length > 1);
}

export function sharedRootFor(
  spaces: readonly SpaceMeta[],
  spaceId: string,
): SharedRoot | null {
  return (
    sharedRoots(spaces).find((group) => group.spaceIds.includes(spaceId)) ??
    null
  );
}

export function sharedRootWarning(
  root: string,
  names: readonly string[],
): string {
  const others = names.length > 1 ? names.join(", ") : (names[0] ?? root);
  return `Spaces organize tabs only. Files and processes are shared: ${others} all use ${root}. Open a worktree for a separate file tree.`;
}
