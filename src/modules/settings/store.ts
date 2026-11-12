import {
  type AgentLaunchCommands,
  DEFAULT_AGENT_LAUNCH_COMMANDS,
  normalizeAgentLaunchCommands,
} from "@/modules/agents/lib/launcher";
import type { KeyBinding, ShortcutId } from "@/modules/shortcuts/shortcuts";
import {
  coerceMacOptionAsAlt,
  DEFAULT_MAC_OPTION_AS_ALT,
  type MacOptionAsAlt,
} from "@/modules/terminal/ghostty/input/macOptionAsAlt";
import {
  clampScrollSpeed,
  DEFAULT_SCROLL_SPEED,
} from "@/modules/terminal/ghostty/input/terminalWheel";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";

export type ThemePref = "system" | "light" | "dark";

export const DEFAULT_THEME_ID = "terax-default";

export type BackgroundKind = "none" | "image";

export type TerminalCursorStyle = "bar" | "block" | "underline";

export const EDITOR_THEMES = [
  "kanagawa",
  "kanagawa-lotus",
  "kanagawa-dragon",
  "tokyo-night",
  "catppuccin-mocha",
  "catppuccin-latte",
  "rose-pine",
  "rose-pine-dawn",
  "everforest",
  "everforest-light",
  "dracula",
  "solarized-dark",
  "solarized-light",
  "nord",
  "gruvbox-dark",
  "atomone",
  "aura",
  "copilot",
  "github-dark",
  "github-light",
  "xcode-dark",
  "xcode-light",
] as const;

export type EditorThemeId = (typeof EDITOR_THEMES)[number];

/** "auto" follows the active app theme's editorTheme pairing (resolved live). */
export const EDITOR_THEME_AUTO = "auto" as const;
export type EditorThemePref = typeof EDITOR_THEME_AUTO | EditorThemeId;

export function isEditorThemeId(v: unknown): v is EditorThemeId {
  return (
    typeof v === "string" && (EDITOR_THEMES as readonly string[]).includes(v)
  );
}

export const EDITOR_THEME_MODE: Record<EditorThemeId, "light" | "dark"> = {
  kanagawa: "dark",
  "kanagawa-lotus": "light",
  "kanagawa-dragon": "dark",
  "tokyo-night": "dark",
  "catppuccin-mocha": "dark",
  "catppuccin-latte": "light",
  "rose-pine": "dark",
  "rose-pine-dawn": "light",
  everforest: "dark",
  "everforest-light": "light",
  dracula: "dark",
  "solarized-dark": "dark",
  "solarized-light": "light",
  nord: "dark",
  "gruvbox-dark": "dark",
  atomone: "dark",
  aura: "dark",
  copilot: "dark",
  "github-dark": "dark",
  "github-light": "light",
  "xcode-dark": "dark",
  "xcode-light": "light",
};

export const EDITOR_THEME_LABELS: Record<EditorThemeId, string> = {
  kanagawa: "Kanagawa Wave",
  "kanagawa-lotus": "Kanagawa Lotus",
  "kanagawa-dragon": "Kanagawa Dragon",
  "tokyo-night": "Tokyo Night",
  "catppuccin-mocha": "Catppuccin Mocha",
  "catppuccin-latte": "Catppuccin Latte",
  "rose-pine": "Rosé Pine",
  "rose-pine-dawn": "Rosé Pine Dawn",
  everforest: "Everforest Dark",
  "everforest-light": "Everforest Light",
  dracula: "Dracula",
  "solarized-dark": "Solarized Dark",
  "solarized-light": "Solarized Light",
  nord: "Nord",
  "gruvbox-dark": "Gruvbox Dark",
  atomone: "Atom One",
  aura: "Aura",
  copilot: "Copilot",
  "github-dark": "GitHub Dark",
  "github-light": "GitHub Light",
  "xcode-dark": "Xcode Dark",
  "xcode-light": "Xcode Light",
};

