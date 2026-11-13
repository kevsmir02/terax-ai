import type { ReleaseArtifact } from "./releaseManifest";

/** Parsed minisign public key extracted from the updater contract. */
export interface MinisignPublicKey {
  keyIdBytes: Uint8Array;
  keyIdHex: string;
  publicKeyBytes: Uint8Array;
  fingerprint: string;
}

/** Parsed components of a four-line minisign signature envelope. */
export interface SignatureEnvelope {
  keyIdBytes: Uint8Array;
  signatureBytes: Uint8Array;
  trustedCommentBody: string;
  globalSignatureBytes: Uint8Array | null;
}

const UNTRUSTED_PREFIX = "untrusted comment: ";
const TRUSTED_PREFIX = "trusted comment: ";

// Twisted Edwards Ed25519 constants matching RFC 8032 and scripts/minisign.py.
const Q = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

function mod(value: bigint, modulus: bigint = Q): bigint {
  const remainder = value % modulus;
  return remainder >= 0n ? remainder : remainder + modulus;
}

function powMod(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let power = mod(base, modulus);
  let exp = exponent;
  while (exp > 0n) {
    if ((exp & 1n) === 1n) {
      result = (result * power) % modulus;
    }
    power = (power * power) % modulus;
    exp >>= 1n;
  }
  return result;
}

function invMod(value: bigint): bigint {
  return powMod(value, Q - 2n, Q);
}

const D = mod(-121665n * invMod(121666n));
const I = powMod(2n, (Q - 1n) / 4n, Q);

function recoverX(y: bigint, sign: number): bigint | null {
  const y2 = (y * y) % Q;
  const xx = mod((y2 - 1n) * invMod(mod(D * y2 + 1n)));
  let x = powMod(xx, (Q + 3n) / 8n, Q);
  if (mod(x * x - xx) !== 0n) {
    x = (x * I) % Q;
  }
  if (mod(x * x - xx) !== 0n) return null;
  if (xx === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) {
    x = Q - x;
  }
  return x;
}

function leBytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(bytes[i] ?? 0);
  }
  return value;
}

type ExtPoint = readonly [bigint, bigint, bigint, bigint];

const BY = mod(4n * invMod(5n));
const BX = recoverX(BY, 0) ?? 0n;
const BASE_POINT: ExtPoint = [BX, BY, 1n, mod(BX * BY)];
const IDENTITY_POINT: ExtPoint = [0n, 1n, 1n, 0n];

function decodePoint(bytes: Uint8Array): ExtPoint | null {
  if (bytes.length !== 32) return null;
  const raw = leBytesToBigInt(bytes);
  const y = raw & ((1n << 255n) - 1n);
  if (y >= Q) return null;
  const sign = Number((raw >> 255n) & 1n);
  const x = recoverX(y, sign);
  if (x === null) return null;
  const t = mod(x * y);
  if (mod(-x * x + y * y - 1n - D * t * t) !== 0n) return null;
  return [x, y, 1n, t];
}

function encodePoint(point: ExtPoint): Uint8Array {
  const [x, y, z] = point;
  const zInv = invMod(z);
  const nx = mod(x * zInv);
  const ny = mod(y * zInv);
  const out = new Uint8Array(32);
  let encoded = ny | ((nx & 1n) << 255n);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(encoded & 0xffn);
    encoded >>= 8n;
  }
  return out;
}

