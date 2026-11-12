/**
 * The worktree creation form's pure half.
 *
 * The native preflight (`git_worktree_preflight`) is the authority on what git
 * accepts: this module only turns the form into its request, keeps the obvious
 * syntax errors from reaching the command, and explains the native report.
 * A blank field becomes `null`, never `""`, because the command treats an empty
 * string as "not provided" in a few places and a path of "" as unsafe.
 */

import type {
  WorktreeAdded,
  WorktreeProblem,
  WorktreeProblemField,
} from "@/modules/git/types";

/** How the workspace registry grants access to a folder (native `Access`). */
export type WorktreeAccess = "root" | "derived" | "covered" | "none";

export type WorktreeCreateForm = {
  location: "managed" | "custom";
  taskSlug: string;
  path: string;
  branchMode: "newBranch" | "existingBranch" | "detach";
  branchName: string;
  base: string;
  /** Comma or whitespace separated ignored-file globs. */
  include: string;
};

export const initialWorktreeForm: WorktreeCreateForm = {
  location: "managed",
  taskSlug: "",
  path: "",
  branchMode: "newBranch",
  branchName: "",
  base: "",
  include: "",
};

const MAX_INCLUDE_PATTERNS = 64;
const MAX_PATTERN_BYTES = 256;

const problem = (
  field: WorktreeProblemField,
  message: string,
): WorktreeProblem => ({ field, message });

/** Globs, not shell words: only commas and whitespace separate patterns. */
export function parseIncludeInput(text: string): string[] {
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const part of text.split(/[\s,]+/)) {
    const pattern = part.trim();
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push(pattern);
  }
  return patterns;
}

function includeProblem(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_BYTES)
    return `${pattern.slice(0, 40)}… is longer than ${MAX_PATTERN_BYTES} characters`;
  if (/[\u0000-\u001f\u007f]/.test(pattern))
    return "patterns cannot contain control characters";
  if (
    pattern.startsWith("!") ||
    pattern.startsWith("/") ||
    pattern.startsWith("\\")
  )
    return `${pattern} must be relative to the repository`;
  if (/^[A-Za-z]:/.test(pattern))
    return `${pattern} is a drive path, not a repository-relative glob`;
  if (pattern.includes("\\")) return `${pattern} must use forward slashes`;
  const parts = pattern.split("/");
  for (const [index, part] of parts.entries()) {
    if (part === ".." || part === ".")
      return `${pattern} leaves the repository`;
    if (part.toLowerCase() === ".git")
      return `${pattern} names git internals, which are never copied`;
    if (part === "" && index !== parts.length - 1)
      return `${pattern} has an empty path component`;
  }
  return null;
}

/** Branch syntax git's `check-ref-format` rejects; the native check stays final. */
function branchProblem(name: string): string | null {
  if (!name) return "Name the branch.";
  if (name.length > 255) return "The branch name is too long.";
  if (/\s/.test(name)) return "Branch names cannot contain spaces.";
  if (/[\u0000-\u001f\u007f]/.test(name))
    return "Branch names cannot contain control characters.";
  if (name.startsWith("-")) return "Branch names cannot start with -.";
  if (name.startsWith("/") || name.endsWith("/"))
    return "Branch names cannot start or end with /.";
  if (name.endsWith(".")) return "Branch names cannot end with a dot.";
  if (name.includes("..")) return "Branch names cannot contain ..";
  if (name.includes("@{")) return "Branch names cannot contain @{";
  if (name.includes("//")) return "Branch names cannot contain //";
  if (/[~^:?*[\\]/.test(name))
    return "Branch names cannot contain ~ ^ : ? * [ or \\.";
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return "A branch path cannot start with a dot.";
    if (part.endsWith(".lock")) return "A branch path cannot end with .lock.";
  }
  return null;
}

