/**
 * Shared secret-path policy for automatic access to local files.
 *
 * Goal: no *automatic* path (agent read tools, markdown/media preview) may
 * silently reach files that almost always contain credentials (.env*, *.pem,
 * id_rsa*, .aws/credentials, .ssh/, .git/, kube/azure config, …) or write into
 * system directories.
 *
 * This is a *defense layer*, not a sandbox, and it is deliberately **not**
 * applied to explicit user actions: `fs_read_file`/`fs_write_file` (the
 * CodeMirror editor, theme files, markdown source) keep working on these paths
 * and outside the project root. Only automatic consumers call in here.
 *
 * Retained consumers:
 *  - `src/modules/markdown/MarkdownContent.tsx` (preview image filter)
 *  - `src/modules/markdown/lib/assetPath.ts` (documented boundary)
 * The native side reads the *same* data file (`src-tauri/src/modules/fs/
 * access_policy.rs`), so `pathPolicy.json` is the single place a future
 * namespace/identifier change (ticket #8) has to follow.
 *
 * Defense-in-depth notes:
 *  - Comparison surface is lowercased *only for matching*. Original path is
 *    preserved for basename pattern checks and error messages.
 *  - Windows drive prefix (e.g. `C:`) is stripped from the comparison form so
 *    Unix-style root prefix checks behave consistently on both platforms.
 *  - Protected directories match exact-equal-or-descendant, not raw
 *    substring-with-trailing-slash. Bare names (`/Users/me/.ssh`) and
 *    case-variants (`/Users/me/.SSH/config` on macOS/Windows case-insensitive
 *    filesystems) are caught.
 *  - The caller is expected to additionally validate the *canonical* path
 *    (post symlink resolution) via `checkReadableCanonical`, since a symlink at
 *    an "innocent" path can point into a protected directory.
 */

import pathPolicy from "./pathPolicy.json";

const SECRET_BASENAME_PATTERNS = pathPolicy.secretBasenames.map(
  (pattern) => new RegExp(pattern, "i"),
);
const PROTECTED_DIRS = pathPolicy.protectedDirs;

/**
 * Write-only deny prefixes (system locations). Read access is *not* universally
 * blocked — reading `/etc/hosts` is fine; writing to it isn't.
 */
const WRITE_DENY_PREFIXES = [
  "/etc/",
  "/var/db/",
  "/var/root/",
  "/system/", // case-folded from /System/
  "/library/keychains/",
  "/library/launchagents/",
  "/library/launchdaemons/",
  "/private/etc/",
  "/private/var/db/",
  "/usr/bin/",
  "/usr/sbin/",
  "/usr/local/bin/",
  "/bin/",
  "/sbin/",
  "/boot/",
  // Windows (post drive-strip + lowercase). Note: these block writes to the
  // system drive's Windows / Program Files. Drives are stripped, so any
  // /windows/... etc. matches regardless of drive letter.
  "/windows/",
  "/program files/",
  "/program files (x86)/",
  "/programdata/",
];

export type SafetyResult = { ok: true } | { ok: false; reason: string };

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Build a normalized *comparison surface* — never used as a real path:
 *  - back-slashes -> forward-slashes
 *  - strip Windows drive prefix (e.g. `C:`)
 *  - strip UNC prefix `//?/`
 *  - strip NTFS alternate-data-stream suffix (`name:stream` / `name::$DATA`)
 *    from each path segment — Windows reads `foo:stream` as `foo` for our
 *    purposes, so the comparison surface should too
 *  - strip trailing dots/spaces from each segment — Windows discards these
 *    at open time, so `.env.` and `.env ` open `.env`
 *  - collapse duplicate slashes
 *  - lowercase (so case variants match on case-insensitive filesystems)
 *  - drop trailing slash (except for root)
 */
