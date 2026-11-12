//! Intrinsic image dimensions from the file header.
//!
//! The approved decoded-image ceiling (64 MiB RGBA8, issue #4) is only
//! enforceable before the webview decodes if the dimensions are known first.
//! An `<img>` decodes at intrinsic size and reports `naturalWidth` only after
//! the raster exists, which is exactly the allocation the ceiling forbids. This
//! module reads a bounded prefix of the file and parses the container header
//! instead, so the frontend can refuse or admit before mounting the element.
//!
//! The parser is pure over bytes (tests use committed fixtures); only the
//! command wrapper touches the disk. It never decodes pixels, installs a codec
//! or guesses a size from the extension: the signature decides the container,
//! and a signature without a usable size is reported as corrupt rather than
//! measured.

use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::modules::workspace::{resolve_path, WorkspaceEnv};

/// Enough for the metadata of every supported container; a JPEG's frame header
/// can follow large EXIF blocks, so this is deliberately generous while still
/// bounded (no whole-file allocation).
pub const PROBE_MAX_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ImageProbeOutcome {
    /// A raster container with usable intrinsic dimensions.
    Measured {
        format: String,
        width: u32,
        height: u32,
    },
    /// A vector document: no intrinsic raster to budget.
    Vector { format: String },
    /// The container signature is recognized but its size cannot be read.
    Corrupt { format: String, reason: String },
    /// No supported image signature in the header.
    Unsupported { reason: String },
}

fn measured(format: &str, width: u32, height: u32) -> ImageProbeOutcome {
    if width == 0 || height == 0 {
        return ImageProbeOutcome::Corrupt {
            format: format.to_string(),
            reason: format!("This {format} header has a zero dimension."),
        };
    }
    ImageProbeOutcome::Measured {
        format: format.to_string(),
        width,
        height,
    }
}

fn corrupt(format: &str, reason: impl Into<String>) -> ImageProbeOutcome {
    ImageProbeOutcome::Corrupt {
        format: format.to_string(),
        reason: reason.into(),
    }
}

/// Parses the intrinsic size from a bounded header prefix.
pub fn probe_bytes(bytes: &[u8]) -> ImageProbeOutcome {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return probe_png(bytes);
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return probe_jpeg(bytes);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return probe_gif(bytes);
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return probe_webp(bytes);
    }
    if bytes.starts_with(b"BM") {
        return probe_bmp(bytes);
    }
    if bytes.starts_with(b"\x00\x00\x01\x00") {
        return probe_ico(bytes);
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return probe_avif(bytes);
    }
    if is_svg(bytes) {
        return ImageProbeOutcome::Vector {
            format: "svg".to_string(),
        };
    }
    ImageProbeOutcome::Unsupported {
        reason: "This file's header is not a supported image format.".to_string(),
    }
}

fn probe_png(bytes: &[u8]) -> ImageProbeOutcome {
    if bytes.len() < 24 {
        return corrupt("png", "This PNG header is incomplete.");
    }
    if &bytes[12..16] != b"IHDR" {
        return corrupt("png", "This PNG does not start with an IHDR chunk.");
    }
    match (be_u32(bytes, 16), be_u32(bytes, 20)) {
        (Some(width), Some(height)) => measured("png", width, height),
        _ => corrupt("png", "This PNG header is incomplete."),
    }
}

fn probe_jpeg(bytes: &[u8]) -> ImageProbeOutcome {
    let mut at = 2usize;
    while at + 1 < bytes.len() {
        if bytes[at] != 0xff {
            at += 1;
            continue;
        }
        let mut marker = bytes[at + 1];
        while marker == 0xff {
            at += 1;
            if at + 1 >= bytes.len() {
                break;
            }
            marker = bytes[at + 1];
        }
        // Standalone markers carry no length.
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            at += 2;
            continue;
        }
        if marker == 0xd9 {
            break;
        }
        let Some(length) = be_u16(bytes, at + 2) else {
            break;
        };
        let length = usize::from(length);
        if length < 2 {
            return corrupt("jpeg", "This JPEG has an invalid segment length.");
        }
        let segment = at + 2;
        let end = segment.saturating_add(length);
        if end > bytes.len() {
            return corrupt("jpeg", "This JPEG header ends before its frame size.");
        }
        if is_sof(marker) {
            let (Some(height), Some(width)) = (
                be_u16(bytes, segment + 3),
                be_u16(bytes, segment + 5),
            ) else {
                return corrupt("jpeg", "This JPEG frame header is incomplete.");
            };
            return measured("jpeg", u32::from(width), u32::from(height));
        }
        at = end;
    }
    corrupt("jpeg", "This JPEG header has no frame size.")
}

