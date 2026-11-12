"""Linux package candidates for this fork: identity, bundle configuration and the manifest.

The candidate path is deliberately narrow: one architecture (`x86_64`), two formats (`rpm`,
`deb`) and a source-built Arch recipe. The Tauri bundler is driven with a generated config
overlay so the shipped metadata comes from the identity table
(`src/modules/identity/namespace.json`) instead of repeated literals, and artwork/app identity
that is still undecided (tickets #39/#40) never leaks into a package.

`manifest_document()` is pure: it assembles the machine-readable record from values the runner
measured. The inspection helpers below read the produced `.rpm`/`.deb` with tools that exist on
a machine without `dpkg`/`sudo` (the deb is an `ar` archive; the rpm is read with `rpm`/`cpio`).

What this module can prove: the artifacts exist at a recorded revision, carry the candidate
identity, declare the WebKitGTK/GTK runtime, and contain the binaries, resources and licences
listed here. What it cannot prove: that a package installs, upgrades or removes on Fedora 44 or
Debian 13, that the GUI starts from an installed package, or anything about signing/trust. Those
are the packaged-app seam of the spec and stay explicit, unclaimed `notValidated` entries.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import lzma
import platform
import re
import shutil
import subprocess
import tarfile
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
IDENTITY_FILE = REPO_ROOT / "src/modules/identity/namespace.json"
TAURI_CONFIG = REPO_ROOT / "src-tauri/tauri.conf.json"
CARGO_MANIFEST = REPO_ROOT / "src-tauri/Cargo.toml"
PACKAGE_JSON = REPO_ROOT / "package.json"
RELEASE_CONTRACT = REPO_ROOT / "src/modules/updater/releaseContract.json"
PKGBUILD = REPO_ROOT / "packaging/arch/PKGBUILD"
OUTPUT_ROOT = REPO_ROOT / "dist-packages"

# The only candidate target. `tauri build` refuses other targets in the runner, and the
# bundler is invoked with this triple explicitly so a host arch cannot silently change it.
TARGET_TRIPLE = "x86_64-unknown-linux-gnu"
HOST_MACHINE = "x86_64"
RPM_ARCH = "x86_64"
DEB_ARCH = "amd64"
BUNDLE_TARGETS = ("rpm", "deb")

# Runtime libraries the packaged app links against live in the bundle config
# (`src-tauri/tauri.conf.json`), so a plain `tauri build` and the candidate overlay cannot
# disagree. `deb_depends()`/`rpm_depends()` read the effective config; only the Arch
# ecosystem's names are separate.
#
# Tauri CLI appends these runtime dependencies to every Linux deb and the matching sonames
# to every Linux rpm (`crates/tauri-cli/src/interface/rust.rs`), so the bundle config must not
# repeat them (a repeated entry appears twice in the control file). Debian 13 renamed the GTK
# package in the time_t transition to `libgtk-3-0t64`, which Provides `libgtk-3-0`; the
# appended name therefore resolves there too. This was not executed on Debian.
TAURI_INJECTED_DEB_DEPENDS = ("libwebkit2gtk-4.1-0", "libgtk-3-0")
TAURI_INJECTED_RPM_SONAMES = (
    "libwebkit2gtk-4.1.so.0()(64bit)",
    "libgtk-3.so.0()(64bit)",
)
ARCH_DEPENDS = ("webkit2gtk-4.1", "gtk3")
# Matches the webkit and GTK runtime in either ecosystem's spelling.
WEBKIT_GTK = re.compile(r"(webkit2gtk|libwebkit2gtk)", re.IGNORECASE)
GTK = re.compile(r"(^|[-_])gtk3($|[-_])|libgtk-3", re.IGNORECASE)

MANIFEST_SCHEMA_VERSION = 1
MANIFEST_KIND = "terax-workspace-linux-package-candidate"

REQUIRED_MANIFEST_FIELDS = (
    "schemaVersion",
    "kind",
    "candidate",
    "revision",
    "host",
    "toolchain",
    "inputs",
    "targets",
    "artifacts",
    "dependencies",
    "validation",
    "knownGaps",
    "notValidated",
)
REQUIRED_CANDIDATE_FIELDS = (
    "productName",
    "vendor",
    "packageName",
    "cliBinaryName",
    "appIdentifier",
    "namespace",
    "version",
    "provisional",
    "finalIdentityTicket",
    "identitySource",
)
REQUIRED_ARTIFACT_FIELDS = (
    "format",
    "arch",
    "fileName",
    "path",
    "sizeBytes",
    "sha256",
    "packageName",
    "version",
    "depends",
    "files",
    "binaries",
    "licenses",
)

# Everything a candidate does not establish. Recorded verbatim in the manifest so a reader
# cannot mistake extraction for runtime certification.
NOT_VALIDATED = (
    "install, upgrade and remove of either artifact with a real package manager",
    "the graphical application started from an installed package on Fedora 44 KDE Wayland",
    "Debian 13 graphical WebKitGTK behaviour",
    "Arch packaging: the PKGBUILD is authored, not built, and no makepkg run exists",
    "dependency resolution by dnf/apt/pacman (no package transaction was executed)",
    "signature/trust provisioning and update-artifact verification",
    "updater discovery, download approval and installation (issue #37)",
    "coexistence with an installed upstream Terax build in one profile",
)

KNOWN_GAPS = (
    "Update discovery is issue #37: this candidate inherits the fork-owned release contract "
    "(non-live `.invalid` endpoint, no provisioned trust root), so it cannot query or install "
    "an upstream release. Until #39/#40 provision the real endpoint and key, no update can be "
    "verified, and candidates must not be published.",
    "The deb Maintainer field is derived by Tauri from the Cargo authors (upstream credit), "
    "not from the candidate vendor. Final maintainer/branding identity is tickets #39/#40.",
    "The CLI launcher command exposed inside terminal sessions is still `terax` (documented "
    "deferral in docs/architecture/namespace-isolation.md); only the installed sidecar path "
    "moved to the candidate name.",
)


@dataclass(frozen=True)
class Candidate:
    product_name: str
    vendor: str
    package_name: str
    cli_binary_name: str
    short_description: str
    long_description: str
    app_identifier: str
    namespace: str
    version: str

    @property
    def slug(self) -> str:
        """Stable file/dir token: the kebab package name."""
        return self.package_name


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def identity_table() -> dict:
    """The single source of the fork's names (read by the Rust app, TS checks and runners)."""
    return _load_json(IDENTITY_FILE)


