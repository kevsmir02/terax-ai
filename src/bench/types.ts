import type { QuitPhase } from "@/modules/shutdown";
import type { CheckpointBridgePending } from "@/modules/source-control/checkpointBridge";
import type { DestructiveGitBridgePending } from "@/modules/source-control/destructiveGitBridge";
import type { Tab } from "@/modules/tabs";
import type { WorktreeBridge } from "@/modules/worktrees/worktreeBridge";
import type { WorktreeRemovalBridge } from "@/modules/worktrees/worktreeRemovalBridge";

/** What the scenario driver may do to the running application: the app's own tab actions. */
export type BenchAppApi = {
  tabs: Tab[];
  activeId: number;
  /** The restore/boot flow finished; the first terminal tab exists. */
  booted: boolean;
  setActiveId: (id: number) => void;
  newTab: (cwd?: string) => number;
  newBlockTab: (cwd?: string) => number;
  newAgentGroupTab: (
    cwd: string | undefined,
    title: string,
    instances: 1 | 2 | 3 | 4,
  ) => { tabId: number; leafIds: number[] };
  splitActivePane: (tabId: number, dir: "row" | "col") => number | null;
  closeTab: (id: number) => void;
  /** Opens a file in an editor tab (the app's own planner); returns the tab id. */
  openFileTab: (path: string, pin?: boolean, spaceId?: string) => number;
  /** Opens a rendered Markdown tab (the app's own planner); returns the tab id. */
  openMarkdownTab: (path: string) => number;
  /** Applies the terminal's own cwd update, as an OSC 7 report would. */
  setLeafCwd: (leafId: number, cwd: string) => void;
  readBuffer: (leafId: number, maxLines?: number) => string | null;
  /** Spaces (workspaces) the application knows about. */
  spaces: { id: string; name: string; root: string | null }[];
  activeSpaceId: string | null;
  createSpace: (name: string, root: string | null) => string;
  setActiveSpace: (id: string) => void;
  /** Appends a cold terminal tab to a space without stealing focus (it spawns when opened). */
  newTabInSpace: (spaceId: string, cwd?: string) => number;
  /** Opens the web preview pane (the app's own planner); returns the tab id. */
  openPreview: (url: string) => number;
  /** Space lifecycle (the app's own guards, not direct disposal). */
  requestCloseTab: (id: number) => void;
  cancelPendingClose: () => void;
  confirmDiscardTab: () => void;
  saveAndCloseTab: () => void;
  requestDeleteSpace: (id: string) => void;
  cancelDeleteSpace: () => void;
  confirmDeleteSpace: () => void;
  saveAndDeleteSpace: () => void;
  pendingGuards: () => {
    closeTabId: number | null;
    terminalTabId: number | null;
    spaceDeleteId: string | null;
    closeSaveState: "idle" | "saving" | "incomplete";
    spaceDeleteIncomplete: boolean;
  };
  /** Insert text through the editor's real editing path (dirty buffer, drafts, saves). */
  editEditor: (tabId: number, text: string) => void;
  /** Persist one editor buffer; false when the write was incomplete, failed or conflicted. */
  saveEditor: (tabId: number) => Promise<boolean>;
  /** One editor buffer's text, read from CodeMirror (a modal dialog hides it from the DOM). */
  readEditor: (tabId: number) => string | null;
  /** Shows the Source Control panel so its real destructive-action guard mounts. */
  openSourceControl: () => void;
  /** Opens the Source Control panel's worktree dialog (the app's own state). */
  openWorktreeDialog: () => void;
  /** Drives the dialog's own form, preflight and submit path. */
  worktree: () => WorktreeBridge | null;
  /** Opens the removal dialog for one worktree path in its repository. */
  openWorktreeRemove: (repoRoot: string, path: string) => void;
  /** Drives the removal dialog's own preflight, cleanup and confirm path. */
  worktreeRemove: () => WorktreeRemovalBridge | null;
  /** Drives the panel's own destructive-action guard (never a second implementation). */
  destructiveGit: () => {
    mounted: boolean;
    ready: boolean;
    busy: boolean;
    pending: DestructiveGitBridgePending | null;
    requestDiscard: (paths: string[]) => Promise<void>;
    confirm: (confirmation: {
      unsavedBuffers: number[];
      activeWork: number[];
      force: boolean;
    }) => Promise<void>;
    cancel: () => void;
  };
  /** Drives the Checkpoints panel, its native preflight and shared restore guard. */
  checkpoints: () => {
    mounted: boolean;
    ready: boolean;
    busy: boolean;
    groups: { manual: number; safety: number; turns: number } | null;
    pending: CheckpointBridgePending | null;
    error: string | null;
    message: string | null;
    open: () => void;
    close: () => void;
    create: (name: string | null) => Promise<void>;
    requestRestore: (ref: string) => Promise<void>;
    cleanup: (ref: string) => Promise<void>;
    confirm: (confirmation: {
      unsavedBuffers: number[];
      activeWork: number[];
      force: boolean;
    }) => Promise<void>;
    cancel: () => void;
  };
  /** Quit (ticket #18): the same gate the window's close event enters. */
  requestQuit: () => void;
  cancelQuit: () => void;
  confirmQuit: () => void;
  saveAllAndQuit: () => void;
  retryQuitFlush: () => void;
  loseDraftsAndQuit: () => void;
  forceQuit: () => void;
  quitState: () => BenchQuitState;
};

