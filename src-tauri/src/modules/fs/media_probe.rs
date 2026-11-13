//! Actual audio/video container and codec identity from the file header.
//!
//! An extension routes a file to the media surface; it is not playback
//! evidence. This module reads a bounded prefix of the container and reports
//! what the bytes actually are: the container family and, where the header
//! carries them cheaply, the codec ids. The element's own `loadedmetadata` /
//! `error` events remain the authority on whether this WebKitGTK build can
//! decode those codecs; a parsed container is not a supported codec.
//!
//! The parser is pure over bytes (tests use committed fixtures); only the
//! command wrapper touches the disk. It never decodes a sample, installs a
//! codec or infers a container from the file name.

use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::modules::workspace::{resolve_path, WorkspaceEnv};

/// Enough for a faststart `moov`, an EBML Tracks element or an Ogg
/// identification header, while staying a bounded read (no whole-file
/// allocation for a large video).
pub const PROBE_MAX_BYTES: u64 = 64 * 1024;

/// Every container id this probe can report. The TypeScript routing table must
/// use exactly these ids; `mediaFormats.test.ts` reads this list so the two
/// cannot drift apart.
pub const CONTAINER_FORMATS: &[&str] = &[
    "mp4", "m4a", "mov", "webm", "matroska", "ogg", "wav", "mp3", "flac", "aac",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MediaProbeOutcome {
    /// A recognized container, with the codec ids the header named (possibly
    /// empty when the codec tables are outside the bounded prefix).
    Container {
        format: String,
        codecs: Vec<String>,
    },
    /// The container signature is recognized but the header cannot be used.
    Corrupt { format: String, reason: String },
    /// No recognized audio/video container signature in the prefix.
    Unsupported { reason: String },
}

fn container(format: &str, codecs: Vec<String>) -> MediaProbeOutcome {
    MediaProbeOutcome::Container {
        format: format.to_string(),
        codecs,
    }
}

/// Parses the container (and cheap codec ids) from a bounded header prefix.
pub fn probe_bytes(bytes: &[u8]) -> MediaProbeOutcome {
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return iso_bmff(bytes);
    }
    if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
        return ebml(bytes);
    }
    if bytes.starts_with(b"OggS") {
        return ogg(bytes);
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        return wav(bytes);
    }
    if bytes.starts_with(b"fLaC") {
        return container("flac", vec!["flac".into()]);
    }
    if is_adts(bytes) {
        return container("aac", vec!["aac".into()]);
    }
    if bytes.starts_with(b"ID3") || is_mp3_frame(bytes) {
        return container("mp3", vec!["mp3".into()]);
    }
    MediaProbeOutcome::Unsupported {
        reason: "No recognized audio/video container signature in the file header; \
                 the name may promise a format these bytes do not contain."
            .into(),
    }
}

/// The ISO base media family (MP4, M4A, QuickTime). The major brand, not the
/// extension, decides which one this is.
fn iso_bmff(bytes: &[u8]) -> MediaProbeOutcome {
    let format = match bytes.get(8..12) {
        Some(b"qt  ") => "mov",
        Some(b"M4A ") | Some(b"M4B ") | Some(b"M4P ") => "m4a",
        _ => "mp4",
    };
    container(format, iso_codecs(bytes))
}

/// Sample-entry fourccs from every `stsd` box the bounded prefix contains.
/// A faststart file has `moov` up front; a file whose tables live after the
/// payload honestly reports no codec ids instead of guessing.
fn iso_codecs(bytes: &[u8]) -> Vec<String> {
    let mut codecs = Vec::new();
    let mut at = 0;
    while let Some(found) = find_from(bytes, b"stsd", at) {
        at = found + 4;
        let Some(count) = be_u32(bytes, found + 8) else {
            continue;
        };
        let mut entry = found + 12;
        for _ in 0..count.min(16) {
            let Some(size) = be_u32(bytes, entry) else {
                break;
            };
            let Some(fourcc) = bytes.get(entry + 4..entry + 8) else {
                break;
            };
            if size < 8 {
                break;
            }
            if fourcc.iter().all(|byte| byte.is_ascii_graphic()) {
                let id = String::from_utf8_lossy(fourcc).to_ascii_lowercase();
                if !id.is_empty() && !codecs.contains(&id) {
                    codecs.push(id);
                }
            }
            let Some(next) = entry.checked_add(size as usize) else {
                break;
            };
            entry = next;
        }
    }
    codecs
}

