"""Minisign-compatible Ed25519 signatures, in the standard library only.

Release authenticity for this fork rests on a minisign key generated offline by the maintainer
(`docs/architecture/release-trust.md`). The signing tool itself is the ecosystem's
(`node_modules/.bin/tauri signer sign` reads the passphrase-protected key and never hands the
secret to this module), so what is left here is the part a Python gate needs and a shell command
cannot do: **verify** a signature over the exact artifact bytes, and sign with a throwaway key so
tests can exercise the same envelope the real tool produces.

The wire format is minisign's, not an invention:

    untrusted comment: <free text>
    <base64: "Ed" (2) | key id (8) | Ed25519 signature (64)>            = 74 bytes
    trusted comment: <free text, tab-separated for Tauri>
    <base64: Ed25519 signature over (signature bytes | trusted comment)> = 64 bytes

Both minisign algorithms are supported, because both appear in the ecosystem and the gate must
not guess which one signed a release:

- `Ed` (legacy): Ed25519 over the file bytes directly (the fork's committed discovery fixture).
- `ED` (prehashed): plain Ed25519 over the 64-byte BLAKE2b-512 digest of the file. This is what
  `tauri signer sign` emits (verified against its output, see
  `scripts/tests/test_release_signing.py`), so it is the form a release carries. Note that this is
  minisign/libsodium's prehashed construction, not RFC 8032 `Ed25519ph`: there is no `dom2`
  domain-separation prefix. Implementing the RFC variant instead does not verify.

The key id is stored little-endian and displayed reversed, as minisign does, e.g. binary
`84 24 bb 29 c6 8e e4 d0` prints as `D0E48EC629BB2484`.

`scripts/tests/test_release_signing.py` verifies a signature produced by the real Tauri CLI, so this
module is pinned to an independent implementation rather than to itself.
"""

from __future__ import annotations

import base64
import hashlib
import os
import time
from dataclasses import dataclass
from pathlib import Path

# ---------------------------------------------------------------------------------------------
# Ed25519 (RFC 8032), the small reference construction
# ---------------------------------------------------------------------------------------------

_Q = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493


def _inv(value: int) -> int:
    return pow(value, _Q - 2, _Q)