def _cargo_version() -> str:
    text = CARGO_MANIFEST.read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    if not match:
        raise ValueError("src-tauri/Cargo.toml has no package version")
    return match.group(1)


def version() -> str:
    """The version every packaging input must agree on."""
    table = _load_json(TAURI_CONFIG)
    tauri_version = table["version"]
    package_version = _load_json(PACKAGE_JSON)["version"]
    cargo_version = _cargo_version()
    versions = {"tauri.conf.json": tauri_version, "package.json": package_version,
                "Cargo.toml": cargo_version}
    if len(set(versions.values())) != 1:
        raise ValueError(f"packaging inputs disagree on the version: {versions}")
    return tauri_version


def candidate() -> Candidate:
    """The private candidate identity, derived from the shared table."""
    table = identity_table()
    packaging = table["packaging"]
    return Candidate(
        product_name=packaging["productName"],
        vendor=packaging["vendor"],
        package_name=packaging["packageName"],
        cli_binary_name=packaging["cliBinaryName"],
        short_description=packaging["shortDescription"],
        long_description=packaging["longDescription"],
        app_identifier=table["appIdentifier"],
        namespace=table["namespace"],
        version=version(),
    )


def upstream_names() -> set[str]:
    """Names a candidate must not be equal to (upstream identity and its package paths)."""
    upstream = identity_table()["upstream"]
    names = {
        upstream["appIdentifier"],
        upstream["namespace"],
        upstream["envPrefix"],
        upstream["productName"],
        upstream["publisher"],
        f"{upstream['namespace']}-cli",
    }
    return {name.lower() for name in names}