export type Preferences = {
  theme: ThemePref;
  themeId: string;
  backgroundKind: BackgroundKind;
  backgroundImageId: string | null;
  backgroundOpacity: number;
  backgroundBlur: number;
  windowVibrancy: boolean;
  editorTheme: EditorThemePref;
  editorFontSize: number;
  autostart: boolean;
  restoreWindowState: boolean;
  vimMode: boolean;
  editorWordWrap: boolean;
  editorWordWrapColumn: number;
  showHidden: boolean;
  explorerGitDecorations: boolean;
  terminalRenderer: TerminalRendererSetting;
  terminalScreenReader: boolean;
  terminalCursorBlink: boolean;
  terminalCursorStyle: TerminalCursorStyle;
  terminalFontFamily: string;
  terminalFontWeight: string;
  terminalShell: string;
  terminalLetterSpacing: number;
  terminalFontSize: number;
  terminalScrollback: number;
  terminalScrollSpeed: number;
  terminalMacOptionAsAlt: MacOptionAsAlt;
  confirmCloseRunningTerminal: boolean;
  lastWslDistro: string | null;
  zoomLevel: number;
  agentNotifications: boolean;
  agentNotificationSound: boolean;
  agentLaunchCommands: AgentLaunchCommands;
  defaultWorkspaceEnv: string;
  shortcuts: Record<ShortcutId, KeyBinding[]>;
  editorAutoSave: boolean;
  editorAutoSaveDelay: number;
  editorFormatOnSave: boolean;
  editorFormatter: EditorFormatter;
  /** languageResolver id -> formatter, overriding the global default. */
  editorFormatterByLang: Record<string, EditorFormatter>;
  /** Shell template for the "custom" formatter; {file} is the quoted path. */
  editorCustomFormatCommand: string;
};

export type EditorFormatter =
  | "biome"
  | "prettier"
  | "ruff"
  | "rustfmt"
  | "gofmt"
  | "clang-format"
  | "shfmt"
  | "zigfmt"
  | "custom";

const STORE_PATH = "terax-settings.json";
const KEY_THEME = "theme";
const KEY_THEME_ID = "themeId";
const KEY_BG_KIND = "backgroundKind";
const KEY_BG_IMAGE_ID = "backgroundImageId";
const KEY_BG_OPACITY = "backgroundOpacity";
const KEY_BG_BLUR = "backgroundBlur";
const KEY_WINDOW_VIBRANCY = "windowVibrancy";
const KEY_EDITOR_THEME = "editorTheme";
const KEY_EDITOR_FONT_SIZE = "editorFontSize";
const KEY_AUTOSTART = "autostart";
const KEY_RESTORE_WINDOW = "restoreWindowState";
const KEY_VIM_MODE = "vimMode";
const KEY_EDITOR_WORD_WRAP = "editorWordWrap";
const KEY_EDITOR_WORD_WRAP_COLUMN = "editorWordWrapColumn";
const KEY_SHOW_HIDDEN = "showHidden";
const LEGACY_KEY_SHOW_HIDDEN_DIRS = "showHiddenDirectories";
const KEY_EXPLORER_GIT_DECORATIONS = "explorerGitDecorations";
const KEY_TERMINAL_RENDERER = "terminalRenderer";
const KEY_TERMINAL_SCREEN_READER = "terminalScreenReader";
const KEY_TERMINAL_CURSOR_BLINK = "terminalCursorBlink";
const KEY_TERMINAL_CURSOR_STYLE = "terminalCursorStyle";
const KEY_TERMINAL_FONT_FAMILY = "terminalFontFamily";
const KEY_TERMINAL_FONT_WEIGHT = "terminalFontWeight";
const KEY_TERMINAL_SHELL = "terminalShell";
const KEY_TERMINAL_LETTER_SPACING = "terminalLetterSpacing";
const KEY_TERMINAL_FONT_SIZE = "terminalFontSize";
const KEY_TERMINAL_SCROLLBACK = "terminalScrollback";
const KEY_TERMINAL_SCROLL_SPEED = "terminalScrollSpeed";
const KEY_TERMINAL_MAC_OPTION_AS_ALT = "terminalMacOptionAsAlt";
const KEY_CONFIRM_CLOSE_RUNNING_TERMINAL = "confirmCloseRunningTerminal";
const KEY_LAST_WSL_DISTRO = "lastWslDistro";
const KEY_ZOOM_LEVEL = "zoomLevel";
const KEY_AGENT_NOTIFICATIONS = "agentNotifications";
const KEY_AGENT_NOTIFICATION_SOUND = "agentNotificationSound";
const KEY_AGENT_LAUNCH_COMMANDS = "agentLaunchCommands";
const KEY_DEFAULT_WORKSPACE_ENV = "defaultWorkspaceEnv";
const KEY_SHORTCUTS = "shortcuts";
const KEY_EDITOR_AUTO_SAVE = "editorAutoSave";
const KEY_EDITOR_AUTO_SAVE_DELAY = "editorAutoSaveDelay";
const KEY_EDITOR_FORMAT_ON_SAVE = "editorFormatOnSave";
const KEY_EDITOR_FORMATTER = "editorFormatter";
const KEY_EDITOR_FORMATTER_BY_LANG = "editorFormatterByLang";
const KEY_EDITOR_CUSTOM_FORMAT_COMMAND = "editorCustomFormatCommand";

