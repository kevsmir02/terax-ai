/**
 * Parsing and version comparison for the fork's stable release manifest.
 *
 * The manifest shape follows the Tauri updater's static-JSON format (`version`,
 * `channel`, `notes`, `pub_date`, `platforms`) so a future fork-owned feed does not need a
 * second schema, but this module deliberately only *reads* it: discovery never touches an
 * artifact URL.
 */

export type ReleaseTrust = "verified" | "fixture-unverified";

export interface ReleaseArtifact {
  url: string;
  signature: string;
  size: number | null;
}

export interface AvailableRelease {
  version: string;
  channel: "stable";
  notes: string;
  publishedAt: string | null;
  artifact: ReleaseArtifact;
  trust: ReleaseTrust;
}

type ManifestFailureReason =
  | "bad-payload"
  | "unsupported-channel"
  | "unsupported-target"
  | "signature";

interface ManifestFailure {
  reason: ManifestFailureReason;
  detail: string;
}

export type ManifestParseResult =
  | { ok: true; release: Omit<AvailableRelease, "trust"> }
  | { ok: false; failure: ManifestFailure };

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** A SemVer prerelease version (`1.0.0-rc.1`, `1.0.0-beta.1`). */
function isPrerelease(version: string): boolean {
  const withoutBuild = version.split("+")[0] ?? version;
  return withoutBuild.includes("-");
}

function parseCore(version: string): { core: number[]; pre: string[] } | null {
  const withoutBuild = version.split("+")[0] ?? version;
  const [corePart, prePart] = withoutBuild.split("-", 2) as [
    string,
    string | undefined,
  ];
  const core = corePart.split(".").map((part) => Number.parseInt(part, 10));
  if (core.length !== 3 || core.some((n) => !Number.isFinite(n) || n < 0))
    return null;
  const pre = prePart ? prePart.split(".") : [];
  return { core, pre };
}

/**
 * Compare two SemVer-like versions. Returns a negative number when `a < b`, zero when
 * equal and a positive number when `a > b`. A release ranks above its prereleases.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseCore(a);
  const right = parseCore(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    const x = left.core[i] ?? 0;
    const y = right.core[i] ?? 0;
    if (x !== y) return x - y;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number.parseInt(x, 10);
    const ny = Number.parseInt(y, 10);
    const xNumeric = String(nx) === x;
    const yNumeric = String(ny) === y;
    if (xNumeric && yNumeric) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return xNumeric ? -1 : yNumeric ? 1 : x < y ? -1 : 1;
    }
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export interface ParseManifestOptions {
  /** Target platform key, e.g. `linux-x86_64`. */
  target: string;
  /** Only `stable` is supported; a prerelease payload is refused on this channel. */
  channel: "stable";
}

/**
 * Parse a manifest body. Payload problems are classified so the UI can say what actually
 * failed instead of a generic error.
 */
export function parseReleaseManifest(
  text: string,
  { target, channel }: ParseManifestOptions,
): ManifestParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      failure: { reason: "bad-payload", detail: "body is not JSON" },
    };
  }
  if (!isRecord(raw)) {
    return {
      ok: false,
      failure: { reason: "bad-payload", detail: "body is not an object" },
    };
  }

  const version = nonEmptyString(raw.version);
  if (!version || !VERSION_RE.test(version)) {
    return {
      ok: false,
      failure: { reason: "bad-payload", detail: "missing or invalid version" },
    };
  }

  const declaredChannel = nonEmptyString(raw.channel);
  if (!declaredChannel) {
    return {
      ok: false,
      failure: { reason: "bad-payload", detail: "missing channel" },
    };
  }
  if (declaredChannel !== channel) {
    return {
      ok: false,
      failure: {
        reason: "unsupported-channel",
        detail: `release channel ${declaredChannel} is not the ${channel} channel`,
      },
    };
  }
  if (isPrerelease(version)) {
    return {
      ok: false,
      failure: {
        reason: "unsupported-channel",
        detail: `prerelease version ${version} on the ${channel} channel`,
      },
    };
  }

  if (!isRecord(raw.platforms)) {
    return {
      ok: false,
      failure: { reason: "bad-payload", detail: "missing platforms" },
    };
  }
  const platform = raw.platforms[target];
  if (!isRecord(platform)) {
    return {
      ok: false,
      failure: {
        reason: "unsupported-target",
        detail: `no artifact for ${target}`,
      },
    };
  }

  const artifactUrl = nonEmptyString(platform.url);
  if (!artifactUrl) {
    return {
      ok: false,
      failure: { reason: "bad-payload", detail: "artifact has no url" },
    };
  }
  let parsedArtifactUrl: URL;
  try {
    parsedArtifactUrl = new URL(artifactUrl);
  } catch {
    return {
      ok: false,
      failure: { reason: "bad-payload", detail: "artifact url is not a URL" },
    };
  }
  if (
    parsedArtifactUrl.protocol !== "http:" &&
    parsedArtifactUrl.protocol !== "https:"
  ) {
    return {
      ok: false,
      failure: { reason: "bad-payload", detail: "artifact url is not http(s)" },
    };
  }

  const signature = nonEmptyString(platform.signature);
  if (!signature) {
    return {
      ok: false,
      failure: { reason: "signature", detail: "artifact has no signature" },
    };
  }

  const notes = typeof raw.notes === "string" ? raw.notes : "";
  const publishedAt = nonEmptyString(raw.pub_date);

  return {
    ok: true,
    release: {
      version,
      channel,
      notes,
      publishedAt,
      artifact: {
        url: parsedArtifactUrl.toString(),
        signature,
        size:
          typeof platform.size === "number" && Number.isFinite(platform.size)
            ? platform.size
            : null,
      },
    },
  };
}