/// EBML: the DocType distinguishes WebM from Matroska, and the codec ids are
/// the `CodecID` strings in the Tracks element (usually near the start).
fn ebml(bytes: &[u8]) -> MediaProbeOutcome {
    let format = match ebml_doctype(bytes) {
        Some("webm") => "webm",
        Some("matroska") => "matroska",
        Some(other) => {
            return MediaProbeOutcome::Unsupported {
                reason: format!("This is an EBML document this preview does not play ({other})."),
            };
        }
        None => {
            return MediaProbeOutcome::Corrupt {
                format: "ebml".into(),
                reason: "This EBML header is incomplete or has no DocType, so it cannot be played."
                    .into(),
            };
        }
    };
    container(format, ebml_codecs(bytes))
}

/// CodecID elements (`0x86`, vint size, ASCII value) in the bounded header.
/// Generic on purpose: a codec this build does not know must be reported by the
/// id the container names (`zzz`), not silently dropped.
fn ebml_codecs(bytes: &[u8]) -> Vec<String> {
    let mut codecs = Vec::new();
    let mut at = 0;
    while let Some(found) = find_from(bytes, b"\x86", at) {
        at = found + 1;
        let Some(&size) = bytes.get(found + 1) else {
            break;
        };
        // Short CodecID strings use a one-byte vint size (0x80 | length).
        if size & 0x80 == 0 {
            continue;
        }
        let length = usize::from(size & 0x7F);
        if length <= 2 || length > 32 {
            continue;
        }
        let Some(value) = bytes.get(found + 2..found + 2 + length) else {
            continue;
        };
        if !value.iter().all(|byte| byte.is_ascii_graphic()) {
            continue;
        }
        let text = String::from_utf8_lossy(value);
        if !(text.starts_with("V_") || text.starts_with("A_") || text.starts_with("S_")) {
            continue;
        }
        let id = text[2..].to_ascii_lowercase();
        if !id.is_empty() && !codecs.contains(&id) {
            codecs.push(id);
        }
    }
    codecs
}

fn ebml_doctype(bytes: &[u8]) -> Option<&str> {
    // DocType is element id 0x4282 with a vint size and an ASCII value.
    let at = find_from(bytes, b"\x42\x82", 0)?;
    let (length, header) = ebml_vint(bytes, at + 2)?;
    let start = at + 2 + header;
    let value = bytes.get(start..start.checked_add(length)?)?;
    std::str::from_utf8(value)
        .ok()
        .map(|text| text.trim_end_matches('\0'))
}

/// A variable-length integer as EBML writes sizes: the leading zeros of the
/// first byte give its width.
fn ebml_vint(bytes: &[u8], at: usize) -> Option<(usize, usize)> {
    let first = *bytes.get(at)?;
    if first == 0 {
        return None;
    }
    let length = first.leading_zeros() as usize + 1;
    if length > 8 || at + length > bytes.len() {
        return None;
    }
    let mut value = u64::from(first) & (0xFFu64 >> length);
    for offset in 1..length {
        value = (value << 8) | u64::from(*bytes.get(at + offset)?);
    }
    Some((value as usize, length))
}

/// Ogg carries its codec identification in the first packet.
fn ogg(bytes: &[u8]) -> MediaProbeOutcome {
    const CODECS: &[(&[u8], &str)] = &[
        (b"\x01vorbis", "vorbis"),
        (b"OpusHead", "opus"),
        (b"\x80theora", "theora"),
        (b"\x7fFLAC", "flac"),
    ];
    let mut codecs = Vec::new();
    for (needle, id) in CODECS {
        if find_from(bytes, needle, 0).is_some() {
            codecs.push((*id).to_string());
        }
    }
    container("ogg", codecs)
}

/// RIFF/WAVE: the `fmt ` chunk's format tag names the sample encoding.
fn wav(bytes: &[u8]) -> MediaProbeOutcome {
    let mut codecs = Vec::new();
    if let Some(at) = find_from(bytes, b"fmt ", 0) {
        if let Some(tag) = le_u16(bytes, at + 8) {
            let bits = le_u16(bytes, at + 22).unwrap_or(0);
            let codec = match tag {
                1 => match bits {
                    8 => "pcm_u8",
                    24 => "pcm_s24le",
                    32 => "pcm_s32le",
                    _ => "pcm_s16le",
                },
                3 => "pcm_f32le",
                6 => "pcm_alaw",
                7 => "pcm_mulaw",
                0x55 => "mp3",
                0xFFFE => "pcm_extensible",
                _ => "unknown",
            };
            codecs.push(codec.to_string());
        }
    }
    container("wav", codecs)
}