def identity_problems(candidate_identity: Candidate | None = None) -> list[str]:
    """Why this identity is not a private candidate (empty when it is)."""
    c = candidate_identity or candidate()
    table = identity_table()
    upstream = table["upstream"]
    forbidden = upstream_names()
    found: list[str] = []
    for label, value in (
        ("productName", c.product_name),
        ("vendor", c.vendor),
        ("packageName", c.package_name),
        ("cliBinaryName", c.cli_binary_name),
    ):
        if value.lower() in forbidden:
            found.append(f"{label} {value!r} is an upstream name")
    if not c.package_name.startswith(c.namespace):
        found.append(f"packageName {c.package_name!r} does not carry the fork namespace")
    if not c.cli_binary_name.startswith(c.namespace):
        found.append(f"cliBinaryName {c.cli_binary_name!r} does not carry the fork namespace")
    if c.app_identifier != table["appIdentifier"]:
        found.append(f"appIdentifier {c.app_identifier!r} is not the table's identifier")
    if c.app_identifier.lower() in forbidden or c.app_identifier.startswith(
        upstream["appIdentifier"] + "."
    ):
        found.append(f"appIdentifier {c.app_identifier!r} belongs to upstream")
    if not table.get("provisional", False):
        found.append("the identity table is no longer marked provisional")
    return found


def package_name_problems(candidate_identity: Candidate | None = None) -> list[str]:
    """The Linux package name Tauri derives must be the candidate's own kebab name."""
    c = candidate_identity or candidate()
    # tauri-bundler uses heck's kebab-case of `productName` for both the deb and rpm Name.
    derived = re.sub(r"[^0-9a-z]+", "-", c.product_name.lower()).strip("-")
    return [] if derived == c.package_name else [
        f"productName {c.product_name!r} derives package name {derived!r}, "
        f"not {c.package_name!r}"
    ]


def target_problems(system: str | None = None, machine: str | None = None) -> list[str]:
    """Why this host cannot produce the candidate set (empty when it can)."""
    system = system or platform.system()
    machine = machine or platform.machine()
    found: list[str] = []
    if system != "Linux":
        found.append(f"host system is {system!r}: candidates are Linux-only")
    if machine.lower() not in (HOST_MACHINE, "amd64"):
        found.append(f"host machine is {machine!r}: candidates are x86_64-only")
    return found


def candidate_config() -> dict:
    """The Tauri config overlay that turns the base config into a candidate bundle.

    Only fields that must change are set; resources, icons, CSP and file associations are
    inherited from `src-tauri/tauri.conf.json`, so the two cannot drift.
    """
    c = candidate()
    return {
        "productName": c.product_name,
        "mainBinaryName": c.package_name,
        "identifier": c.app_identifier,
        "version": c.version,
        "bundle": {
            "createUpdaterArtifacts": False,
            "publisher": c.vendor,
            "copyright": "Copyright 2026 Crynta and Terax Workspace contributors",
            "shortDescription": c.short_description,
            "longDescription": c.long_description,
        },
        # A candidate inherits the fork-owned release contract (see
        # `src/modules/updater/releaseContract.json`): a non-live `.invalid` endpoint and no
        # trust root until #39/#40. It must never carry upstream's feed or key, which is what
        # `updater_problems()` checks. Issue #37 owns discovery behaviour.
    }


def updater_settings(base: dict | None = None, overlay: dict | None = None) -> dict:
    """The effective updater plugin settings after config merge."""
    overlay = overlay if overlay is not None else candidate_config()
    base = base if base is not None else _load_json(TAURI_CONFIG)
    settings = dict(((base.get("plugins") or {}).get("updater") or {}))
    settings.update(((overlay.get("plugins") or {}).get("updater") or {}))
    return settings


def updater_problems(base: dict | None = None, overlay: dict | None = None) -> list[str]:
    """Why a candidate would not follow the fork-owned, non-upstream release contract."""
    contract = _load_json(RELEASE_CONTRACT)
    settings = updater_settings(base, overlay)
    endpoints = list(settings.get("endpoints") or [])
    upstream_endpoints = set(contract["upstream"]["endpoints"])
    found: list[str] = []
    if endpoints != contract["endpoints"]:
        found.append(
            f"updater endpoints {endpoints!r} do not match the fork release contract "
            f"{contract['endpoints']!r}"
        )
    for endpoint in endpoints:
        if endpoint in upstream_endpoints or "crynta/terax-ai" in endpoint:
            found.append(f"updater endpoint {endpoint!r} is upstream's release feed")
    if settings.get("pubkey", "") != contract["trust"]["publicKey"]:
        found.append(
            "updater pubkey does not match the release contract's trust entry "
            "(a candidate may not embed an unprovisioned or upstream key)"
        )
    return found