const TERMINAL_FONT_SIZE_DEFAULT = 14;
const TERMINAL_FONT_SIZE_MIN = 8;
const TERMINAL_FONT_SIZE_MAX = 32;

export const TERMINAL_FONT_SIZES = [
  10, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const EDITOR_FONT_SIZE_DEFAULT = 13;
export const EDITOR_FONT_SIZE_MIN = 8;
export const EDITOR_FONT_SIZE_MAX = 32;
export const EDITOR_FONT_SIZES = [
  10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const EDITOR_WORD_WRAP_COLUMN_DEFAULT = 80;
export const EDITOR_WORD_WRAP_COLUMN_MIN = 20;
export const EDITOR_WORD_WRAP_COLUMN_MAX = 500;

const TERMINAL_SCROLLBACK_DEFAULT = 2000;
const TERMINAL_SCROLLBACK_MIN = 200;
const TERMINAL_SCROLLBACK_MAX = 50_000;
export const TERMINAL_SCROLLBACK_PRESETS = [
  500, 1000, 2000, 5000, 10_000, 25_000,
] as const;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  themeId: DEFAULT_THEME_ID,
  backgroundKind: "none",
  backgroundImageId: null,
  backgroundOpacity: 0.5,
  backgroundBlur: 0,
  editorTheme: EDITOR_THEME_AUTO,
  editorFontSize: EDITOR_FONT_SIZE_DEFAULT,
  autostart: false,
  // Off by default: a translucent window keeps the compositor blending the
  // whole frame every present. An explicitly stored choice (either value)
  // always wins; only an absent key falls back to this.
  windowVibrancy: false,
  restoreWindowState: true,
  vimMode: false,
  editorWordWrap: false,
  editorWordWrapColumn: EDITOR_WORD_WRAP_COLUMN_DEFAULT,
  showHidden: false,
  explorerGitDecorations: true,
  terminalRenderer: "auto",
  terminalScreenReader: false,
  terminalCursorBlink: false,
  terminalCursorStyle: "bar",
  terminalFontFamily: "",
  terminalFontWeight: "normal",
  terminalShell: "",
  terminalLetterSpacing: 0,
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  terminalScrollback: TERMINAL_SCROLLBACK_DEFAULT,
  terminalScrollSpeed: DEFAULT_SCROLL_SPEED,
  terminalMacOptionAsAlt: DEFAULT_MAC_OPTION_AS_ALT,
  confirmCloseRunningTerminal: true,
  lastWslDistro: null,
  zoomLevel: 1.0,
  agentNotifications: true,
  // Sound is opt-in: background agents must not make noise by default.
  agentNotificationSound: false,
  agentLaunchCommands: DEFAULT_AGENT_LAUNCH_COMMANDS,
  defaultWorkspaceEnv: "local",
  shortcuts: {} as Record<ShortcutId, KeyBinding[]>,
  editorAutoSave: false,
  editorAutoSaveDelay: 1000,
  editorFormatOnSave: false,
  editorFormatter: "custom",
  editorFormatterByLang: {},
  editorCustomFormatCommand: "",
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

// LazyStore.onChange only fires within the writing process. The settings
// page lives in a separate webview, so writes there never reach the main
// window's subscribers. Mirror every setter through a Tauri event so any
// window can listen.
const PREFS_CHANGED_EVENT = "terax://prefs-changed";

async function writePref<T>(key: string, value: T): Promise<void> {
  await store.set(key, value);
  await store.save();
  await emit(PREFS_CHANGED_EVENT, { key, value });
}

// `lsp` was the stored default before language servers were removed. A stale
// value must not reach the formatter registry, where it would resolve to
// nothing; map it (and anything unrecognised) to the no-op "custom" choice.
const REMOVED_FORMATTER_ID = "lsp";

function normalizeEditorFormatter(
  value: unknown,
  fallback: EditorFormatter,
): EditorFormatter {
  if (typeof value !== "string" || value === REMOVED_FORMATTER_ID)
    return fallback;
  return value as EditorFormatter;
}

function normalizeFormatterByLang(
  value: unknown,
): Record<string, EditorFormatter> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([, formatter]) =>
          typeof formatter === "string" && formatter !== REMOVED_FORMATTER_ID,
      )
      .map(([lang, formatter]) => [lang, formatter as EditorFormatter]),
  );
}

