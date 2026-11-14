import { invoke } from "@tauri-apps/api/core";
import {
  ManifestTransportError,
  toManifestTransportError,
  type ManifestFetchResult,
  type ManifestTransport,
  type ManifestTransportReason,
} from "./checkForUpdate";
import { isLoopbackEndpoint } from "./contract";

function isTransportReason(value: unknown): value is ManifestTransportReason {
  return value === "offline" || value === "blocked" || value === "timeout";
}

function parseTauriTransportError(error: unknown): ManifestTransportError {
  if (error instanceof ManifestTransportError) return error;
  if (typeof error === "object" && error !== null) {
    const record = error as { reason?: unknown; detail?: unknown };
    if (isTransportReason(record.reason)) {
      const detail =
        typeof record.detail === "string"
          ? record.detail
          : error instanceof Error
            ? error.message
            : String(error);
      return new ManifestTransportError(record.reason, detail);
    }
  }
  return toManifestTransportError(error);
}

export const tauriManifestTransport: ManifestTransport = async ({
  endpoint,
}) => {
  try {
    return await invoke<ManifestFetchResult>("updater_fetch_manifest", {
      endpointOverride: isLoopbackEndpoint(endpoint) ? endpoint : null,
    });
  } catch (error) {
    throw parseTauriTransportError(error);
  }
};