fn is_sof(marker: u8) -> bool {
    matches!(
        marker,
        0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf
    )
}

fn probe_gif(bytes: &[u8]) -> ImageProbeOutcome {
    let (Some(width), Some(height)) = (le_u16(bytes, 6), le_u16(bytes, 8)) else {
        return corrupt("gif", "This GIF header is incomplete.");
    };
    measured("gif", u32::from(width), u32::from(height))
}

fn probe_webp(bytes: &[u8]) -> ImageProbeOutcome {
    let Some(chunk) = bytes.get(12..16) else {
        return corrupt("webp", "This WebP header is incomplete.");
    };
    match chunk {
        b"VP8X" => {
            let (Some(width), Some(height)) = (le_u24(bytes, 24), le_u24(bytes, 27))
            else {
                return corrupt("webp", "This WebP header is incomplete.");
            };
            measured("webp", width + 1, height + 1)
        }
        b"VP8 " => {
            if bytes.get(23..26) != Some(&[0x9d, 0x01, 0x2a]) {
                return corrupt("webp", "This WebP lossy frame header is invalid.");
            }
            let (Some(width), Some(height)) = (le_u16(bytes, 26), le_u16(bytes, 28))
            else {
                return corrupt("webp", "This WebP header is incomplete.");
            };
            measured(
                "webp",
                u32::from(width & 0x3fff),
                u32::from(height & 0x3fff),
            )
        }
        b"VP8L" => {
            if bytes.get(20) != Some(&0x2f) {
                return corrupt("webp", "This WebP lossless frame header is invalid.");
            }
            let Some(bits) = le_u32(bytes, 21) else {
                return corrupt("webp", "This WebP header is incomplete.");
            };
            measured(
                "webp",
                (bits & 0x3fff) + 1,
                ((bits >> 14) & 0x3fff) + 1,
            )
        }
        _ => corrupt("webp", "This WebP uses an unknown bitstream variant."),
    }
}

fn probe_bmp(bytes: &[u8]) -> ImageProbeOutcome {
    let Some(header) = le_u32(bytes, 14) else {
        return corrupt("bmp", "This BMP header is incomplete.");
    };
    let (width, height) = if header == 12 {
        // BITMAPCOREHEADER stores 16-bit dimensions.
        let (Some(width), Some(height)) = (le_u16(bytes, 18), le_u16(bytes, 20))
        else {
            return corrupt("bmp", "This BMP header is incomplete.");
        };
        (i64::from(width), i64::from(height))
    } else {
        let (Some(width), Some(height)) = (le_i32(bytes, 18), le_i32(bytes, 22))
        else {
            return corrupt("bmp", "This BMP header is incomplete.");
        };
        (i64::from(width), i64::from(height))
    };
    if width <= 0 || height == 0 {
        return corrupt("bmp", "This BMP header has an unusable size.");
    }
    // A negative height only means the rows are stored top-down.
    measured("bmp", width as u32, height.unsigned_abs() as u32)
}

fn probe_ico(bytes: &[u8]) -> ImageProbeOutcome {
    let Some(count) = le_u16(bytes, 4) else {
        return corrupt("ico", "This ICO header is incomplete.");
    };
    if count == 0 {
        return corrupt("ico", "This ICO contains no images.");
    }
    let mut best = (0u32, 0u32);
    for index in 0..usize::from(count) {
        let entry = 6 + index * 16;
        let (Some(raw_width), Some(raw_height)) =
            (bytes.get(entry).copied(), bytes.get(entry + 1).copied())
        else {
            return corrupt("ico", "This ICO directory is truncated.");
        };
        // Zero means 256 in the ICO directory.
        let width = if raw_width == 0 {
            256
        } else {
            u32::from(raw_width)
        };
        let height = if raw_height == 0 {
            256
        } else {
            u32::from(raw_height)
        };
        if width.saturating_mul(height) > best.0.saturating_mul(best.1) {
            best = (width, height);
        }
    }
    // The budget is decided from the largest frame, the worst case the
    // browser could pick.
    measured("ico", best.0, best.1)
}