export async function loadPreferences(): Promise<Preferences> {
  // Single IPC roundtrip — fetching keys individually fans out to one
  // `plugin:store|get` per setting and is the dominant boot cost.
  const entries = await store.entries();
  const map = new Map<string, unknown>(entries);
  const get = <T>(k: string): T | undefined => map.get(k) as T | undefined;
  return {
    theme: get<ThemePref>(KEY_THEME) ?? DEFAULT_PREFERENCES.theme,
    themeId: get<string>(KEY_THEME_ID) ?? DEFAULT_PREFERENCES.themeId,
    backgroundKind:
      get<BackgroundKind>(KEY_BG_KIND) ?? DEFAULT_PREFERENCES.backgroundKind,
    backgroundImageId:
      get<string | null>(KEY_BG_IMAGE_ID) ??
      DEFAULT_PREFERENCES.backgroundImageId,
    backgroundOpacity: clampBgOpacity(
      get<number>(KEY_BG_OPACITY) ?? DEFAULT_PREFERENCES.backgroundOpacity,
    ),
    backgroundBlur: clampBlur(
      get<number>(KEY_BG_BLUR) ?? DEFAULT_PREFERENCES.backgroundBlur,
    ),
    editorTheme: ((): EditorThemePref => {
      const stored = get<string>(KEY_EDITOR_THEME);
      if (stored === EDITOR_THEME_AUTO || isEditorThemeId(stored))
        return stored;
      return DEFAULT_PREFERENCES.editorTheme;
    })(),
    editorFontSize: clampEditorFontSize(
      get<number>(KEY_EDITOR_FONT_SIZE) ?? DEFAULT_PREFERENCES.editorFontSize,
    ),
    autostart: get<boolean>(KEY_AUTOSTART) ?? DEFAULT_PREFERENCES.autostart,
    restoreWindowState:
      get<boolean>(KEY_RESTORE_WINDOW) ??
      DEFAULT_PREFERENCES.restoreWindowState,
    windowVibrancy:
      get<boolean>(KEY_WINDOW_VIBRANCY) ?? DEFAULT_PREFERENCES.windowVibrancy,
    vimMode: get<boolean>(KEY_VIM_MODE) ?? DEFAULT_PREFERENCES.vimMode,
    editorWordWrap:
      get<boolean>(KEY_EDITOR_WORD_WRAP) ?? DEFAULT_PREFERENCES.editorWordWrap,
    editorWordWrapColumn: clampEditorWordWrapColumn(
      get<number>(KEY_EDITOR_WORD_WRAP_COLUMN) ??
        DEFAULT_PREFERENCES.editorWordWrapColumn,
    ),
    showHidden:
      get<boolean>(KEY_SHOW_HIDDEN) ??
      get<boolean>(LEGACY_KEY_SHOW_HIDDEN_DIRS) ??
      DEFAULT_PREFERENCES.showHidden,
    explorerGitDecorations:
      get<boolean>(KEY_EXPLORER_GIT_DECORATIONS) ??
      DEFAULT_PREFERENCES.explorerGitDecorations,
    terminalRenderer: coerceTerminalRenderer(
      get<string>(KEY_TERMINAL_RENDERER),
    ),
    terminalScreenReader: get<boolean>(KEY_TERMINAL_SCREEN_READER) === true,
    terminalCursorBlink:
      get<boolean>(KEY_TERMINAL_CURSOR_BLINK) ??
      DEFAULT_PREFERENCES.terminalCursorBlink,
    terminalCursorStyle: coerceTerminalCursorStyle(
      get<unknown>(KEY_TERMINAL_CURSOR_STYLE),
    ),
    terminalFontFamily:
      get<string>(KEY_TERMINAL_FONT_FAMILY) ??
      DEFAULT_PREFERENCES.terminalFontFamily,
    terminalFontWeight: coerceFontWeight(
      get<string>(KEY_TERMINAL_FONT_WEIGHT) ??
        DEFAULT_PREFERENCES.terminalFontWeight,
    ),
    terminalShell:
      get<string>(KEY_TERMINAL_SHELL) ?? DEFAULT_PREFERENCES.terminalShell,
    terminalLetterSpacing:
      get<number>(KEY_TERMINAL_LETTER_SPACING) ??
      DEFAULT_PREFERENCES.terminalLetterSpacing,
    terminalFontSize:
      get<number>(KEY_TERMINAL_FONT_SIZE) ??
      DEFAULT_PREFERENCES.terminalFontSize,
    terminalScrollback: clampScrollback(
      get<number>(KEY_TERMINAL_SCROLLBACK) ??
        DEFAULT_PREFERENCES.terminalScrollback,
    ),
    terminalScrollSpeed: clampScrollSpeed(
      get<number>(KEY_TERMINAL_SCROLL_SPEED),
    ),
    terminalMacOptionAsAlt: coerceMacOptionAsAlt(
      get<unknown>(KEY_TERMINAL_MAC_OPTION_AS_ALT),
    ),
    confirmCloseRunningTerminal:
      get<boolean>(KEY_CONFIRM_CLOSE_RUNNING_TERMINAL) ??
      DEFAULT_PREFERENCES.confirmCloseRunningTerminal,
    lastWslDistro:
      get<string | null>(KEY_LAST_WSL_DISTRO) ??
      DEFAULT_PREFERENCES.lastWslDistro,
    zoomLevel: get<number>(KEY_ZOOM_LEVEL) ?? DEFAULT_PREFERENCES.zoomLevel,
    agentNotifications:
      get<boolean>(KEY_AGENT_NOTIFICATIONS) ??
      DEFAULT_PREFERENCES.agentNotifications,
    agentNotificationSound:
      get<boolean>(KEY_AGENT_NOTIFICATION_SOUND) ??
      DEFAULT_PREFERENCES.agentNotificationSound,
    agentLaunchCommands: normalizeAgentLaunchCommands(
      get<unknown>(KEY_AGENT_LAUNCH_COMMANDS),
    ),
    defaultWorkspaceEnv:
      get<string>(KEY_DEFAULT_WORKSPACE_ENV) ??
      DEFAULT_PREFERENCES.defaultWorkspaceEnv,
    shortcuts:
      get<Record<ShortcutId, KeyBinding[]>>(KEY_SHORTCUTS) ??
      DEFAULT_PREFERENCES.shortcuts,
    editorAutoSave:
      get<boolean>(KEY_EDITOR_AUTO_SAVE) ?? DEFAULT_PREFERENCES.editorAutoSave,
    editorAutoSaveDelay: clampAutoSaveDelay(
      get<number>(KEY_EDITOR_AUTO_SAVE_DELAY) ??
        DEFAULT_PREFERENCES.editorAutoSaveDelay,
    ),
    editorFormatOnSave:
      get<boolean>(KEY_EDITOR_FORMAT_ON_SAVE) ??
      DEFAULT_PREFERENCES.editorFormatOnSave,
    editorFormatter: normalizeEditorFormatter(
      get<unknown>(KEY_EDITOR_FORMATTER),
      DEFAULT_PREFERENCES.editorFormatter,
    ),
    editorFormatterByLang: normalizeFormatterByLang(
      get<unknown>(KEY_EDITOR_FORMATTER_BY_LANG),
    ),
    editorCustomFormatCommand:
      get<string>(KEY_EDITOR_CUSTOM_FORMAT_COMMAND) ??
      DEFAULT_PREFERENCES.editorCustomFormatCommand,
  };
}

