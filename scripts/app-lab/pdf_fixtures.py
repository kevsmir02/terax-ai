"""Deterministic PDF fixtures for the app-lab preview scenario (issue #30).

The PDF acceptance scenario needs documents whose facts are known before the app opens them: how
many pages, which strings a search must find, and a page whose *rendered* size crosses the
approved 32 MiB per-page ceiling only at the zoom the check asks for. This module writes those
files from PDF syntax directly (no renderer, no timestamp, no randomness), so a rebuild is
byte-identical and the fixtures can stay out of Git.

Public surface:

``build(directory)``
    Write the fixtures and return the manifest (sizes, hashes, page geometry, tokens, render
    sizes at each zoom). The app-lab runner passes this manifest to the in-app driver.
``verify(directory, manifest)``
    Check the written files with poppler (``pdfinfo``, ``pdftotext``, ``pdftoppm``): page count,
    page size, searchable text and a real raster. Raises ``FixtureError`` on a mismatch.
``render_bytes(page, zoom)``
    RGBA8 bytes for one rendered page at a zoom factor — the input ``pdfPageDecision`` takes.
``parse_page_ceiling(limits_ts)``
    The approved ceiling, read from the TypeScript owner instead of copied here.

Command line::

    python3 scripts/app-lab/pdf_fixtures.py --output DIR [--verify]

The ceiling is never restated in this file: ``docs/architecture/resource-limits.md`` records the
approval and ``src/modules/preview/lib/limits.ts`` owns the number, so the fixtures move if the
approved number moves.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import subprocess
import sys
from pathlib import Path

SCHEMA = "terax-pdf-fixtures/1"
#: Bytes per pixel for the decoded page raster the ceiling counts (RGBA8).
BYTES_PER_PIXEL = 4
#: A4 portrait in PostScript points — the representative document page.
A4 = {"widthPt": 595.276, "heightPt": 841.89}
#: 72 x 54 inches: fit-to-window is small, 100 % is far above the ceiling.
LARGE = {"widthPt": 5184.0, "heightPt": 3888.0}
#: Zooms whose rendered size the manifest records for the zoom-shaped fixtures.
ZOOMS = (0.25, 0.5, 1, 2, 4, 8)
PAGE_COUNT = 6
UNIQUE_NEEDLE = "UNIQUE-GLOBAL-NEEDLE"
UNIQUE_PAGE = 4

REPO = Path(__file__).resolve().parent.parent.parent
LIMITS_TS = REPO / "src/modules/preview/lib/limits.ts"


class FixtureError(RuntimeError):
    """A fixture does not have the property the scenario depends on."""


# ---------------------------------------------------------------------------------------------
# A minimal, deterministic PDF writer
# ---------------------------------------------------------------------------------------------


def _escape(text: str) -> bytes:
    raw = text.encode("latin-1")
    out = bytearray()
    for byte in raw:
        if byte in b"()\\":
            out += b"\\"
        out += bytes((byte,))
    return bytes(out)


def _text_line(font: str, size: float, x: float, y: float, text: str) -> bytes:
    return (
        b"BT /" + font.encode() + b" " + f"{size:g}".encode() + b" Tf 1 0 0 1 "
        + f"{x:g} {y:g}".encode() + b" Tm (" + _escape(text) + b") Tj ET\n"
    )


def _rect(x: float, y: float, width: float, height: float, stroke: float = 0.5) -> bytes:
    return (
        b"q " + f"{stroke:g} w {x:g} {y:g} {width:g} {height:g}".encode()
        + b" re S Q\n"
    )


def render_bytes(page: dict, zoom: float) -> int:
    """RGBA8 bytes for one page rendered at ``zoom`` (1 = 72 DPI, the PDF user-space size)."""
    if not math.isfinite(zoom) or zoom <= 0:
        raise FixtureError(f"zoom must be a positive finite number, got {zoom!r}")
    width = math.ceil(page["widthPt"] * zoom)
    height = math.ceil(page["heightPt"] * zoom)
    return width * height * BYTES_PER_PIXEL


def parse_page_ceiling(limits_ts: Path = LIMITS_TS) -> int:
    """The approved per-page ceiling, parsed from the TypeScript that owns it."""
    source = Path(limits_ts).read_text()
    mib = re.search(r"export const MIB = (\d+) \* (\d+);", source)
    page = re.search(r"pdf: \{[^}]*?pageBytes: (\d+) \* MIB", source, re.S)
    if not mib or not page:
        raise FixtureError(
            f"could not read the PDF page ceiling from {limits_ts}; "
            "did RESOURCE_LIMITS.pdf.pageBytes change shape?"
        )
    return int(page.group(1)) * int(mib.group(1)) * int(mib.group(2))


def _serialize(body_objects: list[bytes], info: bytes) -> bytes:
    """Catalog/pages first, then the objects the caller appended, then xref and trailer."""
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for number, body in enumerate(body_objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    info_number = len(body_objects) + 1
    offsets.append(len(out))
    out += f"{info_number} 0 obj\n".encode() + info + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {info_number + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        b"trailer\n<< /Size " + str(info_number + 1).encode()
        + b" /Root 1 0 R /Info " + str(info_number).encode() + b" 0 R >>\n"
    )
    out += b"startxref\n" + str(xref).encode() + b"\n%%EOF\n"
    return bytes(out)


def _document(pages: list[dict], metadata_padding: int = 0) -> bytes:
    """Write a document whose pages are ``{geometry, content}`` dictionaries.

    ``metadata_padding`` adds an XMP metadata stream of (about) that many bytes, which is how the
    fixture that is larger than the text-read ceiling gets its size without changing anything a
    renderer draws.
    """
    total = len(pages)
    # Object numbering is fixed: 1 catalog, 2 pages tree, 3/4 fonts, then page/content pairs, then
    # the optional metadata stream.
    metadata_number = 5 + 2 * total
    kids = " ".join(f"{5 + index * 2} 0 R" for index in range(total))
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R"
        + (f" /Metadata {metadata_number} 0 R".encode() if metadata_padding else b"")
        + b" >>",
        (
            f"<< /Type /Pages /Count {total} /Kids [ {kids} ] >>".encode()
        ),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ]
    for page in pages:
        geometry = page["geometry"]
        content = page["content"]
        objects.append(
            (
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "
                + f"{geometry['widthPt']:g} {geometry['heightPt']:g}".encode()
                + b"] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents "
                + f"{6 + (len(objects) - 4)} 0 R".encode()
                + b" >>"
            )
        )
        objects.append(
            b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream"
        )
    if metadata_padding:
        head = (
            b'<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
            b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF '
            b'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            b'<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" '
            b'pdf:Producer="scripts/app-lab/pdf_fixtures.py"/></rdf:RDF></x:xmpmeta>\n'
        )
        tail = b'<?xpacket end="w"?>\n'
        padding = max(metadata_padding - len(head) - len(tail), 0)
        body = head + b" " * padding + tail
        objects.append(
            b"<< /Type /Metadata /Subtype /XML /Length "
            + str(len(body)).encode()
            + b" >>\nstream\n"
            + body
            + b"endstream"
        )
    info = (
        b"<< /Title (Terax app-lab PDF fixture) "
        b"/Producer (scripts/app-lab/pdf_fixtures.py) "
        b"/CreationDate (D:20260101000000Z) >>"
    )
    return _serialize(objects, info)


def _text_page(number: int, total: int) -> bytes:
    """A page with a running header/footer and per-page searchable needles."""
    width, height = A4["widthPt"], A4["heightPt"]
    content = bytearray()
    content += _text_line("F2", 16, 56.7, height - 72, f"Terax PDF fixture: page {number} of {total}")
    content += _rect(56.7, height - 84, width - 113.4, 0)
    y = height - 116
    for line in range(1, 15):
        content += _text_line(
            "F1", 11, 56.7, y, f"{number:02d}.{line:02d} deterministic body line for page {number}"
        )
        y -= 18
    content += _text_line("F1", 11, 56.7, y - 12, f"SEARCH-NEEDLE-{number:02d}")
    if number == UNIQUE_PAGE:
        content += _text_line("F2", 12, 56.7, y - 36, f"{UNIQUE_NEEDLE} appears only here")
    content += _text_line("F1", 9, 56.7, 56, f"[[ page {number} of {total} ]]")
    return bytes(content)


def _grid_page(geometry: dict, label: str, columns: int, rows: int) -> bytes:
    """Sparse vector content: cheap to parse, expensive to raster at a high zoom."""
    width, height = geometry["widthPt"], geometry["heightPt"]
    content = bytearray()
    content += _text_line("F2", 14, 36, height - 48, label)
    step_x = (width - 72) / columns
    step_y = (height - 120) / rows
    for column in range(columns):
        for row in range(rows):
            content += _rect(
                36 + column * step_x,
                72 + row * step_y,
                step_x * 0.8,
                step_y * 0.8,
                stroke=0.25,
            )
    content += _text_line("F1", 8, 36, 48, f"{columns} x {rows} grid, {width:g} x {height:g} pt")
    return bytes(content)


CORRUPT = (
    b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"
    b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R\n"  # object never terminated
    b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 99 >>\nendobj\n"
    b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\n"
    b"4 0 obj\n<< /Length 4096 >>\nstream\nBT /F1 12 Tf (truncated\nendstream\n"
    b"\x00\xff\xde\xad\xbe\xef this stream length lies and the file stops here\n"
)

NOT_A_PDF = (
    b"<!doctype html><html><head><title>not a pdf</title></head>"
    b"<body><h1>This file is named .pdf but is HTML</h1></body></html>\n"
)


# ---------------------------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------------------------


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _entry(path: Path, pages: int, geometry: dict, extra: dict) -> dict:
    return {
        "name": path.name,
        "bytes": path.stat().st_size,
        "sha256": _sha256(path),
        "pages": pages,
        "page": dict(geometry),
        "renders": [
            {"zoom": zoom, "bytes": render_bytes(geometry, zoom)} for zoom in ZOOMS
        ],
        **extra,
    }


def build(directory: Path) -> dict:
    """Write every fixture into ``directory`` and return the manifest."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    ceiling = parse_page_ceiling()

    text = directory / "text.pdf"
    text.write_bytes(
        _document([{"geometry": A4, "content": _text_page(n, PAGE_COUNT)} for n in range(1, PAGE_COUNT + 1)])
    )
    zoomed = directory / "zoomed-a4.pdf"
    zoomed.write_bytes(
        _document([{"geometry": A4, "content": _grid_page(A4, "Zoom fixture (A4)", 6, 8)}])
    )
    large = directory / "large-page.pdf"
    large.write_bytes(
        _document([{"geometry": LARGE, "content": _grid_page(LARGE, "Large page fixture (72 x 54 in)", 10, 8)}])
    )
    corrupt = directory / "corrupt.pdf"
    corrupt.write_bytes(CORRUPT)
    not_pdf = directory / "not-a-pdf.pdf"
    not_pdf.write_bytes(NOT_A_PDF)
    # Larger than the 10 MiB text-read ceiling but below the 50 MiB override: the size range where
    # a normal scanned PDF lives and where the current reader path never reaches a viewer at all.
    oversized = directory / "oversized.pdf"
    oversized.write_bytes(
        _document(
            [{"geometry": A4, "content": _text_page(1, 3)}],
            metadata_padding=12 * 1024 * 1024,
        )
    )

    manifest = {
        "schema": SCHEMA,
        "generator": "scripts/app-lab/pdf_fixtures.py",
        "ceiling": {"pageBytes": ceiling, "bytesPerPixel": BYTES_PER_PIXEL, "owner": "src/modules/preview/lib/limits.ts"},
        "files": {
            "text": _entry(
                text,
                PAGE_COUNT,
                A4,
                {
                    "shape": "multi-page text",
                    "tokens": {
                        "pageTemplate": "[[ page {page} of 6 ]]",
                        "searchTemplate": "SEARCH-NEEDLE-{page:02d}",
                        "unique": UNIQUE_NEEDLE,
                        "uniquePage": UNIQUE_PAGE,
                    },
                },
            ),
            "zoomed-a4": _entry(
                zoomed, 1, A4, {"shape": "normal page, high zoom", "tokens": {"label": "Zoom fixture (A4)"}}
            ),
            "large-page": _entry(
                large,
                1,
                LARGE,
                {"shape": "large page, 100 % render", "tokens": {"label": "Large page fixture"}},
            ),
            "oversized": _entry(
                oversized,
                1,
                A4,
                {
                    "shape": "larger than the text-read ceiling",
                    "expected": "not previewed: the text read ceiling answers first",
                },
            ),
            "corrupt": {
                "name": corrupt.name,
                "bytes": corrupt.stat().st_size,
                "sha256": _sha256(corrupt),
                "shape": "corrupt",
                "expected": "rejected",
            },
            "not-a-pdf": {
                "name": not_pdf.name,
                "bytes": not_pdf.stat().st_size,
                "sha256": _sha256(not_pdf),
                "shape": "unsupported content",
                "expected": "rejected",
            },
        },
    }
    (directory / "pdf-fixtures.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


# ---------------------------------------------------------------------------------------------
# Verification with a real PDF toolchain
# ---------------------------------------------------------------------------------------------


def _run(*command: str) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, text=True)


