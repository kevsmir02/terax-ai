// One document's read lifecycle as a plain function: the Markdown pane may ask
// for a reload at any time (a file event, the tab becoming visible, "open
// anyway"), so a completion must only be applied while its request is the newest
// one *and* the document is still mounted. Extracted from the hook so the stale
// completion rule is testable without a DOM or React.

export type LoadOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export type DocumentLoad = {
  /** Starts a read; only the newest live request may publish its outcome. */
  load: () => void;
  /** Ends the document's life: later completions are discarded. */
  close: () => void;
  readonly live: boolean;
};

export function createDocumentLoad<T>(
  read: () => Promise<T>,
  apply: (outcome: LoadOutcome<T>) => void,
): DocumentLoad {
  let alive = true;
  let latest = 0;
  return {
    load() {
      const id = ++latest;
      void read().then(
        (value) => {
          if (alive && id === latest) apply({ ok: true, value });
        },
        (error: unknown) => {
          if (alive && id === latest) apply({ ok: false, error });
        },
      );
    },
    close() {
      alive = false;
    },
    get live() {
      return alive;
    },
  };
}