function addPoints(left: ExtPoint, right: ExtPoint): ExtPoint {
  const [x1, y1, z1, t1] = left;
  const [x2, y2, z2, t2] = right;
  const a = mod((y1 - x1) * (y2 - x2));
  const b = mod((y1 + x1) * (y2 + x2));
  const c = mod(t1 * 2n * D * t2);
  const d = mod(z1 * 2n * z2);
  const e = mod(b - a);
  const f = mod(d - c);
  const g = mod(d + c);
  const h = mod(b + a);
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function multiplyPoint(point: ExtPoint, scalar: bigint): ExtPoint {
  let result: ExtPoint = IDENTITY_POINT;
  let addend: ExtPoint = point;
  let s = scalar;
  while (s > 0n) {
    if ((s & 1n) === 1n) {
      result = addPoints(result, addend);
    }
    addend = addPoints(addend, addend);
    s >>= 1n;
  }
  return result;
}

// FIPS 180-4 SHA-256 initial hash values and round constants for synchronous key fingerprints.
const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Hex(data: Uint8Array): string {
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(data);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bitLen = BigInt(data.length) * 8n;
  view.setUint32(paddedLen - 8, Number(bitLen >> 32n));
  view.setUint32(paddedLen - 4, Number(bitLen & 0xffffffffn));

  const state = new Uint32Array(SHA256_INIT);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 =
        rotr32(w[i - 15] ?? 0, 7) ^
        rotr32(w[i - 15] ?? 0, 18) ^
        ((w[i - 15] ?? 0) >>> 3);
      const s1 =
        rotr32(w[i - 2] ?? 0, 17) ^
        rotr32(w[i - 2] ?? 0, 19) ^
        ((w[i - 2] ?? 0) >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e ?? 0, 6) ^ rotr32(e ?? 0, 11) ^ rotr32(e ?? 0, 25);
      const ch = ((e ?? 0) & (f ?? 0)) ^ (~(e ?? 0) & (g ?? 0));
      const temp1 =
        ((h ?? 0) + S1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = rotr32(a ?? 0, 2) ^ rotr32(a ?? 0, 13) ^ rotr32(a ?? 0, 22);
      const maj =
        ((a ?? 0) & (b ?? 0)) ^ ((a ?? 0) & (c ?? 0)) ^ ((b ?? 0) & (c ?? 0));
      const temp2 = (S0 + maj) >>> 0;
      h = g ?? 0;
      g = f ?? 0;
      f = e ?? 0;
      e = ((d ?? 0) + temp1) >>> 0;
      d = c ?? 0;
      c = b ?? 0;
      b = a ?? 0;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = ((state[0] ?? 0) + (a ?? 0)) >>> 0;
    state[1] = ((state[1] ?? 0) + (b ?? 0)) >>> 0;
    state[2] = ((state[2] ?? 0) + (c ?? 0)) >>> 0;
    state[3] = ((state[3] ?? 0) + (d ?? 0)) >>> 0;
    state[4] = ((state[4] ?? 0) + (e ?? 0)) >>> 0;
    state[5] = ((state[5] ?? 0) + (f ?? 0)) >>> 0;
    state[6] = ((state[6] ?? 0) + (g ?? 0)) >>> 0;
    state[7] = ((state[7] ?? 0) + (h ?? 0)) >>> 0;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join(
    "",
  );
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

function splitNonTrailingLines(text: string): string[] {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function readMagic(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0);
}

/** Formats minisign's little-endian 8-byte key ID as uppercase hex. */
export function formatMinisignKeyId(keyIdBytes: Uint8Array): string {
  let hex = "";
  for (let i = keyIdBytes.length - 1; i >= 0; i--) {
    hex += (keyIdBytes[i] ?? 0).toString(16).toUpperCase().padStart(2, "0");
  }
  return hex;
}

/** Parses a Tauri-style base64-wrapped minisign `.pub` string. */
export function parseMinisignPublicKey(
  value: string,
): MinisignPublicKey | null {
  const raw = decodeBase64(value);
  if (!raw) return null;
  const lines = splitNonTrailingLines(new TextDecoder().decode(raw)).filter(
    (line) => line !== "",
  );
  if (lines.length < 2 || !(lines[0] ?? "").startsWith(UNTRUSTED_PREFIX)) {
    return null;
  }
  const keyBytes = decodeBase64(lines[1] ?? "");
  if (keyBytes?.length !== 42 || readMagic(keyBytes) !== "Ed") {
    return null;
  }
  const keyIdBytes = keyBytes.slice(2, 10);
  const publicKeyBytes = keyBytes.slice(10, 42);
  if (!decodePoint(publicKeyBytes)) {
    return null;
  }
  return {
    keyIdBytes,
    keyIdHex: formatMinisignKeyId(keyIdBytes),
    publicKeyBytes,
    fingerprint: `sha256:${sha256Hex(keyBytes)}`,
  };
}

/** Structural inspection of a minisign signature envelope. */
export function inspectSignatureEnvelope(
  artifact: ReleaseArtifact,
  version: string,
): { ok: true; envelope: SignatureEnvelope } | { ok: false; detail: string } {
  const lines = splitNonTrailingLines(artifact.signature);
  if (lines.length < 3) {
    return { ok: false, detail: "signature envelope is incomplete" };
  }
  if (!(lines[0] ?? "").startsWith(UNTRUSTED_PREFIX)) {
    return { ok: false, detail: "signature has no untrusted comment line" };
  }

  const blockBytes = decodeBase64(lines[1] ?? "");
  if (blockBytes?.length !== 74) {
    return {
      ok: false,
      detail: "signature block is not a 74-byte minisign signature",
    };
  }
  const algorithm = readMagic(blockBytes);
  if (algorithm !== "Ed" && algorithm !== "ED") {
    return {
      ok: false,
      detail: `unknown signature algorithm ${JSON.stringify(algorithm)}`,
    };
  }

  const trustedLine = lines[2] ?? "";
  if (
    !trustedLine.startsWith(TRUSTED_PREFIX) ||
    trustedLine.trim() === "trusted comment:"
  ) {
    return { ok: false, detail: "signature has no trusted comment" };
  }
  const trustedCommentBody = trustedLine.slice(TRUSTED_PREFIX.length);

  const globalSignatureLine = lines[3];
  let globalSignatureBytes: Uint8Array | null = null;
  if (globalSignatureLine !== undefined && globalSignatureLine !== "") {
    const bytes = decodeBase64(globalSignatureLine);
    if (bytes?.length !== 64) {
      return { ok: false, detail: "global signature is not 64 bytes" };
    }
    globalSignatureBytes = bytes;
  }

  const signedVersion = /(?:^|\s)version:(\S+)/.exec(trustedLine)?.[1];
  if (signedVersion !== undefined && signedVersion !== version) {
    return {
      ok: false,
      detail: `signed version ${signedVersion} does not match manifest version ${version}`,
    };
  }

  return {
    ok: true,
    envelope: {
      keyIdBytes: blockBytes.slice(2, 10),
      signatureBytes: blockBytes.slice(10, 74),
      trustedCommentBody,
      globalSignatureBytes,
    },
  };
}

/**
 * Verifies the Ed25519 global signature over `(signature || trustedCommentBody)` using WebCrypto SHA-512.
 *
 * This binds the announced artifact signature and signed `version:` trusted comment to the
 * committed public key at discovery time without downloading installer bytes.
 */
export async function verifyMinisignGlobalSignature(
  publicKey: MinisignPublicKey,
  envelope: SignatureEnvelope,
): Promise<boolean> {
  if (!envelope.globalSignatureBytes || !globalThis.crypto?.subtle) {
    return false;
  }
  const pointA = decodePoint(publicKey.publicKeyBytes);
  const pointR = decodePoint(envelope.globalSignatureBytes.slice(0, 32));
  const scalar = leBytesToBigInt(envelope.globalSignatureBytes.slice(32, 64));
  if (!pointA || !pointR || scalar >= L) {
    return false;
  }

  const commentBytes = new TextEncoder().encode(envelope.trustedCommentBody);
  const payload = new Uint8Array(
    envelope.signatureBytes.length + commentBytes.length,
  );
  payload.set(envelope.signatureBytes, 0);
  payload.set(commentBytes, envelope.signatureBytes.length);

  const digestInput = new Uint8Array(32 + 32 + payload.length);
  digestInput.set(envelope.globalSignatureBytes.slice(0, 32), 0);
  digestInput.set(publicKey.publicKeyBytes, 32);
  digestInput.set(payload, 64);

  const digestBuffer = await globalThis.crypto.subtle.digest(
    "SHA-512",
    digestInput,
  );
  const challenge = leBytesToBigInt(new Uint8Array(digestBuffer)) % L;

  const lhs = encodePoint(multiplyPoint(BASE_POINT, scalar));
  const rhs = encodePoint(addPoints(pointR, multiplyPoint(pointA, challenge)));
  if (lhs.length !== rhs.length) return false;
  let diff = 0;
  for (let i = 0; i < lhs.length; i++) {
    diff |= (lhs[i] ?? 0) ^ (rhs[i] ?? 0);
  }
  return diff === 0;
}
