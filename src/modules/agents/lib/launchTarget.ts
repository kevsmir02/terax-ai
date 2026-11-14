/**
 * Antigravity ships a desktop application and a terminal CLI as separate
 * entry points. Terax can own a terminal pane, so it may launch the CLI — it
 * never embeds, drives or claims to control the GUI.
 *
 * The classification below is a command-shape heuristic, not vendor
 * certification: it recognises the launcher forms that start the desktop app
 * (desktop launchers, `.app` bundles, `.desktop` files and the GUI executables)
 * and treats every other command as the CLI the user configured. Vendor-version
 * verification belongs to release validation, not to this function.
 */

/** Commands that hand a file/URL to a desktop application rather than a TUI. */
const DESKTOP_LAUNCHERS =
  /^(?:open\s+(?:-\S+\s+)*-a|xdg-open|gio\s+open|gtk-launch|flatpak\s+run|snap\s+run)\b/i;

/** Executable names that belong to the desktop app, never the terminal CLI. */
const DESKTOP_BASENAMES: ReadonlySet<string> = new Set([
  "antigravity",
  "antigravity.exe",
  "antigravity.cmd",
  "antigravity.bat",
  "antigravity.ps1",
  "antigravity.com",
  "antigravity-desktop",
  "antigravity-desktop.exe",
  "antigravity-gui",
  "antigravity-gui.exe",
  "antigravity.desktop",
]);

export type AgentLaunchTarget = "cli" | "desktop-app";

function basename(token: string): string {
  const parts = token.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

function stripLeadingCommandPath(command: string): string {
  const match = command.match(/^(\S+)([\s\S]*)$/);
  if (!match) return command;
  const first = match[1].replace(/^['"]+|['"]+$/g, "");
  return `${basename(first)}${match[2]}`;
}

export function classifyAntigravityCommand(command: string): AgentLaunchTarget {
  const trimmed = command.trim();
  if (!trimmed) return "cli";
  if (DESKTOP_LAUNCHERS.test(stripLeadingCommandPath(trimmed))) {
    return "desktop-app";
  }
  for (const raw of trimmed.split(/\s+/)) {
    const token = raw.replace(/^['"]+|['"]+$/g, "");
    if (!token) continue;
    if (/\.app(?:[/\\]|$)/i.test(token)) return "desktop-app";
    if (/\.desktop$/i.test(token)) return "desktop-app";
    if (DESKTOP_BASENAMES.has(basename(token))) return "desktop-app";
  }
  return "cli";
}

export const ANTIGRAVITY_GUI_REFUSAL =
  "Antigravity's desktop app cannot run inside a terminal pane. Start its terminal CLI instead (for example `agy`).";
