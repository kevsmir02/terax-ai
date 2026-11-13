import { isLoopbackEndpoint, type UpdaterContract } from "./contract";
import {
  formatMinisignKeyId,
  inspectSignatureEnvelope,
  parseMinisignPublicKey,
  verifyMinisignGlobalSignature,
} from "./minisign";
import type { AvailableRelease, ReleaseTrust } from "./releaseManifest";

/**
 * Artifact trust at *discovery* time.
 *
 * A minisign signature covers the installer bytes, so a check that never downloads the
 * package cannot cryptographically verify the installer payload; full payload verification
 * stays at release gating and offline package verification (`minisign -Vm`). Discovery still
 * verifies the minisign envelope, key ID, signed `version:` trusted comment, and Ed25519
 * global signature over `(signature || trusted comment)` against the provisioned trust root,
 * failing closed on any mismatch or unprovisioned key.
 */

type VerifyResult =
  | { ok: true; trust: ReleaseTrust }
  | { ok: false; detail: string };

export type ReleaseVerifier = (input: {
  release: Omit<AvailableRelease, "trust">;
  contract: UpdaterContract;
}) => VerifyResult | Promise<VerifyResult>;

function keyIdsEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Fails closed unless trust is provisioned and the Ed25519 global signature verifies. */
async function failClosedVerifier({
  release,
  contract,
}: Parameters<ReleaseVerifier>[0]): Promise<VerifyResult> {
  const inspected = inspectSignatureEnvelope(release.artifact, release.version);
  if (!inspected.ok) return inspected;
  const { envelope } = inspected;
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
  if (!envelope.globalSignatureBytes) {
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
  const verified = await verifyMinisignGlobalSignature(publicKey, envelope);
  if (!verified) {
    return {
      ok: false,
      detail:
        "signature failed cryptographic verification against provisioned trust root",
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
