import { invoke } from "@tauri-apps/api/core";

export type NativeSnapshot = Record<string, unknown>;

export const nativeWindow = <T = NativeSnapshot>(
  action: Record<string, unknown>,
) => invoke<T>("bench_window", { action });

/**
 * Page-clock startup facts, attached to every event. `timeOrigin` is the wall-clock epoch of
 * navigation start, so an orchestrator can split process exec -> navigation from navigation ->
 * boot without trusting its own spawn timestamp (the native snapshot carries the process start).
 */
export function startupTiming(): Record<string, unknown> {
  const paints: Record<string, number> = {};
  for (const entry of performance.getEntriesByType("paint")) {
    paints[entry.name] = entry.startTime;
  }
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  return {
    uptimeMs: performance.now(),
    timeOrigin: performance.timeOrigin,
    firstPaintMs: paints["first-paint"] ?? null,
    firstContentfulPaintMs: paints["first-contentful-paint"] ?? null,
    responseStartMs: navigation?.responseStart ?? null,
    domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
    loadEventMs: navigation?.loadEventEnd ?? null,
  };
}

/**
 * Posts one phase event to the orchestrator and resolves when it has finished sampling the
 * processes (the same request/response protocol as scripts/pty-smoke). The event carries the
 * native snapshot (exact host, WebContent, GPU and Networking pids; window state) taken
 * immediately before the post.
 */
export async function reportPhase(
  reportUrl: string,
  phase: string,
  body: Record<string, unknown>,
): Promise<{ retry: boolean }> {
  const native = await nativeWindow({ cmd: "snapshot" });
  const event = {
    phase,
    tWall: Date.now(),
    uptimeMs: performance.now(),
    perf: startupTiming(),
    native,
    ...body,
  };
  const response = await fetch(`${reportUrl}/event`, {
    method: "POST",
    body: JSON.stringify(event),
    cache: "no-store",
    credentials: "omit",
  });
  if (!response.ok)
    throw new Error(`orchestrator refused phase ${phase}: ${response.status}`);
  const reply = (await response.json()) as { retry?: boolean };
  return { retry: Boolean(reply.retry) };
}

export async function reportError(
  reportUrl: string,
  error: unknown,
): Promise<void> {
  const e = error as Error;
  await fetch(`${reportUrl}/event`, {
    method: "POST",
    body: JSON.stringify({
      phase: "error",
      error: String(error),
      stack: e?.stack,
    }),
  }).catch(() => undefined);
}
