import { imageFormatForPath } from "@/modules/preview/lib/imageFormats";

export type MediaPreviewKind = "image" | "video" | "audio" | "pdf";

const VIDEO_EXT = ["mp4", "webm", "ogg", "mov"];
const AUDIO_EXT = ["mp3", "wav", "flac", "aac", "m4a"];

export function mediaPreviewKind(path: string): MediaPreviewKind | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  // Image routing lives with the image format table so the editor, the probe
  // and the viewer cannot disagree about which extensions are images.
  if (imageFormatForPath(path)) return "image";
  if (VIDEO_EXT.includes(ext)) return "video";
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return null;
}

type MediaPlayback = Pick<
  HTMLMediaElement,
  "pause" | "addEventListener" | "removeEventListener"
>;

export function bindMediaPlayback(media: MediaPlayback, active: boolean) {
  const pause = () => media.pause();
  if (!active) {
    pause();
    media.addEventListener("play", pause);
  }
  return () => {
    media.removeEventListener("play", pause);
    pause();
  };
}