def merged_bundle_config(base: dict | None = None, overlay: dict | None = None) -> dict:
    """A shallow-merge view of the effective bundle settings (tauri merges per key)."""
    base = base if base is not None else _load_json(TAURI_CONFIG)
    overlay = overlay if overlay is not None else candidate_config()
    bundle = dict(base.get("bundle", {}))
    for key, value in overlay.get("bundle", {}).items():
        if isinstance(value, dict) and isinstance(bundle.get(key), dict):
            merged = dict(bundle[key])
            merged.update(value)
            bundle[key] = merged
        else:
            bundle[key] = value
    return bundle


def deb_depends(base: dict | None = None, overlay: dict | None = None) -> list[str]:
    """The effective deb runtime dependencies: config entries plus Tauri's injected pair."""
    configured = list(
        merged_bundle_config(base, overlay).get("linux", {}).get("deb", {}).get("depends") or []
    )
    return configured + [
        dependency
        for dependency in TAURI_INJECTED_DEB_DEPENDS
        if dependency not in configured
    ]


def rpm_depends(base: dict | None = None, overlay: dict | None = None) -> list[str]:
    """The effective rpm runtime dependencies: configured names plus Tauri's sonames."""
    configured = list(
        merged_bundle_config(base, overlay).get("linux", {}).get("rpm", {}).get("depends") or []
    )
    return configured + [
        soname for soname in TAURI_INJECTED_RPM_SONAMES if soname not in configured
    ]


def config_problems(base: dict | None = None, overlay: dict | None = None) -> list[str]:
    """Why the effective candidate bundle config is wrong (empty when it is right)."""
    base = base if base is not None else _load_json(TAURI_CONFIG)
    overlay = overlay if overlay is not None else candidate_config()
    bundle = merged_bundle_config(base, overlay)
    c = candidate()
    found: list[str] = []

    targets = bundle.get("targets")
    if not isinstance(targets, list) or sorted(targets) != sorted(BUNDLE_TARGETS):
        found.append(
            f"bundle.targets is {targets!r}; the candidate path emits only {list(BUNDLE_TARGETS)}"
        )
    for unsupported in ("appimage", "nsis", "msi", "dmg"):
        if unsupported in (targets or []):
            found.append(f"bundle.targets contains unsupported format {unsupported!r}")
    if bundle.get("createUpdaterArtifacts") is not False:
        found.append("bundle.createUpdaterArtifacts must be false: candidates are not signed updates")
    if overlay.get("mainBinaryName") != c.package_name:
        found.append("the overlay must install the binary under the candidate package name")
    if overlay.get("productName") != c.product_name:
        found.append("the overlay must carry the candidate product name")
    if overlay.get("identifier") != c.app_identifier:
        found.append("the overlay must carry the table's bundle identifier")
    external = bundle.get("externalBin") or []
    if external != [f"binaries/{c.cli_binary_name}"]:
        found.append(
            f"bundle.externalBin is {external!r}; the candidate installs "
            f"binaries/{c.cli_binary_name}"
        )

    # Tauri's config merge concatenates arrays (`depends` came out duplicated when both
    # configs listed it), so the overlay may only carry identity/scalar fields. The base
    # config is the single place for targets and dependencies.
    overlay_bundle = overlay.get("bundle") or {}
    if "targets" in overlay_bundle:
        found.append("the overlay must not repeat bundle.targets: the base config owns it")
    if "linux" in overlay_bundle:
        found.append(
            "the overlay must not repeat bundle.linux.depends: the base config owns the "
            "runtime dependency list"
        )

    # A candidate follows the fork-owned release contract and never upstream's feed/key.
    found.extend(updater_problems(base, overlay))

    configured_deb = list(bundle.get("linux", {}).get("deb", {}).get("depends") or [])
    for dependency in configured_deb:
        if dependency in TAURI_INJECTED_DEB_DEPENDS:
            found.append(
                f"deb depends {dependency!r} repeats a dependency Tauri CLI appends; "
                "it would appear twice in the control file"
            )
    for label, depends in (("deb", deb_depends(base, overlay)), ("rpm", rpm_depends(base, overlay))):
        if not any(WEBKIT_GTK.search(dep) for dep in depends):
            found.append(f"{label} depends {depends!r} lacks the WebKitGTK runtime")
        if not any(GTK.search(dep) for dep in depends):
            found.append(f"{label} depends {depends!r} lacks the GTK3 runtime")
    return found