def _require(tool: str) -> str:
    found = shutil.which(tool)
    if not found:
        raise FixtureError(
            f"{tool} is required to verify the PDF fixtures; install poppler-utils "
            "(the app-lab PDF scenario treats it as a host dependency)"
        )
    return found


def _ppm_size(path: Path) -> tuple[int, int, int]:
    raw = path.read_bytes()
    if not raw.startswith(b"P6"):
        raise FixtureError(f"{path} is not a binary PPM raster")
    fields = raw[2:64].split()
    width, height, maxval = (int(value) for value in fields[:3])
    return width, height, maxval


def verify(directory: Path, manifest: dict) -> dict:
    """Check the fixtures with poppler; raise ``FixtureError`` on any mismatch."""
    directory = Path(directory)
    for tool in ("pdfinfo", "pdftotext", "pdftoppm"):
        _require(tool)
    report: dict = {"verified": [], "pages": {}, "rejected": {}, "raster": {}}

    text = directory / manifest["files"]["text"]["name"]
    info = _run("pdfinfo", str(text))
    if info.returncode != 0:
        raise FixtureError(f"pdfinfo rejected {text.name}: {info.stderr.strip()}")
    pages = re.search(r"^Pages:\s+(\d+)$", info.stdout, re.M)
    if not pages or int(pages.group(1)) != manifest["files"]["text"]["pages"]:
        raise FixtureError(f"{text.name}: pdfinfo pages {pages.group(1) if pages else None}, expected {manifest['files']['text']['pages']}")
    report["pages"]["text"] = int(pages.group(1))

    extracted = _run("pdftotext", "-layout", str(text), "-")
    if extracted.returncode != 0:
        raise FixtureError(f"pdftotext rejected {text.name}: {extracted.stderr.strip()}")
    tokens = manifest["files"]["text"]["tokens"]
    for page in range(1, manifest["files"]["text"]["pages"] + 1):
        footer = tokens["pageTemplate"].format(page=page)
        needle = tokens["searchTemplate"].format(page=page)
        for value in (footer, needle):
            if value not in extracted.stdout:
                raise FixtureError(f"{text.name}: page {page} text is missing {value!r}")
    if extracted.stdout.count(UNIQUE_NEEDLE) != 1:
        raise FixtureError(f"{text.name}: {UNIQUE_NEEDLE} appears {extracted.stdout.count(UNIQUE_NEEDLE)} times")
    report["verified"].append("text")

    # A real raster at 100 DPI: poppler's own pixel dimensions are the independent check on the
    # manifest's render arithmetic (ceil at the zoom the ceiling decision uses).
    raster_prefix = directory / "raster-text"
    rasterised = _run(
        "pdftoppm", "-f", "1", "-l", "1", "-r", "100", "-singlefile", str(text), str(raster_prefix)
    )
    if rasterised.returncode != 0:
        raise FixtureError(f"pdftoppm failed on {text.name}: {rasterised.stderr.strip()}")
    raster_path = raster_prefix.with_suffix(".ppm")
    width, height, maxval = _ppm_size(raster_path)
    report["raster"]["text"] = {
        "page": 1,
        "dpi": 100,
        "width": width,
        "height": height,
        "maxval": maxval,
        "bytes": width * height * 3,
        "bytesPerPixel": 3,
    }
    expected = render_bytes(manifest["files"]["text"]["page"], 100 / 72)
    if abs(expected / BYTES_PER_PIXEL * 3 - width * height * 3) > expected * 0.02:
        raise FixtureError(
            f"{text.name}: 100 DPI raster is {width}x{height}, but the manifest predicts "
            f"{expected} RGBA8 bytes at that zoom"
        )
    raster_path.unlink()

    for key in ("zoomed-a4", "large-page", "oversized"):
        path = directory / manifest["files"][key]["name"]
        info = _run("pdfinfo", str(path))
        if info.returncode != 0:
            raise FixtureError(f"pdfinfo rejected {path.name}: {info.stderr.strip()}")
        pages = re.search(r"^Pages:\s+(\d+)$", info.stdout, re.M)
        if not pages or int(pages.group(1)) != manifest["files"][key]["pages"]:
            raise FixtureError(f"{path.name}: unexpected page count")
        report["pages"][key] = int(pages.group(1))
        report["verified"].append(key)
        if key == "oversized" and manifest["files"][key]["bytes"] <= 10 * 1024 * 1024:
            raise FixtureError(
                f"{path.name} is {manifest['files'][key]['bytes']} bytes; it must exceed the "
                "10 MiB text-read ceiling it exists to exercise"
            )

    for key in ("corrupt", "not-a-pdf"):
        path = directory / manifest["files"][key]["name"]
        extracted = _run("pdftotext", "-layout", str(path), "-")
        report["rejected"][key] = extracted.returncode != 0
        if extracted.returncode == 0:
            raise FixtureError(f"{path.name} was parsed as a PDF; the error fixture must be rejected")
        report["verified"].append(key)

    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, required=True, help="directory to write the fixtures into")
    parser.add_argument("--verify", action="store_true", help="also check the files with poppler and print the report")
    args = parser.parse_args(argv)
    manifest = build(args.output)
    print(f"wrote {len(manifest['files'])} PDF fixtures to {args.output}")
    for key, entry in manifest["files"].items():
        print(f"  {entry['name']:<16} {entry['bytes']:>7} bytes  {entry['shape']}")
    if args.verify:
        report = verify(args.output, manifest)
        print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