/// ADTS AAC: eleven sync bits, then layer bits that are zero (MPEG audio uses
/// a non-zero layer).
fn is_adts(bytes: &[u8]) -> bool {
    bytes.len() >= 7 && bytes[0] == 0xFF && (bytes[1] & 0xF6) == 0xF0
}

fn is_mp3_frame(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0 && (bytes[1] & 0x06) != 0
}

fn find_from(bytes: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= bytes.len() {
        return None;
    }
    bytes[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|offset| from + offset)
}

fn be_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn le_u16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

/// Reads at most [`PROBE_MAX_BYTES`] from a regular file and parses it.
pub fn probe_file(path: &Path) -> Result<MediaProbeOutcome, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("only regular files can be inspected as media".into());
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

/// Native container probe used by the media preview before mounting an
/// element, so a corrupt or mislabelled file never becomes a blank player.
#[tauri::command]
pub async fn fs_media_probe(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<MediaProbeOutcome, String> {
    super::blocking(move || {
        probe_file(&resolve_path(&path, &WorkspaceEnv::from_option(workspace)))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const MP4: &[u8] = include_bytes!("../../../tests/fixtures/media/sample.mp4");
    const M4A: &[u8] = include_bytes!("../../../tests/fixtures/media/sample.m4a");
    const MOV: &[u8] = include_bytes!("../../../tests/fixtures/media/sample.mov");
    const WEBM: &[u8] = include_bytes!("../../../tests/fixtures/media/sample.webm");
    const MKV: &[u8] = include_bytes!("../../../tests/fixtures/media/sample.mkv");
    const OGG: &[u8] = include_bytes!("../../../tests/fixtures/media/sample.ogg");
    const WAV: &[u8] = include_bytes!("../../../tests/fixtures/media/sample.wav");
    const MP3: &[u8] = include_bytes!("../../../tests/fixtures/media/sample.mp3");
    const FLAC: &[u8] = include_bytes!("../../../tests/fixtures/media/sample.flac");
    const AAC: &[u8] = include_bytes!("../../../tests/fixtures/media/sample.aac");
    const UNSUPPORTED_CODEC: &[u8] =
        include_bytes!("../../../tests/fixtures/media/unsupported.mp4");
    const UNSUPPORTED_WEBM: &[u8] =
        include_bytes!("../../../tests/fixtures/media/unsupported.webm");
    const UNSUPPORTED_WAV: &[u8] =
        include_bytes!("../../../tests/fixtures/media/unsupported.wav");
    const CORRUPT_WEBM: &[u8] =
        include_bytes!("../../../tests/fixtures/media/corrupt.webm");

    fn parsed(outcome: MediaProbeOutcome) -> (String, Vec<String>) {
        match outcome {
            MediaProbeOutcome::Container { format, codecs } => (format, codecs),
            other => panic!("expected a container, got {other:?}"),
        }
    }

    #[test]
    fn reads_the_mp4_family_container_and_codec_ids_from_the_header() {
        let (format, codecs) = parsed(probe_bytes(MP4));
        assert_eq!(format, "mp4");
        assert!(codecs.contains(&"avc1".to_string()), "{codecs:?}");
        assert!(codecs.contains(&"mp4a".to_string()), "{codecs:?}");
    }

    #[test]
    fn tells_m4a_and_quicktime_apart_from_mp4_by_brand() {
        assert_eq!(parsed(probe_bytes(M4A)).0, "m4a");
        assert_eq!(parsed(probe_bytes(MOV)).0, "mov");
        assert_eq!(parsed(probe_bytes(MP4)).0, "mp4");
    }

    #[test]
    fn reads_webm_and_matroska_doc_types_and_codec_ids() {
        let (format, codecs) = parsed(probe_bytes(WEBM));
        assert_eq!(format, "webm");
        assert!(codecs.contains(&"vp9".to_string()), "{codecs:?}");
        assert!(codecs.contains(&"opus".to_string()), "{codecs:?}");

        let (format, codecs) = parsed(probe_bytes(MKV));
        assert_eq!(format, "matroska");
        assert!(codecs.contains(&"vp9".to_string()), "{codecs:?}");
    }

    #[test]
    fn reads_the_ogg_codec_identification_header() {
        let (format, codecs) = parsed(probe_bytes(OGG));
        assert_eq!(format, "ogg");
        assert_eq!(codecs, vec!["vorbis".to_string()]);
    }

    #[test]
    fn reads_the_wav_pcm_format_tag() {
        let (format, codecs) = parsed(probe_bytes(WAV));
        assert_eq!(format, "wav");
        assert_eq!(codecs, vec!["pcm_s16le".to_string()]);
    }

    #[test]
    fn reads_mp3_flac_and_adts_aac_signatures() {
        assert_eq!(parsed(probe_bytes(MP3)), ("mp3".into(), vec!["mp3".into()]));
        assert_eq!(
            parsed(probe_bytes(FLAC)),
            ("flac".into(), vec!["flac".into()])
        );
        assert_eq!(parsed(probe_bytes(AAC)), ("aac".into(), vec!["aac".into()]));
    }

    #[test]
    fn reports_a_recognized_container_with_a_codec_the_build_may_not_decode() {
        // The container parses; the codec question belongs to the element's
        // real events. This is why `zzzz` is reported as a codec id, not
        // silently treated as support.
        let (format, codecs) = parsed(probe_bytes(UNSUPPORTED_CODEC));
        assert_eq!(format, "mp4");
        assert!(codecs.contains(&"zzzz".to_string()), "{codecs:?}");

        let (format, codecs) = parsed(probe_bytes(UNSUPPORTED_WEBM));
        assert_eq!(format, "webm");
        assert!(codecs.contains(&"zzz".to_string()), "{codecs:?}");
        assert!(codecs.contains(&"opus".to_string()), "{codecs:?}");
    }

    #[test]
    fn reports_a_valid_wav_container_with_an_unknown_codec_tag() {
        // A real WAV header whose format tag names a codec this build cannot
        // decode. The container is playable; the codec is not.
        let (format, codecs) = parsed(probe_bytes(UNSUPPORTED_WAV));
        assert_eq!(format, "wav");
        assert_eq!(codecs, vec!["unknown".to_string()]);
    }

    #[test]
    fn reports_an_incomplete_recognized_header_as_corrupt() {
        match probe_bytes(CORRUPT_WEBM) {
            MediaProbeOutcome::Corrupt { reason, .. } => assert!(!reason.is_empty()),
            other => panic!("expected corrupt, got {other:?}"),
        }
    }

    #[test]
    fn reports_unknown_bytes_as_unsupported_instead_of_guessing() {
        assert!(matches!(
            probe_bytes(b"this is not a media container"),
            MediaProbeOutcome::Unsupported { .. }
        ));
        assert!(matches!(
            probe_bytes(b""),
            MediaProbeOutcome::Unsupported { .. }
        ));
    }

    #[test]
    fn does_not_invent_codecs_when_the_tables_are_outside_the_prefix() {
        // ftyp + an empty mdat and no moov in the bounded prefix. The container
        // is still identifiable; codec ids are honestly absent.
        let mut bytes = vec![0u8, 0, 0, 16];
        bytes.extend_from_slice(b"ftypisom");
        bytes.extend_from_slice(&[0, 0, 2, 0]);
        bytes.extend_from_slice(b"isom");
        bytes.extend_from_slice(&[0u8; 8]);
        let (format, codecs) = parsed(probe_bytes(&bytes));
        assert_eq!(format, "mp4");
        assert!(codecs.is_empty());
    }

    #[test]
    fn probes_a_file_without_reading_the_whole_container() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.webm");
        std::fs::write(&path, WEBM).unwrap();
        assert_eq!(parsed(probe_file(&path).unwrap()).0, "webm");
    }

    #[test]
    fn refuses_a_missing_file_or_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(probe_file(&dir.path().join("missing.mp4")).is_err());
        assert!(probe_file(dir.path()).is_err());
    }

    #[test]
    fn lists_every_container_the_probe_can_report() {
        assert_eq!(
            CONTAINER_FORMATS,
            &["mp4", "m4a", "mov", "webm", "matroska", "ogg", "wav", "mp3", "flac", "aac"]
        );
    }
}