export async function setTheme(value: ThemePref): Promise<void> {
  await writePref(KEY_THEME, value);
}

export async function setThemeId(value: string): Promise<void> {
  await writePref(KEY_THEME_ID, value);
}

/** Slider stores 0..1. Actual rendered opacity is halved in SurfaceLayer
 *  so the image never exceeds 50% — keeps UI/terminal readable at any setting. */
export const BG_OPACITY_RENDER_FACTOR = 0.5;

function clampBgOpacity(v: number): number {
  if (!Number.isFinite(v)) return 0.7;
  return Math.min(1, Math.max(0, v));
}

function clampBlur(v: number): number {
  if (!Number.isFinite(v)) return 16;
  return Math.min(64, Math.max(0, Math.round(v)));
}

export async function setBackgroundKind(value: BackgroundKind): Promise<void> {
  await writePref(KEY_BG_KIND, value);
}

export async function setBackgroundImageId(
  value: string | null,
): Promise<void> {
  await writePref(KEY_BG_IMAGE_ID, value);
}

export async function setBackgroundOpacity(value: number): Promise<void> {
  await writePref(KEY_BG_OPACITY, clampBgOpacity(value));
}

export async function setBackgroundBlur(value: number): Promise<void> {
  await writePref(KEY_BG_BLUR, clampBlur(value));
}

