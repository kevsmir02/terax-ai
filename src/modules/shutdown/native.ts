/**
 * The two native halves of quitting.
 *
 * They are deliberately separate calls with different contracts: `terminate`
 * asks app-owned work to exit and reports what is left, `force` ends it. The
 * window must never call the second on the strength of the first returning;
 * only an explicit answer to the survivor prompt gets here.
 */

import { invoke } from "@tauri-apps/api/core";

export type TerminateReport = {
  /** Terminal ids whose work exited within the grace period. */
  terminated: number[];
  /** Terminal ids that still had running work when it ran out. */
  survived: number[];
};

/** Bounded SIGTERM pass over the terminals' app-owned work. Never escalates. */
export async function terminateAppOwnedWork(
  ids: readonly number[],
  graceMs: number,
): Promise<TerminateReport> {
  return invoke<TerminateReport>("pty_terminate", { ids: [...ids], graceMs });
}

/**
 * The confirmed escalation: closes every app-owned terminal session (SIGHUP to
 * the shell, then hang up). Detached services that left the terminal's process
 * tree are not reachable here, and the prompt says so.
 */
export async function forceCloseTerminals(): Promise<number> {
  return invoke<number>("pty_close_all");
}