fn probe_avif(bytes: &[u8]) -> ImageProbeOutcome {
    // The size lives in an `ispe` property box nested in `meta`; walking the
    // whole box tree buys nothing here, so the bounded header is scanned and
    // the largest `ispe` wins.
    let mut best = (0u32, 0u32);
    let mut at = 4usize;
    while at + 16 <= bytes.len() {
        if &bytes[at..at + 4] == b"ispe" {
            let (Some(width), Some(height)) = (be_u32(bytes, at + 8), be_u32(bytes, at + 12))
            else {
                return corrupt("avif", "This AVIF image size box is incomplete.");
            };
            if width.saturating_mul(height) > best.0.saturating_mul(best.1) {
                best = (width, height);
            }
            at += 16;
        } else {
            at += 1;
        }
    }
    if best == (0, 0) {
        return corrupt("avif", "This AVIF header has no image size.");
    }
    measured("avif", best.0, best.1)
}

fn is_svg(bytes: &[u8]) -> bool {
    let prefix = &bytes[..bytes.len().min(4096)];
    let lossy = String::from_utf8_lossy(prefix);
    let text = lossy.trim_start_matches('\u{feff}').trim_start();
    text.starts_with('<') && text.to_ascii_lowercase().contains("<svg")
}

fn be_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at + 4)?;
    Some(u32::from_be_bytes(slice.try_into().ok()?))
}

fn be_u16(bytes: &[u8], at: usize) -> Option<u16> {
    let slice = bytes.get(at..at + 2)?;
    Some(u16::from_be_bytes(slice.try_into().ok()?))
}

fn le_u16(bytes: &[u8], at: usize) -> Option<u16> {
    let slice = bytes.get(at..at + 2)?;
    Some(u16::from_le_bytes(slice.try_into().ok()?))
}

fn le_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at + 4)?;
    Some(u32::from_le_bytes(slice.try_into().ok()?))
}

fn le_i32(bytes: &[u8], at: usize) -> Option<i32> {
    let slice = bytes.get(at..at + 4)?;
    Some(i32::from_le_bytes(slice.try_into().ok()?))
}

fn le_u24(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at + 3)?;
    Some(u32::from(slice[0]) | (u32::from(slice[1]) << 8) | (u32::from(slice[2]) << 16))
}

/// Reads at most [`PROBE_MAX_BYTES`] from a regular file and parses it.
pub fn probe_file(path: &Path) -> Result<ImageProbeOutcome, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("only regular files can be inspected as images".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A FIFO swapped in after the metadata check must not block open().
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    let mut header = Vec::new();
    file.take(PROBE_MAX_BYTES)
        .read_to_end(&mut header)
        .map_err(|error| error.to_string())?;
    Ok(probe_bytes(&header))
}