export async function setEditorTheme(value: EditorThemePref): Promise<void> {
  await writePref(KEY_EDITOR_THEME, value);
}

export function clampEditorFontSize(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_FONT_SIZE_DEFAULT;
  return Math.min(
    EDITOR_FONT_SIZE_MAX,
    Math.max(EDITOR_FONT_SIZE_MIN, Math.round(value)),
  );
}

export async function setEditorFontSize(value: number): Promise<void> {
  await writePref(KEY_EDITOR_FONT_SIZE, clampEditorFontSize(value));
}

export async function setAutostart(value: boolean): Promise<void> {
  await writePref(KEY_AUTOSTART, value);
}

export async function setRestoreWindowState(value: boolean): Promise<void> {
  await writePref(KEY_RESTORE_WINDOW, value);
}

export async function setWindowVibrancy(value: boolean): Promise<void> {
  await writePref(KEY_WINDOW_VIBRANCY, value);
}

export async function setVimMode(value: boolean): Promise<void> {
  await writePref(KEY_VIM_MODE, value);
}

export async function setEditorWordWrap(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_WORD_WRAP, value);
}

export function clampEditorWordWrapColumn(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_WORD_WRAP_COLUMN_DEFAULT;
  return Math.min(
    EDITOR_WORD_WRAP_COLUMN_MAX,
    Math.max(EDITOR_WORD_WRAP_COLUMN_MIN, Math.round(value)),
  );
}

export async function setEditorWordWrapColumn(value: number): Promise<void> {
  await writePref(
    KEY_EDITOR_WORD_WRAP_COLUMN,
    clampEditorWordWrapColumn(value),
  );
}

export async function setShowHidden(value: boolean): Promise<void> {
  await writePref(KEY_SHOW_HIDDEN, value);
}

export async function setExplorerGitDecorations(value: boolean): Promise<void> {
  await writePref(KEY_EXPLORER_GIT_DECORATIONS, value);
}

export async function setTerminalRenderer(
  value: TerminalRendererSetting,
): Promise<void> {
  await writePref(KEY_TERMINAL_RENDERER, coerceTerminalRenderer(value));
}

export async function setTerminalScreenReader(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_SCREEN_READER, value);
}

export async function setTerminalCursorBlink(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_CURSOR_BLINK, value);
}

export function coerceTerminalCursorStyle(value: unknown): TerminalCursorStyle {
  return value === "bar" || value === "block" || value === "underline"
    ? value
    : DEFAULT_PREFERENCES.terminalCursorStyle;
}

export async function setTerminalCursorStyle(value: unknown): Promise<void> {
  await writePref(KEY_TERMINAL_CURSOR_STYLE, coerceTerminalCursorStyle(value));
}

export async function setTerminalFontFamily(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_FAMILY, value.trim());
}

const TERMINAL_FONT_WEIGHT_VALUES = new Set(["normal", "500", "600", "bold"]);

/** Renderer for new terminals: WebGPU with WebGL fallback, WebGPU, or WebGL. */
export type TerminalRendererSetting = "auto" | "webgpu" | "webgl";

export function coerceTerminalRenderer(
  value: unknown,
): TerminalRendererSetting {
  return value === "webgl" || value === "webgpu" ? value : "auto";
}

