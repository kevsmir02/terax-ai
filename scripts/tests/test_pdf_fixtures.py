"""The app-lab PDF fixtures are deterministic files with known, checkable facts.

These tests pin the fixture *contract* the PDF acceptance scenario relies on: a known page
count, distinctive searchable strings, page geometry whose rendered size crosses the approved
per-page ceiling only at the requested zoom, a corrupt file that a real PDF tool rejects, and a
byte-identical rebuild. They never inspect the generator's internals, so the writer can change
as long as the documents keep those properties.

Poppler-backed checks (`pdftotext`, `pdfinfo`, `pdftoppm`) are the independent source of truth
for "this is a real PDF with this many pages and this text". They are skipped where poppler is
not installed; the app-lab runner (`scripts/app-lab/run.py --scenario preview`) treats poppler as
a required host dependency and fails loudly instead.
"""

import hashlib
import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
GENERATOR = REPO / "scripts/app-lab/pdf_fixtures.py"
LIMITS_TS = REPO / "src/modules/preview/lib/limits.ts"


def load_generator():
    spec = importlib.util.spec_from_file_location("pdf_fixtures", GENERATOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pdf = load_generator()
HAVE_POPPLER = all(shutil.which(tool) for tool in ("pdftotext", "pdfinfo", "pdftoppm"))


class FixtureBuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="terax-pdf-fixtures-"))
        cls.manifest = pdf.build(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def path(self, key):
        return self.tmp / self.manifest["files"][key]["name"]

    def test_manifest_names_every_fixture(self):
        self.assertEqual(
            sorted(self.manifest["files"]),
            ["corrupt", "large-page", "not-a-pdf", "oversized", "text", "zoomed-a4"],
        )
        for key in self.manifest["files"]:
            self.assertTrue(self.path(key).is_file(), key)

    def test_oversized_fixture_exceeds_the_text_read_ceiling(self):
        entry = self.manifest["files"]["oversized"]
        self.assertGreater(entry["bytes"], 10 * 1024 * 1024)
        self.assertLess(entry["bytes"], 50 * 1024 * 1024)
        # A real renderer must still accept it: it is a normal one-page A4 document whose size
        # comes from metadata, not from anything a page draws.
        self.assertEqual(entry["pages"], 1)

    def test_text_fixture_has_six_pages_and_its_tokens(self):
        entry = self.manifest["files"]["text"]
        self.assertEqual(entry["pages"], 6)
        raw = self.path("text").read_bytes()
        self.assertTrue(raw.startswith(b"%PDF-1.4"))
        for page in range(1, 7):
            self.assertIn(f"[[ page {page} of 6 ]]".encode(), raw)
            self.assertIn(f"SEARCH-NEEDLE-{page:02d}".encode(), raw)
        self.assertEqual(raw.count(b"UNIQUE-GLOBAL-NEEDLE"), 1)
        self.assertIn(f"[[ page {entry['tokens']['uniquePage']} of 6 ]]".encode(), raw)

    def test_corrupt_fixture_is_not_a_readable_pdf(self):
        raw = self.path("corrupt").read_bytes()
        self.assertTrue(raw.startswith(b"%PDF-"))
        self.assertNotIn(b"startxref", raw)
        not_pdf = self.path("not-a-pdf").read_bytes()
        self.assertNotIn(b"%PDF", not_pdf[:16])

    def test_render_sizes_cross_the_approved_ceiling_only_where_expected(self):
        ceiling = self.manifest["ceiling"]["pageBytes"]
        self.assertEqual(ceiling, pdf.parse_page_ceiling(LIMITS_TS))
        text = self.manifest["files"]["text"]
        # A representative A4 page fits even at 200% zoom.
        self.assertLessEqual(pdf.render_bytes(text["page"], 2), ceiling)
        zoomed = self.manifest["files"]["zoomed-a4"]
        allowed = [r for r in zoomed["renders"] if r["bytes"] <= ceiling]
        refused = [r for r in zoomed["renders"] if r["bytes"] > ceiling]
        self.assertTrue(allowed, "no zoom of the zoomed fixture fits the ceiling")
        self.assertIn(4, [r["zoom"] for r in allowed])
        self.assertIn(8, [r["zoom"] for r in refused])
        large = self.manifest["files"]["large-page"]
        self.assertGreater(pdf.render_bytes(large["page"], 1), ceiling)
        self.assertLessEqual(pdf.render_bytes(large["page"], 0.5), ceiling)

    def test_rebuild_is_byte_identical(self):
        second = self.tmp / "rebuild"
        manifest = pdf.build(second)
        for key, entry in self.manifest["files"].items():
            digest = hashlib.sha256((second / entry["name"]).read_bytes()).hexdigest()
            self.assertEqual(digest, manifest["files"][key]["sha256"], key)
            self.assertEqual(digest, entry["sha256"], key)


@unittest.skipUnless(HAVE_POPPLER, "poppler (pdftotext/pdfinfo/pdftoppm) is not installed")
class PopplerVerificationTest(unittest.TestCase):
    """A real PDF tool must agree with what the manifest claims about the fixtures."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="terax-pdf-verify-"))
        cls.manifest = pdf.build(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_verify_reports_every_fixture(self):
        report = pdf.verify(self.tmp, self.manifest)
        self.assertEqual(sorted(report["verified"]), sorted(self.manifest["files"]))
        self.assertEqual(report["pages"]["text"], 6)
        self.assertTrue(report["rejected"]["corrupt"])
        self.assertTrue(report["rejected"]["not-a-pdf"])

    def test_rasterised_page_matches_the_manifest_geometry(self):
        report = pdf.verify(self.tmp, self.manifest)
        raster = report["raster"]["text"]
        self.assertEqual(raster["page"], 1)
        self.assertGreater(raster["width"], 0)
        self.assertGreater(raster["height"], 0)
        self.assertEqual(raster["bytesPerPixel"], 3)
        predicted = pdf.render_bytes(self.manifest["files"]["text"]["page"], 100 / 72)
        self.assertLessEqual(abs(predicted / 4 * 3 - raster["bytes"]), predicted * 0.01)


if __name__ == "__main__":
    unittest.main()