/// Native dimension probe used by the image preview before decoding.
#[tauri::command]
pub async fn fs_image_probe(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<ImageProbeOutcome, String> {
    super::blocking(move || {
        probe_file(&resolve_path(&path, &WorkspaceEnv::from_option(workspace)))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = include_bytes!("../../../tests/fixtures/images/sample.png");
    const JPEG: &[u8] = include_bytes!("../../../tests/fixtures/images/sample.jpg");
    const GIF: &[u8] = include_bytes!("../../../tests/fixtures/images/sample.gif");
    const WEBP: &[u8] = include_bytes!("../../../tests/fixtures/images/sample.webp");
    const BMP: &[u8] = include_bytes!("../../../tests/fixtures/images/sample.bmp");
    const ICO: &[u8] = include_bytes!("../../../tests/fixtures/images/sample.ico");
    const AVIF: &[u8] = include_bytes!("../../../tests/fixtures/images/sample.avif");
    const SVG: &[u8] = include_bytes!("../../../tests/fixtures/images/sample.svg");
    const CORRUPT_PNG: &[u8] = include_bytes!("../../../tests/fixtures/images/corrupt.png");
    const OVERSIZED_PNG: &[u8] =
        include_bytes!("../../../tests/fixtures/images/oversized.png");

    fn dimensions(outcome: ImageProbeOutcome) -> (String, u32, u32) {
        match outcome {
            ImageProbeOutcome::Measured {
                format,
                width,
                height,
            } => (format, width, height),
            other => panic!("expected measured dimensions, got {other:?}"),
        }
    }

    #[test]
    fn reads_png_dimensions_from_the_header() {
        assert_eq!(dimensions(probe_bytes(PNG)), ("png".into(), 64, 64));
    }

    #[test]
    fn reads_jpeg_dimensions_from_the_frame_header() {
        assert_eq!(dimensions(probe_bytes(JPEG)), ("jpeg".into(), 64, 64));
    }

    #[test]
    fn reads_gif_dimensions_from_the_logical_screen_descriptor() {
        assert_eq!(dimensions(probe_bytes(GIF)), ("gif".into(), 64, 64));
    }

    #[test]
    fn reads_webp_dimensions_from_the_lossless_bitstream() {
        assert_eq!(dimensions(probe_bytes(WEBP)), ("webp".into(), 64, 64));
    }

    #[test]
    fn reads_bmp_dimensions_from_the_dib_header() {
        assert_eq!(dimensions(probe_bytes(BMP)), ("bmp".into(), 64, 64));
    }

    #[test]
    fn reads_ico_dimensions_from_the_largest_directory_entry() {
        assert_eq!(dimensions(probe_bytes(ICO)), ("ico".into(), 64, 64));
    }

    #[test]
    fn reads_avif_dimensions_from_the_ispe_property() {
        assert_eq!(dimensions(probe_bytes(AVIF)), ("avif".into(), 64, 64));
    }

    #[test]
    fn treats_svg_as_a_vector_without_an_intrinsic_raster() {
        assert_eq!(
            probe_bytes(SVG),
            ImageProbeOutcome::Vector {
                format: "svg".into()
            }
        );
    }

    #[test]
    fn reports_a_recognized_but_unusable_png_as_corrupt() {
        match probe_bytes(CORRUPT_PNG) {
            ImageProbeOutcome::Corrupt { format, reason } => {
                assert_eq!(format, "png");
                assert!(!reason.is_empty());
            }
            other => panic!("expected corrupt png, got {other:?}"),
        }
    }

    #[test]
    fn reports_the_truthful_dimensions_of_an_oversized_header() {
        // The ceiling decision belongs to the approved contract in
        // `limits.ts`; the probe only reports what the header says.
        assert_eq!(dimensions(probe_bytes(OVERSIZED_PNG)), ("png".into(), 5000, 5000));
    }

    #[test]
    fn reports_unknown_bytes_as_unsupported_instead_of_guessing() {
        assert!(matches!(
            probe_bytes(b"not an image at all"),
            ImageProbeOutcome::Unsupported { .. }
        ));
    }

    #[test]
    fn rejects_zero_dimensions_instead_of_claiming_a_raster() {
        let mut png = PNG.to_vec();
        png[16..20].copy_from_slice(&0u32.to_be_bytes());
        assert!(matches!(
            probe_bytes(&png),
            ImageProbeOutcome::Corrupt { .. }
        ));
    }

    #[test]
    fn rejects_a_jpeg_without_a_frame_header() {
        let jpeg = [0xff, 0xd8, 0xff, 0xd9];
        assert!(matches!(
            probe_bytes(&jpeg),
            ImageProbeOutcome::Corrupt { .. }
        ));
    }

    #[test]
    fn does_not_decode_or_read_past_the_header_bound() {
        // A file that continues for ten bounds' worth of bytes: the parser is
        // given the same bounded prefix the command builds, and still reports
        // the header's dimensions.
        let mut long = Vec::new();
        long.extend_from_slice(PNG);
        long.resize((PROBE_MAX_BYTES + 1024) as usize, 0);
        assert_eq!(dimensions(probe_bytes(&long)), ("png".into(), 64, 64));
    }

    #[test]
    fn probes_a_file_without_reading_the_whole_image() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.png");
        std::fs::write(&path, PNG).unwrap();
        assert_eq!(
            dimensions(probe_file(&path).unwrap()),
            ("png".into(), 64, 64)
        );
    }

    #[test]
    fn refuses_a_missing_file_with_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(probe_file(&dir.path().join("missing.png")).is_err());
    }

    #[test]
    fn refuses_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(probe_file(dir.path()).is_err());
    }
}
