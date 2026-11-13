import { useState } from "react";
import { useViewerAdmissionStore } from "./lib/viewerAdmission";
import { useDecodedViewer } from "./lib/useDecodedViewer";
import { useImageProbe } from "./lib/useImageProbe";
import { imageFormatForPath } from "./lib/imageFormats";
import { imageViewerRequest, imageViewerState } from "./lib/imageViewer";
import { ImagePreviewView } from "./ImagePreviewView";

type Props = {
  path: string;
  tabId: number;
  url: string | undefined;
  visible: boolean;
  onOpenExternally: () => void;
};

/**
 * The bounded image surface.
 *
 * The order is the contract: the native header probe reads the intrinsic
 * dimensions without decoding, the approved 64 MiB decision runs on those
 * dimensions, and only then does the image ask the decoded-viewer table for a
 * slot and mount the `<img>`. An oversized, corrupt, unsupported or oversized-
 * budget image therefore never allocates a raster first. Closing the tab or
 * replacing the path releases the raster and its slot; hiding the tab stops
 * presentation and releases the decoded slot as well.
 */
export function ImagePreview({
  path,
  tabId,
  url,
  visible,
  onOpenExternally,
}: Props) {
  const format = imageFormatForPath(path);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const probeState = useImageProbe(path, visible);
  const id = `image:${tabId}:${path}`;
  const evicted = useViewerAdmissionStore((state) =>
    state.viewers.some((entry) => entry.id === id && entry.evicted),
  );

  // Admission is requested from the pre-admission decision: the bytes are
  // exactly the ones the budget approved, and nothing mounts until the table
  // says yes.
  const candidate = imageViewerState({
    format,
    probe: probeState.probe,
    visible,
    decodeFailed,
    admission: null,
    evicted,
  });
  const requested = imageViewerRequest(candidate);
  const viewer = useDecodedViewer({
    id,
    tabId: String(tabId),
    decodedBytes: requested?.decodedBytes ?? 0,
    visible,
    enabled: Boolean(requested),
  });
  const state = imageViewerState({
    format,
    probe: probeState.probe,
    visible,
    decodeFailed,
    admission: viewer.admission,
    evicted: viewer.evicted,
  });

  const retry = () => {
    setDecodeFailed(false);
    setAttempt((value) => value + 1);
    probeState.retry();
  };

  return (
    <ImagePreviewView
      // A retry must remount the element even for the same source.
      key={attempt}
      state={state}
      path={path}
      url={url}
      onOpenExternally={onOpenExternally}
      onRetry={retry}
      onDecodeFailed={() => setDecodeFailed(true)}
    />
  );
}
