/**
 * Settings window tab routing. The built-in AI sections ("models", "agents")
 * are removed with ticket #12, so old deep links (including the historical
 * "ai"/"connections" names) land on General instead of resurrecting a section
 * that no longer renders.
 */
export const SETTINGS_TABS = [
  "general",
  "editor",
  "themes",
  "shortcuts",
  "about",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

const LEGACY_TABS = new Set([
  "ai",
  "connections",
  "models",
  "agents",
]);

export function normalizeSettingsTab(value: string | null | undefined): SettingsTab | null {
  if (!value) return null;
  if (LEGACY_TABS.has(value)) return "general";
  return (SETTINGS_TABS as readonly string[]).includes(value)
    ? (value as SettingsTab)
    : null;
}
