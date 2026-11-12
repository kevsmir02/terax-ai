/**
 * Coalescing scheduler for recovery writes.
 *
 * The requirement is precise: continuous healthy editing must schedule a
 * persistence write **within two seconds**, not "when typing stops". A plain
 * debounce (reset on every keystroke) never fires while the user types, and
 * that is exactly the crash window recovery exists to close.
 *
 * So this is a leading-edge arm with a single in-flight write:
 *  - the first touch after an idle period arms one timer for `delayMs`;
 *  - further touches only update the text the next run will snapshot, they do
 *    not push the deadline out;
 *  - when the timer fires, the run reads the latest text, so a burst collapses
 *    into one write carrying the newest revision;
 *  - if edits arrive while a write is in flight, one more run is armed the
 *    moment it settles (delay 0), so the last keystrokes are not lost behind a
 *    slow write.
 *
 * The manager decides *whether* to schedule (feature enabled, path not
 * excluded, quota not exhausted); this module only owns the timing.
 */

/** 1.5 s: inside the spec's two-second budget with room for one slow write. */
export const RECOVERY_COALESCE_MS = 1500;

export type Coalescer = {
  /** Requests a persistence write after the coalescing window. */
  touch(): void;
  /** Stops scheduling (buffer closed or feature disabled). */
  cancel(): void;
  readonly pending: boolean;
};

export function createCoalescer(options: {
  delayMs: number;
  now?: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  run: () => Promise<void>;
  onError: (error: unknown) => void;
}): Coalescer {
  const { delayMs, schedule, cancel, run, onError } = options;
  let timer: { handle: unknown } | null = null;
  let running = false;
  let touchedDuringRun = false;
  let stopped = false;

  const arm = (delay: number) => {
    if (stopped) return;
    if (timer) return;
    timer = {
      handle: schedule(() => {
        timer = null;
        void fire();
      }, delay),
    };
  };

  const fire = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      touchedDuringRun = true;
      return;
    }
    running = true;
    touchedDuringRun = false;
    try {
      await run();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      // Text typed during the write gets its own write, immediately.
      if (touchedDuringRun && !stopped) arm(0);
    }
  };

  return {
    touch() {
      if (stopped) return;
      if (running) {
        touchedDuringRun = true;
        return;
      }
      arm(delayMs);
    },
    cancel() {
      stopped = true;
      if (timer) {
        cancel(timer.handle);
        timer = null;
      }
    },
    get pending() {
      return timer !== null || running;
    },
  };
}
