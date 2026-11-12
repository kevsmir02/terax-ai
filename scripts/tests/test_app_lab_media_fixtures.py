"""Contracts of the app-lab media scenario fixtures (`scripts/app-lab/run.py`).

The media scenario exists so container/codec support is measured by the real
WebKitGTK element, not inferred from a file extension. These tests pin the
fixture wiring: every routed committed container is copied, the deliberately
misleading and undecodable fixtures stay in place, and the generated "large"
file is actually larger than one bounded delivery chunk.

Run with: python3 -m unittest discover -s scripts/tests
"""

import importlib.util
import tempfile
import unittest
import wave
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
RUN_PY = REPO / "scripts/app-lab/run.py"
FIXTURES = REPO / "src-tauri/tests/fixtures/media"


def load_module():
    spec = importlib.util.spec_from_file_location("app_lab_run", RUN_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MediaFixtureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.run = load_module()

    def test_every_fixture_the_scenario_opens_is_copied(self) -> None:
        required = {
            "mp4",
            "m4a",
            "mov",
            "webm",
            "mkv",
            "ogg",
            "wav",
            "mp3",
            "flac",
            "aac",
            "corrupt",
            "unsupportedCodec",
            "mismatch",
            "large",
            "measured",
            "expectedSupported",
        }
        with tempfile.TemporaryDirectory() as directory:
            copied = self.run.prepare_media_fixtures(Path(directory), REPO)
            self.assertEqual(set(copied), required)
            for key in required - {"expectedSupported", "measured"}:
                self.assertTrue(Path(copied[key]).exists(), key)

    def test_every_measured_container_has_a_committed_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copied = self.run.prepare_media_fixtures(Path(directory), REPO)
            # Matroska is routed only to explain the refusal; the measured list
            # is exactly the containers the probes' fixtures cover.
            self.assertEqual(
                copied["measured"],
                ["mp4", "m4a", "mov", "webm", "ogg", "wav", "mp3", "flac", "aac"],
            )
            self.assertNotIn("mkv", copied["measured"])
            for container in copied["measured"]:
                self.assertTrue(Path(copied[container]).exists(), container)
            self.assertTrue(
                set(copied["expectedSupported"]).issubset(set(copied["measured"]))
            )

    def test_the_mismatch_fixture_is_webm_bytes_with_an_mp4_name(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copied = self.run.prepare_media_fixtures(Path(directory), REPO)
            mismatch = Path(copied["mismatch"])
            webm = Path(copied["webm"])
            self.assertEqual(mismatch.suffix, ".mp4")
            self.assertEqual(mismatch.read_bytes(), webm.read_bytes())

    def test_the_large_fixture_exceeds_one_delivery_chunk(self) -> None:
        # The production chunk is a tenth of the approved 10 MiB read ceiling;
        # seeking past the first chunk is what makes the range check meaningful.
        chunk = 10 * 1024 * 1024 // 10
        with tempfile.TemporaryDirectory() as directory:
            copied = self.run.prepare_media_fixtures(Path(directory), REPO)
            large = Path(copied["large"])
            self.assertGreater(large.stat().st_size, chunk)
            with wave.open(str(large), "rb") as audio:
                self.assertEqual(audio.getnchannels(), 2)
                self.assertGreater(audio.getnframes(), 0)

    def test_the_unsupported_codec_fixture_is_a_valid_wav_with_an_unknown_tag(self) -> None:
        # A valid RIFF/WAVE header naming a codec this build cannot decode: the
        # failure is codec-level, not container-level.
        data = (FIXTURES / "unsupported.wav").read_bytes()
        self.assertTrue(data.startswith(b"RIFF"))
        fmt = data.find(b"fmt ")
        self.assertEqual(data[fmt + 8 : fmt + 10], b"\x99\x99")
        # The preserved WebM probe fixture shows the native parser reports a
        # codec id the engine does not need to honour.
        webm = (FIXTURES / "unsupported.webm").read_bytes()
        self.assertIn(b"V_ZZZ", webm)


if __name__ == "__main__":
    unittest.main()