def arch_problems(recipe: str | None = None) -> list[str]:
    """Why the committed Arch recipe is not aligned with this candidate (empty when it is)."""
    c = candidate()
    text = PKGBUILD.read_text(encoding="utf-8") if recipe is None else recipe
    found: list[str] = []

    def field(name: str) -> str | None:
        match = re.search(rf"^{name}=(.+)$", text, re.MULTILINE)
        return match.group(1).strip() if match else None

    pkgver = field("pkgver")
    if pkgver != c.version:
        found.append(f"PKGBUILD pkgver {pkgver!r} does not match {c.version!r}")
    pkgname = field("pkgname")
    if pkgname != c.package_name:
        found.append(f"PKGBUILD pkgname {pkgname!r} is not the candidate package {c.package_name!r}")
    arch = field("arch")
    if arch != "('x86_64')":
        found.append(f"PKGBUILD arch {arch!r} is not x86_64-only")
    if not re.search(r"^_commit=[0-9a-f]{40}$", text, re.MULTILINE):
        found.append("PKGBUILD does not pin a 40-hex _commit")
    depends = field("depends")
    for dep in ARCH_DEPENDS:
        if not depends or f"'{dep}'" not in depends:
            found.append(f"PKGBUILD depends {depends!r} lacks {dep!r}")
    for stale in ("terax-cli", "pkgname=terax "):
        if stale in text:
            found.append(f"PKGBUILD still refers to upstream packaging {stale!r}")
    return found


# ---------------------------------------------------------------------------------------------
# Manifest assembly (pure) and schema checks
# ---------------------------------------------------------------------------------------------


def manifest_document(
    *,
    revision: dict,
    host: dict,
    toolchain: dict,
    inputs: list[dict],
    artifacts: list[dict],
    dependencies: dict,
    validation: dict,
    candidate_identity: Candidate | None = None,
    known_gaps: tuple[str, ...] = KNOWN_GAPS,
    not_validated: tuple[str, ...] = NOT_VALIDATED,
) -> dict:
    """Assemble the machine-readable candidate record. No measurement happens here."""
    c = candidate_identity or candidate()
    return {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "kind": MANIFEST_KIND,
        "candidate": {
            "productName": c.product_name,
            "vendor": c.vendor,
            "packageName": c.package_name,
            "cliBinaryName": c.cli_binary_name,
            "appIdentifier": c.app_identifier,
            "namespace": c.namespace,
            "version": c.version,
            "provisional": identity_table().get("provisional", False),
            "finalIdentityTicket": identity_table().get("finalIdentityTicket"),
            "identitySource": str(IDENTITY_FILE.relative_to(REPO_ROOT)),
        },
        "revision": revision,
        "host": host,
        "toolchain": toolchain,
        "inputs": inputs,
        "targets": {
            "bundleTargets": list(BUNDLE_TARGETS),
            "targetTriple": TARGET_TRIPLE,
            "rpmArch": RPM_ARCH,
            "debArch": DEB_ARCH,
            "hostMachine": host.get("machine"),
        },
        "artifacts": artifacts,
        "dependencies": dependencies,
        "validation": validation,
        "knownGaps": list(known_gaps),
        "notValidated": list(not_validated),
    }


