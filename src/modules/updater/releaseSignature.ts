import {
  decodeBase64,
  formatMinisignKeyId,
  isLoopbackEndpoint,
  parseMinisignPublicKey,
  type UpdaterContract,
} from "./contract";
import type {
  AvailableRelease,
  ReleaseArtifact,
  ReleaseTrust,
} from "./releaseManifest";

/**
 * Artifact trust at *discovery* time.
 *
 * A minisign signature covers the artifact bytes, so a check that never downloads the
 * package cannot cryptographically verify the installer payload; full payload
 * verification stays at release gating and package verification time. Discovery fails
 * closed on malformed signature envelopes, version mismatches in the signed trusted
 * comment, unprovisioned trust roots, or signatures whose key ID does not match the
 * provisioned trust root.
 */

type VerifyResult =
  | { ok: true; trust: ReleaseTrust }
  | { ok: false; detail: string };

export type ReleaseVerifier = (input: {
  release: Omit<AvailableRelease, "trust">;
  contract: UpdaterContract;
}) => VerifyResult;

type EnvelopeResult =
  | { ok: true; keyIdBytes: Uint8Array; hasGlobalSignature: boolean }
  | { ok: false; detail: string };

/** Structural inspection of a minisign signature envelope. */
function inspectSignatureEnvelope(
  artifact: ReleaseArtifact,
  version: string,
): EnvelopeResult {
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
  let hasGlobalSignature = false;
  if (globalSignature !== undefined && globalSignature !== "") {
    const bytes = decodeBase64(globalSignature);
    if (bytes?.length !== 64) {
      return { ok: false, detail: "global signature is not 64 bytes" };
    }
    hasGlobalSignature = true;
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

  return {
    ok: true,
    keyIdBytes: signatureBytes.slice(2, 10),
    hasGlobalSignature,
  };
}

function keyIdsEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Fails closed unless trust is provisioned and the signature key ID matches it. */
function failClosedVerifier({
  release,
  contract,
}: Parameters<ReleaseVerifier>[0]): VerifyResult {
  const envelope = inspectSignatureEnvelope(release.artifact, release.version);
  if (!envelope.ok) return envelope;
  if (!contract.trust.provisioned || contract.trust.publicKey === "") {
    return {
      ok: false,
      detail: "artifact trust root is not provisioned",
    };
  }
  const publicKey = parseMinisignPublicKey(contract.trust.publicKey);
  if (!publicKey) {
    return {
      ok: false,
      detail: "provisioned trust root public key is invalid",
    };
  }
  if (!envelope.hasGlobalSignature) {
    return {
      ok: false,
      detail: "signature envelope is missing its global signature line",
    };
  }
  if (!keyIdsEqual(envelope.keyIdBytes, publicKey.keyIdBytes)) {
    return {
      ok: false,
      detail: `signature key id ${formatMinisignKeyId(envelope.keyIdBytes)} does not match provisioned trust root ${publicKey.keyIdHex}`,
    };
  }
  return { ok: true, trust: "verified" };
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
