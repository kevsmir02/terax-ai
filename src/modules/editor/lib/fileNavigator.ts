export type FileNavigator = {
  /** Open `path` in an editor tab, placing the caret on 1-based `line`. */
  openFile: (path: string, line: number) => void;
};

let current: FileNavigator | null = null;

/** Registered by the app shell; terminal links route file opens through it. */
export function setFileNavigator(navigator: FileNavigator | null): void {
  current = navigator;
}

export function getFileNavigator(): FileNavigator | null {
  return current;
}