def manifest_problems(document: dict) -> list[str]:
    """Schema invariants the guard test and the runner both enforce."""
    found: list[str] = []
    for field in REQUIRED_MANIFEST_FIELDS:
        if field not in document:
            found.append(f"manifest is missing {field!r}")
    if document.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        found.append("manifest schemaVersion is not the current schema")
    if document.get("kind") != MANIFEST_KIND:
        found.append("manifest kind is not the candidate kind")

    identity = document.get("candidate") or {}
    for field in REQUIRED_CANDIDATE_FIELDS:
        if field not in identity:
            found.append(f"manifest candidate is missing {field!r}")
    if identity.get("provisional") is not True:
        found.append("manifest must mark the candidate identity provisional")
    if str(identity.get("appIdentifier", "")).startswith(
        identity_table()["upstream"]["appIdentifier"]
    ):
        found.append("manifest candidate identity belongs to upstream")

    if not document.get("notValidated"):
        found.append("manifest must list what was not validated")
    if not document.get("knownGaps"):
        found.append("manifest must list the known identity/update gaps")

    artifacts = document.get("artifacts")
    if not artifacts:
        found.append("manifest has no artifacts")
    targets = set((document.get("targets") or {}).get("bundleTargets") or [])
    formats = {artifact.get("format") for artifact in artifacts or []}
    if targets != set(BUNDLE_TARGETS) or formats != set(BUNDLE_TARGETS):
        found.append(f"manifest artifacts {sorted(formats)} do not match targets {sorted(targets)}")
    for artifact in artifacts or []:
        for field in REQUIRED_ARTIFACT_FIELDS:
            if field not in artifact:
                found.append(f"{artifact.get('format', '?')} artifact is missing {field!r}")
        if artifact.get("arch") not in (RPM_ARCH, DEB_ARCH):
            found.append(f"artifact arch {artifact.get('arch')!r} is not x86-64")
        if not re.fullmatch(r"[0-9a-f]{64}", str(artifact.get("sha256", ""))):
            found.append(f"artifact {artifact.get('fileName')!r} has no sha256")
        if not artifact.get("licenses"):
            found.append(f"artifact {artifact.get('fileName')!r} lists no licence resources")
    return found


