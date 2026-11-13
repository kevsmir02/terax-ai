#!/usr/bin/env python3
"""Generate Codr's offline release-signing key (issue #40, breakdown ticket 39).

Run by the maintainer, once, on a machine they control (never in CI and never in a container
built from this repository):

    python3 scripts/provision_signing_key.py --directory ~/.config/codr/release-keys

What it does:

* generates a passphrase-protected minisign keypair with the `minisign` tool (`minisign -G`), so
  custody stays in the standard format the release workflow's signer already reads;
* refuses to run when a key already exists at the destination (there is no `--force`, because
  replacing a release key is a documented incident procedure, not a flag
  in `docs/architecture/release-trust.md`);
* refuses a destination inside the repository, so the secret cannot be committed by accident;
* prints the **public** key file, its key id and its fingerprint, and nothing else; the secret is
  never read, printed, copied or written by this script.

`--inspect` prints the same public details for an existing key file, which is what a reviewer
compares against the fingerprint recorded in the repository.

`--minisign <path>` exists for tests: it selects the binary to invoke, so the refusal and
never-writes-into-the-repository behaviour can be asserted without a real keypair.
"""

from __future__ import annotations

import argparse
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import minisign  # noqa: E402

PUBLIC_NAME = "codr-release.pub"
SECRET_NAME = "codr-release.key"
EXIT_OK = 0
EXIT_REFUSED = 3
EXIT_USAGE = 2


def _inside_repository(path: Path) -> bool:
    resolved = path.resolve()
    repository = REPO_ROOT.resolve()
    return resolved == repository or repository in resolved.parents


def inspect(public_key: Path) -> int:
    try:
        key = minisign.parse_public_key(Path(public_key).read_text(encoding="utf-8"))
    except (OSError, minisign.MinisignError) as error:
        print(f"refusing: public-key-unreadable: {error}", file=sys.stderr)
        return EXIT_REFUSED
    print(f"public key: {public_key}")
    print(f"key id: {key.key_id_text}")
    print(f"fingerprint: {key.fingerprint}")
    print("(record the key id and fingerprint only; never the secret key)")
    return EXIT_OK


def provision(directory: Path, binary: str) -> int:
    if _inside_repository(directory):
        print(
            "refusing: destination-inside-repository: "
            f"{directory} is inside {REPO_ROOT}; the signing secret must never be able to reach "
            "the repository. Choose a directory outside it (e.g. ~/.config/codr/"
            "release-keys)",
            file=sys.stderr,
        )
        return EXIT_REFUSED

    public_key = directory / PUBLIC_NAME
    secret_key = directory / SECRET_NAME
    existing = [path.name for path in (public_key, secret_key) if path.exists()]
    if existing:
        print(
            "refusing: key-already-exists: "
            f"{directory} already holds {', '.join(sorted(existing))}. A release key is not "
            "overwritten in place; replacing it is the documented incident procedure in "
            "docs/architecture/release-trust.md",
            file=sys.stderr,
        )
        return EXIT_REFUSED

    tool = shutil.which(binary)
    if tool is None:
        print(
            f"refusing: provisioning-tool-missing: {binary!r} is not on PATH. Install minisign "
            "(the standard minisign key format is what the release workflow's signer reads) and "
            "run this again",
            file=sys.stderr,
        )
        return EXIT_REFUSED

    directory.mkdir(parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    command = [tool, "-G", "-p", str(public_key), "-s", str(secret_key)]
    print(f"generating a passphrase-protected minisign keypair with {tool}")
    print("minisign will ask for the passphrase twice; nothing is logged by this script")
    result = subprocess.run(command)
    if result.returncode != 0:
        print(
            "refusing: key-generation-failed: minisign exited "
            f"{result.returncode}; no key was provisioned. A partial keypair, if any, is in "
            f"{directory} and must be removed by hand before retrying",
            file=sys.stderr,
        )
        return EXIT_REFUSED
    if not public_key.is_file() or not secret_key.is_file():
        print(
            "refusing: key-generation-failed: minisign reported success but did not write "
            f"{public_key.name} and {secret_key.name}",
            file=sys.stderr,
        )
        return EXIT_REFUSED

    os.chmod(secret_key, stat.S_IRUSR | stat.S_IWUSR)
    os.chmod(public_key, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)

    print()
    status = inspect(public_key)
    if status != EXIT_OK:
        return status
    print()
    print(f"secret key: {secret_key} (mode 0600, passphrase-protected, never commit or paste it)")
    print()
    print("next steps (each is a deliberate, reviewed change):")
    print("  1. commit the public key value into src/modules/updater/releaseContract.json:")
    print("     trust.provisioned = true and trust.publicKey = the base64 public key on the line")
    print("     after 'untrusted comment:' (or base64 of the whole file).")
    print("  2. add the repository secrets the release workflow reads, at release time only:")
    print("     TERAX_RELEASE_SIGNING_KEY          = the base64 secret key file content")
    print("     TERAX_RELEASE_SIGNING_KEY_PASSPHRASE = its passphrase")
    print("  3. store an offline, encrypted copy of the secret key and record where it is in")
    print("     your password manager (never in this repository).")
    print("  4. delete any local plaintext copy that is not the custody copy.")
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Generate this fork's offline, passphrase-protected minisign release key. Prints the "
            "public key and fingerprint; never prints or writes the secret into the repository."
        )
    )
    parser.add_argument("--directory", default=None,
                        help="where the keypair lives (must be outside this repository)")
    parser.add_argument("--inspect", default=None,
                        help="print the key id and fingerprint of an existing public key file")
    parser.add_argument("--minisign", default="minisign",
                        help="minisign binary to invoke (tests point this at a stand-in)")
    arguments = parser.parse_args(argv)

    if arguments.inspect:
        return inspect(Path(arguments.inspect))
    if not arguments.directory:
        parser.error("--directory is required unless --inspect is given")
    return provision(Path(arguments.directory).expanduser(), arguments.minisign)


if __name__ == "__main__":
    raise SystemExit(main())