function comparisonForm(p: string): string {
  let s = p.replace(/\\/g, "/");
  // UNC / extended-length prefix: \\?\C:\... or //?/C:/... → strip up to drive.
  s = s.replace(/^\/\/\?\//, "/");
  // Drive prefix: C:/foo → /foo. Important: do this BEFORE lowercasing so we
  // don't have to special-case "c:" vs "C:".
  s = s.replace(/^[a-zA-Z]:/, "");
  // Strip NTFS alternate-data-stream syntax from each segment. `name:stream`
  // and `name::$DATA` both read the same underlying file from `name`, so
  // they must compare-equal to `name`.
  s = s
    .split("/")
    .map((seg) => {
      const colon = seg.indexOf(":");
      return colon === -1 ? seg : seg.slice(0, colon);
    })
    .join("/");
  // Strip trailing dots/spaces from each segment (Windows behavior).
  s = s
    .split("/")
    .map((seg) => seg.replace(/[.\s]+$/, ""))
    .join("/");
  // Collapse duplicate slashes (//foo → /foo). Preserve a possible leading
  // single slash.
  s = s.replace(/\/{2,}/g, "/");
  s = s.toLowerCase();
  // Drop trailing slash so "/foo/" and "/foo" compare equal.
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function isUnderProtected(cmp: string, dir: string): boolean {
  // Protected dirs (`/.ssh`, `/.config/gh`, …) live under the user's home or
  // somewhere else in the tree — they are NOT root-anchored. Match the dir as
  // a path-segment substring: append `/` to both sides so we don't match
  // false positives like `/.sshx` against `/.ssh`.
  //
  //   "/users/me/.ssh/config" + "/" → contains "/.ssh/" ✓
  //   "/users/me/.ssh"        + "/" → contains "/.ssh/" ✓
  //   "/users/me/.sshx/file"  + "/" → does not contain "/.ssh/" ✓
  return (cmp + "/").includes(dir + "/");
}

function describeProtected(dir: string): string {
  // "/.ssh" -> ".ssh", "/.config/gh" -> ".config/gh"
  return dir.replace(/^\//, "");
}

export function checkReadable(path: string): SafetyResult {
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, reason: "Refused: empty path." };
  }
  // Reject NUL and control bytes in paths — these are never legitimate and
  // are a classic truncation/injection vector.
  if (/[\x00-\x1f]/.test(path)) {
    return { ok: false, reason: "Refused: path contains control bytes." };
  }

  const base = basename(path);
  for (const re of SECRET_BASENAME_PATTERNS) {
    if (re.test(base)) {
      return {
        ok: false,
        reason: `Refused: "${base}" matches a sensitive-file pattern.`,
      };
    }
  }

  const cmp = comparisonForm(path);
  for (const dir of PROTECTED_DIRS) {
    if (isUnderProtected(cmp, dir)) {
      return {
        ok: false,
        reason: `Refused: path is inside a protected directory (${describeProtected(dir)}).`,
      };
    }
  }

  return { ok: true };
}

export function checkWritable(path: string): SafetyResult {
  // Writes inherit all read restrictions, plus system-directory blocks.
  const r = checkReadable(path);
  if (!r.ok) return r;

  const cmp = comparisonForm(path);
  // Ensure the comparison surface has a leading separator for prefix matching.
  const cmpForPrefix = cmp.startsWith("/") ? cmp : `/${cmp}`;
  for (const prefix of WRITE_DENY_PREFIXES) {
    if (
      cmpForPrefix.startsWith(prefix) ||
      `${cmpForPrefix}/`.startsWith(prefix)
    ) {
      return {
        ok: false,
        reason: `Refused: writes under "${prefix.replace(/\/$/, "")}" are not allowed.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Two-phase safety check that also defends against symlink traversal: first
 * checks the literal path, then (if it exists) canonicalizes it via the
 * native FS and re-checks the resolved path. A symlink at `./innocent.txt`
 * pointing into `~/.ssh/id_rsa` is caught on the second pass.
 *
 * Returns the canonical path on success so callers can use it for the actual
 * read — avoids TOCTOU between the safety check and the read.
 */
export async function checkReadableCanonical(
  path: string,
  canonicalize: (p: string) => Promise<string>,
): Promise<{ ok: true; canonical: string } | { ok: false; reason: string }> {
  const initial = checkReadable(path);
  if (!initial.ok) return initial;
  let canonical: string;
  try {
    canonical = await canonicalize(path);
  } catch {
    // Path doesn't exist yet — fine for the read tool to surface ENOENT.
    return { ok: true, canonical: path };
  }
  // Always recheck — even when canonicalize returns the same string, the
  // checks themselves can have OS-specific gaps (NTFS streams, trailing
  // dot/space) that warrant a second pass against the comparison form.
  const recheck = checkReadable(canonical);
  if (!recheck.ok) return recheck;
  return { ok: true, canonical };
}

/**
 * Same pattern as {@link checkReadableCanonical} but for writes. The canonical
 * path is only available if the file already exists — for new-file creates
 * we additionally canonicalize the parent directory.
 */
export async function checkWritableCanonical(
  path: string,
  canonicalize: (p: string) => Promise<string>,
): Promise<{ ok: true; canonical: string } | { ok: false; reason: string }> {
  const initial = checkWritable(path);
  if (!initial.ok) return initial;
  // Try canonicalizing the target itself first.
  try {
    const canonical = await canonicalize(path);
    // Always recheck the canonical form — same rationale as checkReadableCanonical.
    const recheck = checkWritable(canonical);
    if (!recheck.ok) return recheck;
    return { ok: true, canonical };
  } catch {
    // Target doesn't exist — canonicalize the parent so we still catch a
    // symlinked parent directory (`./project -> /Users/me/.ssh`).
    const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (lastSep > 0) {
      const parent = path.slice(0, lastSep);
      const tail = path.slice(lastSep);
      try {
        const canonParent = await canonicalize(parent);
        const recheckParent = checkWritable(canonParent + tail);
        if (!recheckParent.ok) return recheckParent;
        return { ok: true, canonical: canonParent + tail };
      } catch {
        // Parent doesn't exist either — let the caller surface the actual error.
      }
    }
    return { ok: true, canonical: path };
  }
}