/** What the quit gate resolved to, as the driver observes it. */
export type BenchQuitState = {
  phase: QuitPhase;
  /** The confirmed close was recorded (bench) instead of ending the process. */
  closed: boolean;
  note: string | null;
  totals: {
    buffers: number;
    processes: number;
    uncertainProcesses: number;
    drafts: number;
  };
  spaces: Array<{
    id: string;
    name: string;
    buffers: Array<{ tabId: number; title: string }>;
    processes: Array<{ leafId: number; state: string }>;
    drafts: Array<{ bufferId: string; title: string; state: string }>;
  }>;
  survivors: number[];
  flush: {
    outcome: string;
    drafts: Array<{ bufferId: string; title: string; state: string }>;
  } | null;
};

/** One scenario, as written by scripts/app-lab/run.py into TERAX_BENCH_SCENARIO. */
export type BenchScenario = {
  name:
    | "tabs"
    | "resize"
    | "split-drag"
    | "occlusion"
    | "agents-steady"
    | "idle"
    | "fs-churn"
    | "input"
    | "workflow"
    | "markdown"
    | "spaces"
    | "git"
    | "worktree"
    | "checkpoints"
    | "preview"
    | "images"
    | "media"
    | "resource"
    | "stress"
    | "quit"
    | "recovery"
    | "startup";
  /** tabs: "2" (shell + agent) or "4" (shell, agent, agent+shell split, shell). */
  variant?: string;
  /** Shell command that starts the synthetic agent (see scripts/app-lab/agent-sim.mjs). */
  agentCommand: string;
  window?: { width: number; height: number };
  cycles?: number;
  dwellMs?: number;
  hiddenMs?: number;
  visibleMs?: number;
  durationS?: number;
  warmupS?: number;
  hiddenAgents?: number;
  /** git/checkpoints: an isolated scratch repository the scenario mutates and inspects. */
  git?: {
    repo: string;
    fileA: string;
    fileB: string;
    baseA: string;
    baseB: string;
    editedA: string;
    editedB: string;
    /** checkpoints: captured-free files the manual capture must disclose. */
    ignoredFile?: string;
    ignoredCount?: number;
    stagedFile?: string;
    stagedCount?: number;
  };
  /** worktree: an isolated scratch repository and the paths refusals use. */
  worktree?: {
    repo: string;
    /** A location that does not exist yet: the successful creation. */
    createPath: string;
    /** An ignored file the success must copy. */
    ignoredFile: string;
    /** A location that exists as a file: refusal. */
    filePath: string;
    /** A non-empty directory: refusal, and its file must survive. */
    dirtyPath: string;
    dirtyFile: string;
  };
  /** split-drag: seconds of divider motion per drag, and its amplitude as a share of the pane area. */
  dragS?: number;
  dragAmplitude?: number;
  /** split-drag: mouse sample rate of the synthetic drag (Hz). */
  mouseHz?: number;
  /** resize: grow the window before shrinking it (takes it past the size the canvas was allocated for). */
  growFirst?: boolean;
  steps?: number;
  stepPoints?: number;
  stepIntervalMs?: number;
  live?: boolean;
  /** Working directories of new shell and agent tabs (the first tab uses the launch directory). */
  cwds?: { shell?: string; agent?: string };
  /** After the idle tail, request a full garbage collection (WebKit's testing SPI, or allocation pressure from the page) and sample again. */
  gc?: "private" | "alloc";
  /** idle: suspected wakeup source to remove before measuring ("blur" the focused element, "caret-transparent"). */
  probe?: string;
  /** Mitigation probe (see ScenarioRun.startValve): periodic allocation pressure. */
  valve?: { everyS: number; chunks: number; chunkMb: number };
  /** tabs: index (0-based, creation order) of the tab shown at baseline; default 0. */
  holdTab?: number;
  /** tabs control: run the same loop without ever switching tabs. */
  noSwitch?: boolean;
  /** idle, fs-churn: take a full sample every this many seconds (`tick-N`, with the layer tree). */
  tickS?: number;
  /** fs-churn: the orchestrator moves another application to the front; samples need no key window. */
  unfocused?: boolean;
  /** Patch WebGPU/DOM prototypes with lifecycle counters (src/bench/gpuCounters.ts). */
  instrument?: boolean;
  /** Application preferences to set through the app's own store before the scenario starts. */
  prefs?: { windowVibrancy?: boolean; editorRecoveryDrafts?: boolean };
  /** localStorage entries to set (null removes) before the application starts. */
  localStorage?: Record<string, string | null>;
  /** workflow: absolute path of the temp file the scenario opens and asserts. */
  file?: string;
  /** workflow: the file's distinctive first line, asserted in the rendered editor. */
  fileText?: string;
  /** workflow: the external-writer and stale-typing fixtures (inside the scenario workspace). */
  workflow?: {
    /** A file the harness rewrites from outside the app while the buffer is dirty. */
    conflictFile: string;
    /** A file whose save the driver stalls so it can type during the write. */
    staleFile: string;
    /** Bench-only native write delay (`TERAX_BENCH_WRITE_DELAY_MS`), in milliseconds. */
    writeDelayMs?: number;
  };
  /** quit: a file inside a directory the harness makes unwritable to force a failed save. */
  quit?: { stalledFile: string; stalledDir: string };
  /**
   * recovery: one launch of the crash-recovery row. `write` dirties buffers and asks the harness
   * to SIGKILL the app once the drafts are durably acknowledged; `restore` runs after the crash
   * with the same profile and workspace.
   */
  recovery?: {
    phase: "write" | "restore";
    file: string;
    otherFile: string;
    /** write: the text to insert. restore: the inserted token text. */
    text: string;
    otherText: string;
    /** restore: the exact full buffer text launch 1 acknowledged for each file. */
    expectedText?: string;
    expectedOtherText?: string;
    /** restore: the buffer ids the first launch reported durable. */
    expectedBufferIds?: string[];
  };
  /** markdown: documents and assets the scenario drives through the real preview. */
  markdown?: {
    /** The configured Space project root (the app's launch directory). */
    workspace: string;
    /** A document inside the root with an allowed image and a symlink escape. */
    insideDoc: string;
    /** A document outside the root with a sibling image and an outside image. */
    outsideDoc: string;
    /** A document whose only image is remote. */
    remoteDoc: string;
    /** A document with relative and external links. */
    linkDoc: string;
    /** A document whose references are hostile: asset://, javascript:, file:, script, onerror. */
    maliciousDoc: string;
    /** A large document above the approved 4 MiB syntax ceiling. */
    largeDoc: string;
    /** Orchestrator URL that counts remote image fetches. */
    remoteImage: string;
    /** Marker text inside the large document. */
    largeMarker: string;
  };
  /** images: fixture paths the scenario opens and asserts through the image surface. */
  images?: {
    png: string;
    jpeg: string;
    gif: string;
    webp: string;
    bmp: string;
    ico: string;
    avif: string;
    svg: string;
    corrupt: string;
    oversized: string;
  };
  /** media: fixture paths the scenario opens and asserts through the media surface. */
  media?: {
    mp4: string;
    m4a: string;
    mov: string;
    webm: string;
    mkv: string;
    ogg: string;
    wav: string;
    mp3: string;
    flac: string;
    aac: string;
    corrupt: string;
    unsupportedCodec: string;
    /** WebM bytes with a `.mp4` name: the probe must report the mismatch. */
    mismatch: string;
    /** >1 MiB PCM WAV so playback has to ask for more than one delivery chunk. */
    large: string;
    /** Containers whose real playback outcome the scenario measures. */
    measured: string[];
    /** Containers this host's build was measured to play (run.py records them). */
    expectedSupported: string[];
  };
  /** resource/stress: directory used as the second Space's root and the preview fixture root. */
  workspace?: string;
  /** resource/stress: absolute paths of the text files opened as editor tabs. */
  files?: string[];
  /** resource/stress: absolute path opened and closed in every close cycle. */
  closeFile?: string;
  /** resource/stress: local fixture URL shown in the active preview tab. */
  previewUrl?: string;
  /** resource/stress: seconds of sustained terminal streaming. */
  streamSeconds?: number;
  /** resource/stress: shell command that streams terminal output for `streamSeconds`. */
  streamCommand?: string;
  /** resource/stress: label of the workload (recorded in the report). */
  workload?: string;
  /** resource/stress: number of busy synthetic agents (default 2). */
  agents?: number;
  /** resource/stress: number of terminal panes that receive the streaming command (max 4). */
  streams?: number;
  /** resource/stress: editor tab open/close cycles. */
  closeCycles?: number;
  /** resource/stress: seconds the app is left idle (one shell, no agents) before the workload. */
  idleSeconds?: number;
  /** preview: the PDF fixtures the scenario opens (see scripts/app-lab/pdf_fixtures.py). */
  pdf?: PdfFixtures;
  /**
   * preview: keep the representative PDF on screen this long after its sample, so the named
   * reader checks (`docs/architecture/pdf-reader.md`) can be run against the real window.
   */
  pdfHoldMs?: number;
};

/**
 * PDF documents for the preview scenario, generated and independently verified by
 * `scripts/app-lab/pdf_fixtures.py`. `ceilingBytes` is parsed there from the TypeScript that owns
 * the approved limit, and the driver compares it with `PDF_PAGE_LIMIT_BYTES` so the two cannot
 * drift apart silently.
 */
export type PdfFixtures = {
  files: {
    text: string;
    "zoomed-a4": string;
    "large-page": string;
    oversized: string;
    corrupt: string;
    "not-a-pdf": string;
  };
  sizes: Record<string, number>;
  textPages: number;
  searchPrefix: string;
  searchTemplate: string;
  uniqueNeedle: string;
  uniquePage: number;
  ceilingBytes: number;
  /** Render bytes per zoom factor for the fixtures where the ceiling decision matters. */
  renders: Record<string, { zoom: number; bytes: number }[]>;
  pagePt: Record<string, { widthPt: number; heightPt: number }>;
  /** Milliseconds the representative PDF is held on screen (see `pdfHoldMs`). */
  holdMs?: number;
};

export type BenchConfig = {
  scenario: BenchScenario | null;
  reportUrl: string | null;
  identifier: string;
};
