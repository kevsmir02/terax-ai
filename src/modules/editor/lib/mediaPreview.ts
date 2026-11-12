import { imageFormatForPath } from "@/modules/preview/lib/imageFormats";
import {
  mediaFormatForPath,
  mediaKind,
} from "@/modules/preview/lib/mediaFormats";

export type MediaPreviewKind = "image" | "video" | "audio" | "pdf";

/**
 * Which preview surface a path is routed to. Routing is an extension table
 * only: the media surface still probes the real container and waits for the
 * element's own events before claiming playback support.
 */
export function mediaPreviewKind(path: string): MediaPreviewKind | null {
  // Image routing lives with the image format table so the editor, the probe
  // and the viewer cannot disagree about which extensions are images.
  if (imageFormatForPath(path)) return "image";
  const media = mediaFormatForPath(path);
  if (media) return mediaKind(media);
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "pdf") return "pdf";
  return null;
}
