import { useEffect } from "react";
import { usePreferencesStore } from "./preferences";

/**
 * Hydrates the cross-window preferences store that retained chrome reads
 * (theme, zoom, editor and terminal settings). The built-in AI bootstrap used
 * to own this as a side effect (ticket #12 removed it); preferences are not a
 * chat feature, so the startup wiring stays, without provider keys or
 * conversation hydration.
 */
export function usePreferencesBootstrap(): void {
  const init = usePreferencesStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);
}