/** A revision handed to `git rev-parse` as one argument, never an option. */
function baseProblem(rev: string): string | null {
  if (!rev) return null;
  if (rev.length > 255) return "The start point is too long.";
  if (/\s/.test(rev)) return "The start point cannot contain spaces.";
  if (/[\u0000-\u001f\u007f]/.test(rev))
    return "The start point cannot contain control characters.";
  if (rev.startsWith("-")) return "The start point cannot start with -.";
  if (rev.includes("..")) return "The start point cannot contain ..";
  return null;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function pathProblem(form: WorktreeCreateForm): string | null {
  const name = form.taskSlug.trim();
  if (form.location === "managed") {
    if (!name) return "Name the worktree; it becomes its folder.";
    if (name.includes("/") || name.includes("\\"))
      return "The folder name cannot contain a path separator.";
    return null;
  }
  const path = form.path.trim();
  if (!path) return "Choose an absolute path for the worktree.";
  if (!isAbsolutePath(path)) return "Use an absolute path.";
  if (path.split(/[\\/]/).includes("..")) return "The path cannot contain ..";
  return null;
}

/**
 * Obvious form problems, in field order. A native preflight is still needed:
 * only git knows whether the ref exists, the branch is checked out, or the
 * target directory is empty.
 */
export function localProblems(form: WorktreeCreateForm): WorktreeProblem[] {
  const problems: WorktreeProblem[] = [];
  const path = pathProblem(form);
  if (path) problems.push(problem("path", path));

  if (form.branchMode !== "detach") {
    const branch = branchProblem(form.branchName.trim());
    if (branch) problems.push(problem("branch", branch));
  }

  const base = baseProblem(form.base.trim());
  if (base) problems.push(problem("base", base));

  const include = parseIncludeInput(form.include);
  if (include.length > MAX_INCLUDE_PATTERNS) {
    problems.push(
      problem(
        "include",
        `At most ${MAX_INCLUDE_PATTERNS} ignored-file patterns are copied.`,
      ),
    );
  } else {
    for (const pattern of include) {
      const why = includeProblem(pattern);
      if (why) problems.push(problem("include", why));
    }
  }
  return problems;
}

/** One message per field: the first one is what the form shows. */
export function fieldMessages(
  problems: readonly WorktreeProblem[],
): Partial<Record<WorktreeProblemField, string>> {
  const messages: Partial<Record<WorktreeProblemField, string>> = {};
  for (const entry of problems) {
    if (!messages[entry.field]) messages[entry.field] = entry.message;
  }
  return messages;
}

export function buildWorktreeRequest(form: WorktreeCreateForm) {
  const custom = form.location === "custom";
  return {
    path: custom ? form.path.trim() : null,
    taskSlug: custom ? null : form.taskSlug.trim() || null,
    branch:
      form.branchMode === "detach"
        ? ({ mode: "detach" } as const)
        : ({
            mode: form.branchMode,
            name: form.branchName.trim(),
          } as const),
    base: form.base.trim() || null,
    include: parseIncludeInput(form.include),
  };
}

/** Why an ignored file was not copied; the native side sends these codes. */
export function skippedReasonText(reason: string): string {
  switch (reason) {
    case "already-exists":
      return "already exists in the worktree — left untouched";
    case "symlink":
      return "is a symlink, which is never followed";
    case "outside-repository":
      return "resolves outside the repository";
    case "outside-worktree":
      return "would have been written outside the new worktree";
    case "too-large":
      return "is larger than the 8 MiB per-file copy limit";
    case "budget-exceeded":
      return "is beyond the 64 MiB copy budget";
    case "file-limit":
      return "is beyond the 200-file copy limit";
    case "missing":
      return "disappeared before it could be copied";
    case "unreadable":
      return "could not be read";
    case "copy-failed":
      return "could not be written";
    case "create-dir-failed":
      return "needed a directory that could not be created";
    case "not-a-file":
      return "is not a regular file";
    case "invalid-path":
      return "is not a safe path";
    default:
      return reason;
  }
}

type CopyReport = Pick<
  WorktreeAdded,
  "copied" | "skipped" | "includeTruncated"
> & { [key: string]: unknown };

/**
 * What the ignored-file copy did, truthfully: one line per copy or skip, and a
 * limit line. No overwrite is reported because none can happen: the native copy
 * opens every destination with `create_new`.
 */
export function worktreeResultLines(result: CopyReport): string[] {
  const lines = result.copied.map((path) => `Copied ${path}`);
  for (const entry of result.skipped) {
    lines.push(
      `Did not copy ${entry.path}: ${skippedReasonText(entry.reason)}`,
    );
  }
  if (result.includeTruncated) {
    lines.push(
      "The copy limits ran out; some ignored files were not copied. Nothing was overwritten.",
    );
  }
  return lines;
}

/** The Space is named after the branch, or the folder when detached. */
export function worktreeSpaceName(
  result: Pick<WorktreeAdded, "path" | "branch">,
) {
  if (result.branch) return result.branch;
  const trimmed = result.path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

export function canOpenAsSpace(access: WorktreeAccess | null): boolean {
  return access !== null && access !== "none";
}

export function accessText(access: WorktreeAccess | null): string {
  switch (access) {
    case "root":
      return "File access: this folder is an authorized workspace root.";
    case "derived":
      return "File access: derived from the repository that created this linked worktree.";
    case "covered":
      return "File access: covered by an existing folder grant.";
    case "none":
      return "File access: this app has no access to the folder, so it cannot be opened as a Space.";
    default:
      return "File access: checking…";
  }
}