export function coerceFontWeight(value: string): string {
  const v = value.trim();
  return TERMINAL_FONT_WEIGHT_VALUES.has(v) ? v : "normal";
}

export async function setTerminalFontWeight(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_WEIGHT, coerceFontWeight(value));
}

export async function setTerminalShell(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_SHELL, value.trim());
}

export async function setTerminalMacOptionAsAlt(
  value: MacOptionAsAlt,
): Promise<void> {
  await writePref(KEY_TERMINAL_MAC_OPTION_AS_ALT, coerceMacOptionAsAlt(value));
}

export async function setTerminalScrollSpeed(value: number): Promise<void> {
  await writePref(KEY_TERMINAL_SCROLL_SPEED, clampScrollSpeed(value));
}

export async function setTerminalLetterSpacing(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.max(-10, Math.min(10, Math.round(value)))
    : 0;
  await writePref(KEY_TERMINAL_LETTER_SPACING, clamped);
}

export async function setTerminalFontSize(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)),
      )
    : TERMINAL_FONT_SIZE_DEFAULT;
  await writePref(KEY_TERMINAL_FONT_SIZE, clamped);
}

function clampScrollback(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_SCROLLBACK_DEFAULT;
  return Math.min(
    TERMINAL_SCROLLBACK_MAX,
    Math.max(TERMINAL_SCROLLBACK_MIN, Math.round(value)),
  );
}

export async function setTerminalScrollback(value: number): Promise<void> {
  await writePref(KEY_TERMINAL_SCROLLBACK, clampScrollback(value));
}

export async function setConfirmCloseRunningTerminal(
  value: boolean,
): Promise<void> {
  await writePref(KEY_CONFIRM_CLOSE_RUNNING_TERMINAL, value);
}

export async function setLastWslDistro(value: string | null): Promise<void> {
  await writePref(KEY_LAST_WSL_DISTRO, value);
}

export async function setZoomLevel(value: number): Promise<void> {
  await writePref(KEY_ZOOM_LEVEL, value);
}

export const AUTO_SAVE_DELAY_MIN = 100;
export const AUTO_SAVE_DELAY_MAX = 60000;

export function clampAutoSaveDelay(v: number): number {
  if (!Number.isFinite(v)) return 1000;
  return Math.min(
    AUTO_SAVE_DELAY_MAX,
    Math.max(AUTO_SAVE_DELAY_MIN, Math.round(v)),
  );
}

export async function setEditorAutoSave(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_AUTO_SAVE, value);
}

export async function setEditorAutoSaveDelay(value: number): Promise<void> {
  await writePref(KEY_EDITOR_AUTO_SAVE_DELAY, clampAutoSaveDelay(value));
}

export async function setEditorFormatOnSave(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_FORMAT_ON_SAVE, value);
}

export async function setEditorFormatter(
  value: EditorFormatter,
): Promise<void> {
  await writePref(KEY_EDITOR_FORMATTER, value);
}

export async function setEditorFormatterByLang(
  value: Record<string, EditorFormatter>,
): Promise<void> {
  await writePref(KEY_EDITOR_FORMATTER_BY_LANG, value);
}

export async function setEditorCustomFormatCommand(
  value: string,
): Promise<void> {
  await writePref(KEY_EDITOR_CUSTOM_FORMAT_COMMAND, value);
}

export async function setAgentNotifications(value: boolean): Promise<void> {
  await writePref(KEY_AGENT_NOTIFICATIONS, value);
}

export async function setAgentNotificationSound(value: boolean): Promise<void> {
  await writePref(KEY_AGENT_NOTIFICATION_SOUND, value);
}

export async function setAgentLaunchCommands(
  value: AgentLaunchCommands,
): Promise<void> {
  await writePref(
    KEY_AGENT_LAUNCH_COMMANDS,
    normalizeAgentLaunchCommands(value),
  );
}

export async function setDefaultWorkspaceEnv(value: string): Promise<void> {
  await writePref(KEY_DEFAULT_WORKSPACE_ENV, value);
}

export async function setShortcuts(
  value: Record<ShortcutId, KeyBinding[]> | {},
): Promise<void> {
  await writePref(KEY_SHORTCUTS, value);
}

export type PrefKey = keyof Preferences;

