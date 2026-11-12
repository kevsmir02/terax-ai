import { isLoopbackEndpoint, type UpdaterContract } from "./contract";
import type {
  AvailableRelease,
  ReleaseArtifact,
  ReleaseTrust,
} from "./releaseManifest";

/**
 * Artifact trust at *discovery* time.
 *
 * A minisign signature covers the artifact bytes, so a check that never downloads the
 * package cannot cryptographically prove authenticity — that belongs to the download and
 * install handoff (ticket #39). What discovery can and must do is fail closed: refuse a
 * malformed signature envelope, refuse a manifest whose signed trusted comment names a
 * different version, and refuse to call anything verified while the fork has no trust root
 * provisioned. That way "no trust inputs yet" surfaces as a check failure instead of as an
 * update the user might install.
 */

type VerifyResult =
  | { ok: true; trust: ReleaseTrust }
  | { ok: false; detail: string };

export type ReleaseVerifier = (input: {
  release: Omit<AvailableRelease, "trust">;
  contract: UpdaterContract;
}) => VerifyResult;

/** Structural inspection of a minisign signature envelope (no cryptography). */
function inspectSignatureEnvelope(
  artifact: ReleaseArtifact,
  version: string,
): { ok: true } | { ok: false; detail: string } {
  const lines = artifact.signature
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line, index, all) => index < all.length - 1 || line !== "");

  if (lines.length < 3) {
    return { ok: false, detail: "signature envelope is incomplete" };
  }
  if (!(lines[0] ?? "").startsWith("untrusted comment: ")) {
    return { ok: false, detail: "signature has no untrusted comment line" };
  }

  const signatureBytes = decodeBase64(lines[1] ?? "");
  if (signatureBytes?.length !== 74) {
    return {
      ok: false,
      detail: "signature block is not a 74-byte minisign signature",
    };
  }
  const algorithm = String.fromCharCode(
    signatureBytes[0] ?? 0,
    signatureBytes[1] ?? 0,
  );
  if (algorithm !== "Ed" && algorithm !== "ED") {
    return {
      ok: false,
      detail: `unknown signature algorithm ${JSON.stringify(algorithm)}`,
    };
  }

  const trusted = lines[2] ?? "";
  if (
    !trusted.startsWith("trusted comment: ") ||
    trusted.trim() === "trusted comment:"
  ) {
    return { ok: false, detail: "signature has no trusted comment" };
  }

  const globalSignature = lines[3];
  if (globalSignature !== undefined && globalSignature !== "") {
    const bytes = decodeBase64(globalSignature);
    if (bytes?.length !== 64) {
      return { ok: false, detail: "global signature is not 64 bytes" };
    }
  }

  // Tauri records the signed version in the trusted comment. When present, it must be the
  // version being announced, otherwise a crafted manifest could pair a newer version with
  // an older signed artifact.
  const signedVersion = /(?:^|\s)version:(\S+)/.exec(trusted)?.[1];
  if (signedVersion !== undefined && signedVersion !== version) {
    return {
      ok: false,
      detail: `signed version ${signedVersion} does not match manifest version ${version}`,
    };
  }

  return { ok: true };
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Fails closed: structural checks, then refuse until a trust root is provisioned. */
function failClosedVerifier({
  release,
  contract,
}: Parameters<ReleaseVerifier>[0]): VerifyResult {
  const envelope = inspectSignatureEnvelope(release.artifact, release.version);
  if (!envelope.ok) return envelope;
  if (!contract.trust.provisioned || contract.trust.publicKey === "") {
    return {
      ok: false,
      detail: "artifact trust root is not provisioned (ticket #39)",
    };
  }
  return {
    ok: false,
    detail:
      "minisign artifact verification is not implemented until ticket #39; refusing to report an unverified update",
  };
}

/**
 * Development-only verifier for the isolated fixture server. It never claims a
 * cryptographically verified artifact: releases it accepts are labelled
 * `fixture-unverified`, and the dialog says so. The factory only returns this verifier
 * for a development build whose endpoints are all loopback.
 */
function fixtureVerifier({
  release,
}: Parameters<ReleaseVerifier>[0]): VerifyResult {
  const envelope = inspectSignatureEnvelope(release.artifact, release.version);
  if (!envelope.ok) return envelope;
  return { ok: true, trust: "fixture-unverified" };
}

export function createReleaseVerifier({
  devMode,
  contract,
}: {
  devMode: boolean;
  contract: UpdaterContract;
}): ReleaseVerifier {
  const fixtureMode =
    devMode &&
    contract.endpoints.length > 0 &&
    contract.endpoints.every((endpoint) => isLoopbackEndpoint(endpoint));
  return fixtureMode ? fixtureVerifier : failClosedVerifier;
}
