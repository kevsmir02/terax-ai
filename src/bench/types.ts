import type { Tab } from "@/modules/tabs";

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
  spaces: { id: string; name: string }[];
  activeSpaceId: string | null;
  createSpace: (name: string, root: string | null) => string;
  setActiveSpace: (id: string) => void;
  /** Appends a cold terminal tab to a space without stealing focus (it spawns when opened). */
  newTabInSpace: (spaceId: string, cwd?: string) => number;
  /** Opens the web preview pane (the app's own planner); returns the tab id. */
  openPreview: (url: string) => number;
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
    | "preview"
    | "images"
    | "resource"
    | "stress"
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
  prefs?: { windowVibrancy?: boolean };
  /** localStorage entries to set (null removes) before the application starts. */
  localStorage?: Record<string, string | null>;
  /** workflow: absolute path of the temp file the scenario opens and asserts. */
  file?: string;
  /** workflow: the file's distinctive first line, asserted in the rendered editor. */
  fileText?: string;
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
};

export type BenchConfig = {
  scenario: BenchScenario | null;
  reportUrl: string | null;
  identifier: string;
};
