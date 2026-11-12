# Media fixtures

Small, real containers used by the native `fs_media_probe` tests and the app-lab
`media` scenario. They were generated once with ffmpeg 8.1 (`libvpx-vp9`,
`libopus`, `libvorbis`, `libopenh264`, `aac`, `libmp3lame`, `flac`) and
committed, so the tests measure this webview's real demuxers/decoders rather
than this repository's idea of a media file.

| File | Contents | Used by |
| --- | --- | --- |
| `sample.mp4` | H.264 + AAC, 1 s, 160×120 | probe tests, app-lab `media` |
| `sample.m4a` | AAC audio only, Ftyp `M4A ` | probe tests, app-lab `media` |
| `sample.mov` | QuickTime (`qt  `): H.264 + AAC | probe tests, app-lab `media` |
| `sample.webm` | VP9 + Opus | probe tests, app-lab `media` |
| `sample.mkv` | Matroska, VP9 + Opus | probe tests only (routed to explain the refusal) |
| `sample.ogg` | Ogg Vorbis audio | probe tests, app-lab `media` |
| `sample.wav` | 16-bit PCM, 8 kHz | probe tests, app-lab `media` |
| `sample.mp3` | MPEG audio layer 3 (ID3) | probe tests, app-lab `media` |
| `sample.flac` | FLAC | probe tests, app-lab `media` |
| `sample.aac` | ADTS AAC | probe tests, app-lab `media` |
| `corrupt.webm` | EBML signature with no DocType | probe tests, app-lab `media` |
| `unsupported.mp4` | valid MP4 whose video sample entry is `zzzz` | probe tests |
| `unsupported.webm` | playable WebM with its VP9 CodecID replaced by `V_ZZZ` | probe tests |
| `unsupported.wav` | valid RIFF/WAVE with format tag `0x9999` (no decoder) | probe tests, app-lab `media` |

`unsupported.wav` is `sample.wav` with its `fmt ` format tag replaced by
`0x9999`, so the container parses and the codec is unknown; `unsupported.mp4`
was made by encoding a 1 s MPEG-4 Part 2 fixture and replacing the first
sample-entry fourcc with `zzzz`. `unsupported.webm` replaces the VP9 CodecID with
`V_ZZZ`; this engine still decodes the VP9 payload, which is why the app-lab
scenario uses the WAV fixture for the codec-failure path and the probe tests keep
the id-parsing case.

Reproduce with (paths from the fixture directory):

```sh
ffmpeg -f lavfi -i "sine=frequency=440:duration=1:sample_rate=8000" -c:a pcm_s16le -ac 1 sample.wav
ffmpeg -f lavfi -i "sine=frequency=440:duration=1:sample_rate=22050" -c:a libmp3lame -b:a 32k -ac 1 sample.mp3
ffmpeg -f lavfi -i "sine=frequency=440:duration=1:sample_rate=22050" -c:a flac -ac 1 sample.flac
ffmpeg -f lavfi -i "sine=frequency=440:duration=1:sample_rate=22050" -c:a libvorbis -ac 1 sample.ogg
ffmpeg -f lavfi -i "testsrc2=size=160x120:rate=10:duration=1" \
       -f lavfi -i "sine=frequency=440:duration=1:sample_rate=48000" \
       -c:v libvpx-vp9 -b:v 120k -c:a libopus -shortest -f webm sample.webm
ffmpeg -f lavfi -i "testsrc2=size=160x120:rate=10:duration=1" \
       -f lavfi -i "sine=frequency=440:duration=1:sample_rate=44100" \
       -c:v libopenh264 -b:v 150k -c:a aac -b:a 48k -pix_fmt yuv420p -shortest \
       -movflags +faststart sample.mp4
ffmpeg -f lavfi -i "testsrc2=size=160x120:rate=10:duration=1" \
       -f lavfi -i "sine=frequency=440:duration=1:sample_rate=44100" \
       -c:v libopenh264 -b:v 150k -c:a aac -b:a 48k -pix_fmt yuv420p -shortest -f mov sample.mov
ffmpeg -f lavfi -i "testsrc2=size=160x120:rate=10:duration=1" \
       -f lavfi -i "sine=frequency=440:duration=1:sample_rate=48000" \
       -c:v libvpx-vp9 -b:v 120k -c:a libopus -shortest -f matroska sample.mkv
ffmpeg -f lavfi -i "sine=frequency=440:duration=1:sample_rate=44100" -c:a aac -b:a 48k -ac 1 -f ipod sample.m4a
ffmpeg -f lavfi -i "sine=frequency=440:duration=1:sample_rate=44100" -c:a aac -b:a 48k -ac 1 -f adts sample.aac
```

`corrupt.webm` is the 4-byte EBML signature followed by zero bytes; the app-lab
scenario generates its own `large.wav` (~3.5 MiB) so playback has to ask for
more than one bounded delivery chunk.
