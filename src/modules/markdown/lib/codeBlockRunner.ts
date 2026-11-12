/**
 * "Run in active terminal" for rendered fenced code.
 *
 * The code block renderer is retained Markdown UI, but only the app shell knows
 * which tab is active and how to write into its PTY. The shell publishes that
 * action here instead of the renderer reaching into an AI store.
 */

export type CodeBlockRunner = (command: string) => boolean;

let runner: CodeBlockRunner | null = null;

export function setCodeBlockRunner(next: CodeBlockRunner | null): void {
  runner = next;
}

/** True when the command reached a terminal; false leaves the button idle. */
export function runCodeBlockCommand(command: string): boolean {
  return runner === null ? false : runner(command);
}
