/**
 * The single recovery manager for this window.
 *
 * One manager owns the quota picture and the per-buffer operation chains, so it
 * must not be re-created per component: two managers would each believe they
 * own the directory's usage. Enforcement still happens natively (an app
 * instance is not the only possible writer); this is the UI's single view.
 */

import { usePreferencesStore } from "@/modules/settings/preferences";
import { createRecoveryManager, type RecoveryManager } from "./manager";
import { nativeRecoveryStorage } from "./nativeStorage";

let manager: RecoveryManager | null = null;

export function recoveryManager(): RecoveryManager {
  if (manager === null) {
    manager = createRecoveryManager({
      storage: nativeRecoveryStorage,
      // Read live: the settings toggle changes this at runtime.
      enabled: () => usePreferencesStore.getState().editorRecoveryDrafts,
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
  }
  return manager;
}