/** Subscribe to changes from any window (settings → main). */
export async function onPreferencesChange(
  cb: (key: PrefKey, value: unknown) => void,
): Promise<UnlistenFn> {
  const map: Record<string, PrefKey> = {
    [KEY_THEME]: "theme",
    [KEY_THEME_ID]: "themeId",
    [KEY_BG_KIND]: "backgroundKind",
    [KEY_BG_IMAGE_ID]: "backgroundImageId",
    [KEY_BG_OPACITY]: "backgroundOpacity",
    [KEY_BG_BLUR]: "backgroundBlur",
    [KEY_WINDOW_VIBRANCY]: "windowVibrancy",
    [KEY_EDITOR_THEME]: "editorTheme",
    [KEY_EDITOR_FONT_SIZE]: "editorFontSize",
    [KEY_AUTOSTART]: "autostart",
    [KEY_RESTORE_WINDOW]: "restoreWindowState",
    [KEY_VIM_MODE]: "vimMode",
    [KEY_EDITOR_WORD_WRAP]: "editorWordWrap",
    [KEY_EDITOR_WORD_WRAP_COLUMN]: "editorWordWrapColumn",
    [KEY_SHOW_HIDDEN]: "showHidden",
    [KEY_EXPLORER_GIT_DECORATIONS]: "explorerGitDecorations",
    [KEY_TERMINAL_RENDERER]: "terminalRenderer",
    [KEY_TERMINAL_SCREEN_READER]: "terminalScreenReader",
    [KEY_TERMINAL_CURSOR_BLINK]: "terminalCursorBlink",
    [KEY_TERMINAL_CURSOR_STYLE]: "terminalCursorStyle",
    [KEY_TERMINAL_FONT_FAMILY]: "terminalFontFamily",
    [KEY_TERMINAL_FONT_WEIGHT]: "terminalFontWeight",
    [KEY_TERMINAL_SHELL]: "terminalShell",
    [KEY_TERMINAL_LETTER_SPACING]: "terminalLetterSpacing",
    [KEY_TERMINAL_FONT_SIZE]: "terminalFontSize",
    [KEY_TERMINAL_SCROLLBACK]: "terminalScrollback",
    [KEY_TERMINAL_SCROLL_SPEED]: "terminalScrollSpeed",
    [KEY_TERMINAL_MAC_OPTION_AS_ALT]: "terminalMacOptionAsAlt",
    [KEY_CONFIRM_CLOSE_RUNNING_TERMINAL]: "confirmCloseRunningTerminal",
    [KEY_LAST_WSL_DISTRO]: "lastWslDistro",
    [KEY_ZOOM_LEVEL]: "zoomLevel",
    [KEY_AGENT_NOTIFICATIONS]: "agentNotifications",
    [KEY_AGENT_NOTIFICATION_SOUND]: "agentNotificationSound",
    [KEY_AGENT_LAUNCH_COMMANDS]: "agentLaunchCommands",
    [KEY_DEFAULT_WORKSPACE_ENV]: "defaultWorkspaceEnv",
    [KEY_SHORTCUTS]: "shortcuts",
    [KEY_EDITOR_AUTO_SAVE]: "editorAutoSave",
    [KEY_EDITOR_AUTO_SAVE_DELAY]: "editorAutoSaveDelay",
    [KEY_EDITOR_FORMAT_ON_SAVE]: "editorFormatOnSave",
    [KEY_EDITOR_FORMATTER]: "editorFormatter",
    [KEY_EDITOR_FORMATTER_BY_LANG]: "editorFormatterByLang",
    [KEY_EDITOR_CUSTOM_FORMAT_COMMAND]: "editorCustomFormatCommand",
  };
  // Same-process writes still fire onChange immediately; cross-window writes
  // arrive via the Tauri event emitted by writePref().
  const unsubLocal = await store.onChange<unknown>((key, value) => {
    const mapped = map[key];
    if (mapped) cb(mapped, value);
  });
  const unsubEvent = await listen<{ key: string; value: unknown }>(
    PREFS_CHANGED_EVENT,
    (e) => {
      const mapped = map[e.payload.key];
      if (mapped) cb(mapped, e.payload.value);
    },
  );
  return () => {
    unsubLocal();
    unsubEvent();
  };
}
