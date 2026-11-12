import type { AvailableRelease } from "./releaseManifest";

/** Ticket #39 owns the readiness interval and the package-tool install handoff. */
const INSTALL_HANDOFF_TICKET = 39;

export type DownloadRequestResult =
  | { kind: "refused"; reason: "not-approved" }
  | { kind: "not-implemented"; ticket: number; detail: string };

export interface DownloadRequest {
  release: AvailableRelease;
  /**
   * Explicit, per-request user approval. The dialog only sets this from a click on the
   * update action; no automatic or background path passes `true`.
   */
  approved: boolean;
}

/**
 * The gated download request seam.
 *
 * Discovery ends here. This build deliberately performs no download: installing is only
 * ever an explicit user action, and the install transaction (readiness recheck, package
 * tool, privilege interval, no automatic relaunch) is ticket #39's contract. Returning a
 * `not-implemented` result keeps that seam visible instead of faking a download with a
 * browser fetch or an installer call.
 */
export async function requestDownload({
  approved,
}: DownloadRequest): Promise<DownloadRequestResult> {
  if (!approved) return { kind: "refused", reason: "not-approved" };
  return {
    kind: "not-implemented",
    ticket: INSTALL_HANDOFF_TICKET,
    detail:
      "This build only discovers updates. Downloading and installing through the package " +
      "tool, including the readiness recheck before the transaction, is ticket #39.",
  };
}