# ---------------------------------------------------------------------------------------------
# Hashing and artifact inspection (measured, not assumed)
# ---------------------------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _run(command: list[str], *, cwd: Path | None = None, stdin: bytes | None = None) -> bytes:
    result = subprocess.run(
        command,
        cwd=cwd,
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return result.stdout


def ar_members(path: Path) -> dict[str, bytes]:
    """Members of a System V `ar` archive (the deb container) without `dpkg`."""
    data = Path(path).read_bytes()
    if not data.startswith(b"!<arch>\n"):
        raise ValueError(f"{path} is not an ar archive")
    members: dict[str, bytes] = {}
    offset = len(b"!<arch>\n")
    while offset + 60 <= len(data):
        header = data[offset : offset + 60]
        name = header[0:16].decode("ascii").strip()
        size_text = header[48:58].decode("ascii").strip()
        if not size_text.isdigit():
            break
        size = int(size_text)
        offset += 60
        payload = data[offset : offset + size]
        if name.startswith("#1/"):  # BSD long name
            name_length = int(name[3:])
            name = payload[:name_length].decode("ascii").rstrip("\x00")
            payload = payload[name_length:]
        members[name.rstrip("/")] = payload
        offset += size + (size % 2)
    return members


def _tar_bytes(name: str, payload: bytes) -> tarfile.TarFile:
    if name.endswith(".tar.gz"):
        raw = gzip.decompress(payload)
    elif name.endswith(".tar.xz"):
        raw = lzma.decompress(payload)
    elif name.endswith(".tar.zst"):
        raw = _run(["zstd", "-dc"], stdin=payload)
    elif name.endswith(".tar"):
        raw = payload
    else:
        raise ValueError(f"unsupported tar member {name!r}")
    return tarfile.open(fileobj=io.BytesIO(raw), mode="r:")


def deb_control(path: Path) -> dict[str, str]:
    """The deb `control` fields, parsed from the archive itself (no dpkg)."""
    members = ar_members(path)
    control_member = next(
        (name for name in members if name.startswith("control.tar")), None
    )
    if control_member is None:
        raise ValueError(f"{path} has no control archive")
    with _tar_bytes(control_member, members[control_member]) as archive:
        for member in archive.getmembers():
            if Path(member.name).name == "control":
                raw = archive.extractfile(member).read().decode("utf-8")  # type: ignore[union-attr]
                break
        else:
            raise ValueError(f"{path} control archive has no control file")
    fields: dict[str, str] = {}
    key = None
    for line in raw.splitlines():
        if line.startswith(" ") and key:
            fields[key] += "\n" + line.strip()
        elif ":" in line:
            key, value = line.split(":", 1)
            fields[key.strip()] = value.strip()
    return fields


def extract_deb(path: Path, destination: Path) -> list[dict]:
    """Unpack a deb's data tar (no dpkg, no root) and describe every regular file."""
    members = ar_members(path)
    data_member = next((name for name in members if name.startswith("data.tar")), None)
    if data_member is None:
        raise ValueError(f"{path} has no data archive")
    destination.mkdir(parents=True, exist_ok=True)
    with _tar_bytes(data_member, members[data_member]) as archive:
        archive.extractall(destination, filter="tar")
    return describe_tree(destination)


def extract_rpm(path: Path, destination: Path) -> list[dict]:
    """Unpack an rpm payload with rpm2cpio+cpio (both available without root)."""
    destination.mkdir(parents=True, exist_ok=True)
    payload = _run(["rpm2cpio", str(path)])
    subprocess.run(
        ["cpio", "-idm", "--quiet", "--no-absolute-filenames"],
        cwd=destination,
        input=payload,
        check=True,
    )
    return describe_tree(destination)


def describe_tree(root: Path) -> list[dict]:
    """Relative path, kind, mode, size and sha256 for every regular file under `root`."""
    files: list[dict] = []
    for path in sorted(Path(root).rglob("*")):
        if not path.is_file():
            continue
        relative = "/" + path.relative_to(root).as_posix()
        files.append(
            {
                "path": relative,
                "sizeBytes": path.stat().st_size,
                "mode": oct(path.stat().st_mode & 0o777),
                "sha256": sha256_file(path),
                "kind": classify_path(relative),
            }
        )
    return files


def classify_path(path: str) -> str:
    """What a package path is, for the manifest's binary/resource/licence inventory."""
    if path.endswith(".txt") and "/licenses/" in path:
        return "license"
    if path.startswith("/usr/bin/"):
        return "cli" if "cli" in Path(path).name else "binary"
    if path.startswith("/usr/share/applications/"):
        return "desktop"
    if path.startswith("/usr/share/icons/"):
        return "icon"
    if path.startswith("/usr/lib/") or path.startswith("/usr/share/"):
        return "resource"
    if path.startswith("/usr/share/doc/"):
        return "doc"
    return "other"


def rpm_query(path: Path, *arguments: str) -> str:
    """Query an rpm file with the host's rpm (no installation, no root)."""
    return _run(["rpm", *arguments, str(path)]).decode("utf-8", "replace")


def rpm_metadata(path: Path) -> dict:
    """Name/version/release/arch/summary/licence/vendor header fields plus requires."""
    keys = ("NAME", "VERSION", "RELEASE", "ARCH", "SUMMARY", "LICENSE", "VENDOR", "URL")
    query = "\t".join(f"%{{{key}}}" for key in keys)
    values = rpm_query(path, "-qp", "--queryformat", query).split("\t")
    metadata = {
        key.lower(): value.strip() for key, value in zip(keys, values)
    }
    requires = rpm_query(path, "-qp", "--requires").splitlines()
    metadata["requires"] = [line.strip() for line in requires if line.strip()]
    return metadata


def parse_rpm_dump(lines: list[str]) -> list[dict]:
    """Parse `rpm -qlp --dump` lines; the path may contain spaces."""
    files: list[dict] = []
    for line in lines:
        # Take the ten fixed fields from the right: size mtime digest mode owner group
        # isconfig isdoc rdev symlink.
        parts = line.rsplit(None, 10)
        if len(parts) != 11:
            continue
        path_text, size_text, _mtime, _digest, mode_text = parts[:5]
        mode = int(mode_text, 8)
        if (mode & 0o170000) != 0o100000:  # keep regular files only
            continue
        files.append(
            {
                "path": path_text,
                "sizeBytes": int(size_text),
                "mode": format(mode & 0o777, "04o"),
                "kind": classify_path(path_text),
            }
        )
    return files


def rpm_files(path: Path) -> list[dict]:
    """Regular payload files with sizes and modes, from the rpm header (no extraction)."""
    return parse_rpm_dump(rpm_query(path, "-qlp", "--dump").splitlines())


def elf_needed(binary: Path) -> list[str]:
    """The DT_NEEDED shared libraries of an ELF binary."""
    output = _run(["readelf", "-d", str(binary)]).decode("utf-8", "replace")
    return [match.group(1) for match in re.finditer(r"Shared library: \[(.+?)\]", output)]


def unresolved_libraries(binary: Path) -> list[str]:
    """`ldd` entries the host cannot resolve, recorded rather than asserted."""
    result = subprocess.run(
        ["ldd", str(binary)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    return [
        line.strip()
        for line in result.stdout.splitlines()
        if "not found" in line
    ]


def bundle_type_marker_difference(left: Path, right: Path) -> bool:
    """True when two copies of one binary differ only by Tauri's bundle-type marker.

    The bundler patches `TAURI_BUNDLE_TYPE_VAR_*` in the main binary per format, so the deb
    and rpm payloads are byte-identical except for three bytes (`DEB` versus `RPM`). Anything
    else is a real difference and must not be excused.
    """
    first = Path(left).read_bytes()
    second = Path(right).read_bytes()
    if len(first) != len(second):
        return False
    differing = [index for index, (a, b) in enumerate(zip(first, second)) if a != b]
    if len(differing) != 3 or differing != list(range(differing[0], differing[0] + 3)):
        return False
    start = differing[0]
    marker = b"TAURI_BUNDLE_TYPE_VAR_"
    if marker not in first[max(0, start - len(marker)) : start]:
        return False
    return {first[start : start + 3], second[start : start + 3]} == {b"DEB", b"RPM"}


def command_version(*command: str) -> str:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    text = (result.stdout or result.stderr).strip()
    return text.splitlines()[0] if text else ""


def host_record() -> dict:
    release = {}
    try:
        for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                release[key] = value.strip().strip('"')
    except OSError:
        pass
    return {
        "system": platform.system(),
        "machine": platform.machine(),
        "kernel": platform.release(),
        "distribution": release.get("PRETTY_NAME", ""),
        "distributionId": release.get("ID", ""),
        "distributionVersion": release.get("VERSION_ID", ""),
        "python": platform.python_version(),
    }


def toolchain_record() -> dict:
    commands = {
        "node": ("node", "--version"),
        "pnpm": ("pnpm", "--version"),
        "rustc": ("rustc", "--version"),
        "cargo": ("cargo", "--version"),
        "tauriCli": ("pnpm", "tauri", "--version"),
        "rpm": ("rpm", "--version"),
        "rpmbuild": ("rpmbuild", "--version"),
        "ar": ("ar", "--version"),
        "tar": ("tar", "--version"),
        "zstd": ("zstd", "--version"),
        "cpio": ("cpio", "--version"),
        "readelf": ("readelf", "--version"),
    }
    return {name: command_version(*command) for name, command in commands.items()}


def git_state(root: Path | None = None) -> dict:
    root = root or REPO_ROOT

    def git(*arguments: str) -> str:
        return _run(["git", "-C", str(root), *arguments]).decode("utf-8", "replace").strip()

    return {
        "commit": git("rev-parse", "HEAD"),
        "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
        "describe": git("describe", "--always", "--dirty", "--tags"),
        "dirty": bool(git("status", "--porcelain")),
    }


def install_layout(files: list[dict]) -> dict:
    """Bundled executables and licence resources, by role."""
    binaries = [entry for entry in files if entry["kind"] in ("binary", "cli")]
    licenses = [entry for entry in files if entry["kind"] == "license"]
    resources = [entry for entry in files if entry["kind"] in ("resource", "desktop", "icon", "doc")]
    return {"binaries": binaries, "licenses": licenses, "resources": resources}


def sha256sums(artifacts: list[dict]) -> str:
    """`sha256sum -c` compatible listing of the candidate files."""
    return "".join(f"{artifact['sha256']}  {artifact['fileName']}\n" for artifact in artifacts)


def disposable_install_root(output: Path) -> Path:
    """Where extracted package trees go: inside the run's output, never the user's profile."""
    return Path(output) / "extracted"


def which_or_none(name: str) -> str | None:
    return shutil.which(name)