_D = -121665 * _inv(121666) % _Q
_I = pow(2, (_Q - 1) // 4, _Q)


def _recover_x(y: int) -> int:
    xx = (y * y - 1) * _inv(_D * y * y + 1)
    x = pow(xx, (_Q + 3) // 8, _Q)
    if (x * x - xx) % _Q != 0:
        x = (x * _I) % _Q
    if x % 2 != 0:
        x = _Q - x
    return x


_BY = 4 * _inv(5) % _Q
_BX = _recover_x(_BY)
_BASE = (_BX % _Q, _BY % _Q, 1, (_BX * _BY) % _Q)
_IDENTITY = (0, 1, 1, 0)


def _add(left: tuple[int, int, int, int], right: tuple[int, int, int, int]):
    """Extended-coordinate addition (add-2008-hwcd-3) for the a=-1 twisted Edwards curve.

    No modular inverse per addition: a scalar multiplication is then a few hundred
    multiplications rather than a few hundred exponentiations.
    """
    x1, y1, z1, t1 = left
    x2, y2, z2, t2 = right
    a = (y1 - x1) * (y2 - x2) % _Q
    b = (y1 + x1) * (y2 + x2) % _Q
    c = t1 * 2 * _D * t2 % _Q
    d = z1 * 2 * z2 % _Q
    e = b - a
    f = d - c
    g = d + c
    h = b + a
    return (e * f % _Q, g * h % _Q, f * g % _Q, e * h % _Q)


def _multiply(point: tuple[int, int, int, int], scalar: int):
    result = _IDENTITY
    addend = point
    while scalar:
        if scalar & 1:
            result = _add(result, addend)
        addend = _add(addend, addend)
        scalar >>= 1
    return result


def _encode_point(point: tuple[int, int, int, int]) -> bytes:
    x, y, z, _t = point
    inverse = _inv(z)
    x = x * inverse % _Q
    y = y * inverse % _Q
    bits = [(y >> index) & 1 for index in range(255)] + [x & 1]
    return bytes(
        sum(bits[offset * 8 + bit] << bit for bit in range(8)) for offset in range(32)
    )


def _bit(value: bytes, index: int) -> int:
    return (value[index // 8] >> (index % 8)) & 1


def _decode_point(data: bytes) -> tuple[int, int, int, int]:
    if len(data) != 32:
        raise MinisignError("public key point is not 32 bytes")
    y = int.from_bytes(data, "little") & ((1 << 255) - 1)
    x = _recover_x(y)
    if x & 1 != _bit(data, 255):
        x = _Q - x
    point = (x, y, 1, x * y % _Q)
    if (-x * x + y * y - 1 - _D * point[3] * point[3]) % _Q != 0:
        raise MinisignError("public key point is not on the Ed25519 curve")
    return point


def _clamped_scalar(digest: bytes) -> int:
    return 2**254 + sum(2**index * _bit(digest, index) for index in range(3, 254))


def _hash_to_scalar(data: bytes) -> int:
    digest = hashlib.sha512(data).digest()
    return sum(2**index * _bit(digest, index) for index in range(512)) % _L


# minisign's `ED` prehash: BLAKE2b-512, then ordinary Ed25519 over the digest. No `dom2` prefix:
# minisign/libsodium's prehashed mode predates RFC 8032's Ed25519ph and does not use one.
_BLAKE2B_OUTPUT = 64


def _prehash(message: bytes) -> bytes:
    return hashlib.blake2b(message, digest_size=_BLAKE2B_OUTPUT).digest()


def public_key_from_seed(seed: bytes) -> bytes:
    """The 32-byte Ed25519 public key for a 32-byte secret seed."""
    if len(seed) != 32:
        raise MinisignError("an Ed25519 secret seed is exactly 32 bytes")
    return _encode_point(_multiply(_BASE, _clamped_scalar(hashlib.sha512(seed).digest())))


def _sign_detached(seed: bytes, message: bytes, *, prehashed: bool) -> bytes:
    body = _prehash(message) if prehashed else message
    digest = hashlib.sha512(seed).digest()
    scalar = _clamped_scalar(digest)
    public = _encode_point(_multiply(_BASE, scalar))
    nonce = _hash_to_scalar(digest[32:64] + body)
    commitment = _encode_point(_multiply(_BASE, nonce))
    challenge = _hash_to_scalar(commitment + public + body)
    return commitment + ((nonce + challenge * scalar) % _L).to_bytes(32, "little")


def _verify_detached(public: bytes, message: bytes, signature: bytes, *,
                     prehashed: bool) -> bool:
    if len(signature) != 64:
        return False
    try:
        point = _decode_point(public)
        commitment = _decode_point(signature[:32])
    except MinisignError:
        return False
    scalar = int.from_bytes(signature[32:], "little")
    if scalar >= _L:
        return False
    body = _prehash(message) if prehashed else message
    challenge = _hash_to_scalar(signature[:32] + public + body)
    # Compare encodings, not tuples: extended coordinates are projective, so the same point has
    # many (X, Y, Z, T) representations.
    return _encode_point(_multiply(_BASE, scalar)) == _encode_point(
        _add(commitment, _multiply(point, challenge))
    )


# ---------------------------------------------------------------------------------------------
# The minisign envelope
# ---------------------------------------------------------------------------------------------

SIGNATURE_ALGORITHM = b"Ed"
PREHASHED_ALGORITHM = b"ED"
KEY_ID_LENGTH = 8
PUBLIC_KEY_LENGTH = 32
PUBLIC_KEY_BLOB_LENGTH = 2 + KEY_ID_LENGTH + PUBLIC_KEY_LENGTH  # 42
SIGNATURE_BLOB_LENGTH = 2 + KEY_ID_LENGTH + 64  # 74
GLOBAL_SIGNATURE_LENGTH = 64
UNTRUSTED_PREFIX = "untrusted comment: "
TRUSTED_PREFIX = "trusted comment: "


class MinisignError(ValueError):
    """A minisign key or signature that cannot be read or does not verify."""


def _b64encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _b64decode(text: str) -> bytes:
    try:
        return base64.b64decode(text, validate=True)
    except (ValueError, TypeError) as error:
        raise MinisignError(f"not valid base64: {error}") from error


def key_id_hex(key_id: bytes) -> str:
    """minisign's display form: the little-endian key id, reversed, uppercase hex."""
    if len(key_id) != KEY_ID_LENGTH:
        raise MinisignError("a key id is 8 bytes")
    return key_id[::-1].hex().upper()


def key_id_from_hex(text: str) -> bytes:
    raw = bytes.fromhex(text.strip())
    if len(raw) != KEY_ID_LENGTH:
        raise MinisignError(f"key id {text!r} is not 8 hex bytes")
    return raw[::-1]


@dataclass(frozen=True)
class KeyPair:
    """A fixture or development key. The real key is generated and held offline."""

    seed: bytes
    key_id: bytes
    public_key: bytes

    @property
    def key_id_text(self) -> str:
        return key_id_hex(self.key_id)


@dataclass(frozen=True)
class TrustedKey:
    """A public key: the only signing identity this repository will trust."""

    key_id: bytes
    public_key: bytes

    @property
    def key_id_text(self) -> str:
        return key_id_hex(self.key_id)

    @property
    def fingerprint(self) -> str:
        """A second, algorithm-independent fingerprint for out-of-band comparison."""
        blob = SIGNATURE_ALGORITHM + self.key_id + self.public_key
        return "sha256:" + hashlib.sha256(blob).hexdigest()

    def file_text(self) -> str:
        """The two-line `minisign` public key file."""
        return (
            f"{UNTRUSTED_PREFIX}minisign public key: {self.key_id_text}\n"
            f"{_b64encode(SIGNATURE_ALGORITHM + self.key_id + self.public_key)}\n"
        )

    def tauri_text(self) -> str:
        """The single base64 value Tauri's `plugins.updater.pubkey` expects."""
        return _b64encode(self.file_text().encode("utf-8"))


def generate_keypair(seed: bytes | None = None, key_id: bytes | None = None) -> KeyPair:
    """A new keypair. Tests call this; the real key never comes from here."""
    seed = os.urandom(32) if seed is None else seed
    key_id = os.urandom(KEY_ID_LENGTH) if key_id is None else key_id
    return KeyPair(seed=seed, key_id=key_id, public_key=public_key_from_seed(seed))


def trusted_comment(*, file_name: str, version: str, timestamp: int | None = None) -> str:
    """Tauri's trusted-comment shape, including the version the signature is bound to."""
    moment = int(time.time()) if timestamp is None else int(timestamp)
    return f"timestamp:{moment}\tfile:{file_name}\tversion:{version}"


def trusted_comment_version(comment: str) -> str | None:
    """The `version:` field of a trusted comment, or None when it carries none."""
    for field in comment.split("\t"):
        name, _, value = field.partition(":")
        if name == "version":
            return value or None
    return None


def sign_bytes(key: KeyPair, data: bytes, comment: str, *,
               untrusted: str | None = None, prehashed: bool = False) -> str:
    """The four-line signature file text for `data`.

    `prehashed=True` produces minisign's `ED` envelope (the form `tauri signer sign` emits and
    therefore the form a release carries). The default `Ed` form is the legacy one and is what the
    committed discovery fixture uses.
    """
    signature = _sign_detached(key.seed, data, prehashed=prehashed)
    algorithm = PREHASHED_ALGORITHM if prehashed else SIGNATURE_ALGORITHM
    blob = algorithm + key.key_id + signature
    # The global signature over (signature | trusted comment) is plain Ed25519 even in `ED` mode:
    # that is what `tauri signer sign` emits, and the comment is short enough not to prehash.
    global_signature = _sign_detached(
        key.seed, signature + comment.encode("utf-8"), prehashed=False
    )
    header = untrusted or "signature from terax-workspace release key"
    return (
        f"{UNTRUSTED_PREFIX}{header}\n"
        f"{_b64encode(blob)}\n"
        f"{TRUSTED_PREFIX}{comment}\n"
        f"{_b64encode(global_signature)}\n"
    )


def sign_file(path: Path, key: KeyPair, comment: str, *,
              prehashed: bool = False) -> str:
    return sign_bytes(key, Path(path).read_bytes(), comment, prehashed=prehashed)


def tauri_signature(text: str) -> str:
    """The single base64 value Tauri's manifest `signature` field and `.sig` file hold."""
    normalized = text if text.endswith("\n") or text == "" else text + "\n"
    return _b64encode(normalized.encode("utf-8"))


def signature_text(value: str) -> str:
    """Accept either minisign's file text or Tauri's base64 wrap; return the file text."""
    stripped = value.strip()
    if stripped.startswith(UNTRUSTED_PREFIX):
        return stripped + "\n"
    if stripped.startswith("dW50cnVzdGVkIGNvbW1lbnQ6"):  # base64("untrusted comment: ")
        decoded = _b64decode(stripped).decode("utf-8", "replace")
        if not decoded.startswith(UNTRUSTED_PREFIX):
            raise MinisignError("base64 signature does not wrap a minisign envelope")
        return decoded if decoded.endswith("\n") else decoded + "\n"
    raise MinisignError("not a minisign signature (expected an untrusted comment line)")


@dataclass(frozen=True)
class ParsedSignature:
    key_id: bytes
    signature: bytes
    trusted_comment: str
    global_signature: bytes
    text: str
    algorithm: bytes = SIGNATURE_ALGORITHM

    @property
    def key_id_text(self) -> str:
        return key_id_hex(self.key_id)

    @property
    def prehashed(self) -> bool:
        return self.algorithm == PREHASHED_ALGORITHM


def parse_signature(value: str) -> ParsedSignature:
    text = signature_text(value)
    lines = text.split("\n")
    if len(lines) < 4 or lines[0] == "":
        raise MinisignError("signature envelope is incomplete (expected four lines)")
    if not lines[2].startswith(TRUSTED_PREFIX):
        raise MinisignError("signature has no trusted comment line")
    blob = _b64decode(lines[1])
    if len(blob) != SIGNATURE_BLOB_LENGTH:
        raise MinisignError(
            f"signature block is {len(blob)} bytes, not a {SIGNATURE_BLOB_LENGTH}-byte minisign "
            "signature"
        )
    algorithm = blob[:2]
    if algorithm not in (SIGNATURE_ALGORITHM, PREHASHED_ALGORITHM):
        raise MinisignError(f"unsupported signature algorithm {algorithm!r}")
    global_signature = _b64decode(lines[3])
    if len(global_signature) != GLOBAL_SIGNATURE_LENGTH:
        raise MinisignError("global signature is not a 64-byte Ed25519 signature")
    return ParsedSignature(
        key_id=blob[2:10],
        signature=blob[10:],
        trusted_comment=lines[2][len(TRUSTED_PREFIX):],
        global_signature=global_signature,
        text=text,
        algorithm=algorithm,
    )


def parse_public_key(value: str) -> TrustedKey:
    """Read a public key from a minisign `.pub` file, Tauri's base64 value, or a key id alone."""
    text = value.strip()
    if text == "":
        raise MinisignError("the public key is empty")
    if not text.startswith(UNTRUSTED_PREFIX):
        try:
            decoded = _b64decode(text).decode("utf-8")
        except (MinisignError, UnicodeDecodeError):
            decoded = ""
        if decoded.startswith(UNTRUSTED_PREFIX):
            text = decoded.strip()
    lines = [line for line in text.splitlines() if line.strip()]
    blob_line = next(
        (line for line in lines if not line.startswith(UNTRUSTED_PREFIX)), ""
    )
    if blob_line == "":
        raise MinisignError("the public key has no key line")
    blob = _b64decode(blob_line.strip())
    if len(blob) != PUBLIC_KEY_BLOB_LENGTH:
        raise MinisignError(
            f"public key block is {len(blob)} bytes, not {PUBLIC_KEY_BLOB_LENGTH}"
        )
    if blob[:2] != SIGNATURE_ALGORITHM:
        raise MinisignError(f"unsupported public key algorithm {blob[:2]!r}")
    return TrustedKey(key_id=blob[2:10], public_key=blob[10:])


def signature_problems(trusted: TrustedKey, data: bytes, value: str) -> list[str]:
    """Why `value` does not authenticate `data` under `trusted` (empty when it does)."""
    try:
        parsed = parse_signature(value)
    except MinisignError as error:
        return [str(error)]
    if parsed.key_id != trusted.key_id:
        return [
            f"the signature was made by key {parsed.key_id_text}, but the trusted release key "
            f"is {trusted.key_id_text}"
        ]
    if not _verify_detached(trusted.public_key, data, parsed.signature,
                            prehashed=parsed.prehashed):
        return [
            f"the signature does not verify over these bytes under key {trusted.key_id_text} "
            "(the artifact was modified or the signature belongs to another file)"
        ]
    covered = parsed.signature + parsed.trusted_comment.encode("utf-8")
    if not (
        _verify_detached(trusted.public_key, covered, parsed.global_signature,
                         prehashed=False)
        or _verify_detached(trusted.public_key, covered, parsed.global_signature,
                            prehashed=True)
    ):
        return ["the signature's trusted comment is not covered by its global signature"]
    return []


def file_signature_problems(trusted: TrustedKey, path: Path, value: str) -> list[str]:
    return signature_problems(trusted, Path(path).read_bytes(), value)
