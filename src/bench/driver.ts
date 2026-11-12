import { invoke } from "@tauri-apps/api/core";
import { assetScopes } from "@/lib/assetScopes";
import { setWindowVibrancy } from "@/modules/settings/store";
import { ASSET_DELIVERY } from "@/modules/preview/lib/assetDelivery";
import {
  PDF_PAGE_LIMIT_BYTES,
  pdfPageDecision,
} from "@/modules/preview/lib/limits";
import { useViewerAdmissionStore } from "@/modules/preview/lib/viewerAdmission";
import { whenSessionReady, writeToSession } from "@/modules/terminal";
import type { Tab } from "@/modules/tabs";
import {
  readTerminalClipboard,
  writeTerminalClipboard,
} from "@/modules/terminal/lib/terminalClipboard";
import { collectDiagnostics } from "./diagnostics";
import { nativeWindow, reportError, reportPhase } from "./report";
import { installSmoothProbe, type SmoothSummary } from "./smoothProbe";
import type {
  BenchAppApi,
  BenchConfig,
  BenchScenario,
  PdfFixtures,
} from "./types";

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type Result = { ok?: boolean };

const macrotask = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });

/**
 * Phases that deliberately leave the window hidden, minimized or behind another window.
 * Bringing it back first would erase the very state the phase exists to record (and on Linux
 * `activate` shows the window again).
 */
function keepsWindowState(phase: string): boolean {
  return phase.endsWith("-hidden") || phase === "preview-minimized";
}

/**
 * A garbage collection requested from the page itself, with no testing SPI: external-memory
 * pressure (large ArrayBuffers) and object churn reach JavaScriptCore's collection heuristics
 * (the same probe as scripts/renderer-profile `--force-gc alloc`). Shows whether a pressure valve
 * inside the application could stand in for the SPI.
 */
async function allocateGarbage(): Promise<{
  ok: boolean;
  mode: string;
  chunks: number;
  objects: number;
}> {
  let chunks = 0;
  let objects = 0;
  for (let round = 0; round < 6; round++) {
    for (let index = 0; index < 4; index++) {
      const buffer = new Uint8Array(64 * 1024 * 1024);
      buffer[0] = index;
      chunks++;
      await macrotask();
    }
    let churn: object[] | null = Array.from({ length: 400_000 }, (_, i) => ({
      i,
      text: `g${i}`,
    }));
    objects += churn.length;
    churn = null;
    await macrotask();
  }
  return { ok: true, mode: "alloc", chunks, objects };
}

/**
 * Runs one scenario inside the real application, using the app's own tab actions and real PTYs,
 * and reports phase events to the orchestrator (scripts/app-lab/run.py).
 */
class ScenarioRun {
  constructor(
    private readonly reportUrl: string,
    readonly scenario: BenchScenario,
    readonly app: () => BenchAppApi,
  ) {}

  /**
   * Resolves when the orchestrator has sampled the processes for this phase. A sample is only
   * valid evidence with the window key and the app active; when the orchestrator finds focus was
   * taken (by another application, or the user) it asks for the phase again after the window
   * has been brought back.
   */
  async sync(
    phase: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      if (!this.scenario.unfocused && !keepsWindowState(phase))
        await this.ensureFront();
      const app = this.app();
      const layers = await this.layerTree(phase);
      const { retry } = await reportPhase(this.reportUrl, phase, {
        ...extra,
        ...(layers ? { layers } : {}),
        attempt,
        ...(this.scenario.unfocused ? { unfocused: true } : {}),
        refronted: this.refronted,
        diag: collectDiagnostics(app.tabs, app.activeId),
      });
      if (!retry) return;
      this.refronted += 1;
      await this.native({ cmd: "activate" });
      await pause(1000);
    }
  }

  async log(line: string): Promise<void> {
    await fetch(`${this.reportUrl}/log`, { method: "POST", body: line }).catch(
      () => undefined,
    );
  }

  /** An absolute URL of the orchestrator's own HTTP server (it also serves the preview fixture). */
  url(path: string): string {
    return `${this.reportUrl}${path}`;
  }

  /**
   * The web view's composited layer tree (UI-process mirror of WebKit's layers; see
   * `bench_window layers`). The full list is kept at rest, only the counts elsewhere.
   */
  async layerTree(phase: string): Promise<Record<string, unknown> | null> {
    const full = /^(baseline|setup-complete|measure-start|tick-\d+)$/.test(
      phase,
    );
    const brief = /^(shrink-1|grow-1|resize-settled)$/.test(phase);
    if (!full && !brief) return null;
    try {
      const tree = await this.native({ cmd: "layers" });
      // The document must never scroll (a drag-time overflow strip is not interactive).
      const root = document.scrollingElement;
      const page = {
        scroll: [window.scrollX, window.scrollY],
        scrollSize: [root?.scrollWidth ?? 0, root?.scrollHeight ?? 0],
        viewport: [window.innerWidth, window.innerHeight],
        liveResize: document.documentElement.hasAttribute("data-live-resize"),
      };
      if (full) return { ...tree, page };
      const { layers: _list, ...counts } = tree;
      return { ...counts, page };
    } catch {
      return null;
    }
  }

  async waitFor(
    condition: () => boolean,
    what: string,
    timeoutMs = 20_000,
  ): Promise<void> {
    const start = performance.now();
    while (!condition()) {
      if (performance.now() - start > timeoutMs)
        throw new Error(`timed out waiting for ${what}`);
      await pause(50);
    }
  }

  /** The restore/boot flow finished and a terminal tab exists. */
  async booted(): Promise<{ tabId: number; leafId: number }> {
    await this.waitFor(
      () =>
        this.app().booted && this.app().tabs.some((t) => t.kind === "terminal"),
      "app boot",
      60_000,
    );
    const tab = this.app().tabs.find((t) => t.kind === "terminal");
    if (tab?.kind !== "terminal") throw new Error("no terminal tab after boot");
    if (this.scenario.prefs?.windowVibrancy !== undefined) {
      await setWindowVibrancy(this.scenario.prefs.windowVibrancy);
      await pause(1500);
    }
    await this.frontWindow();
    await this.sessionReady(tab.activeLeafId);
    return { tabId: tab.id, leafId: tab.activeLeafId };
  }

  async sessionReady(leafId: number): Promise<void> {
    // Waits for the session to exist and its shell to start; throws on timeout.
    await whenSessionReady(leafId, 30_000);
  }

  /** Types the agent command into a real shell and waits until it is drawing. */
  async startAgent(leafId: number, extraArgs = ""): Promise<void> {
    await this.sessionReady(leafId);
    const command = `${this.scenario.agentCommand} ${extraArgs}`.trim();
    if (!writeToSession(leafId, `${command}\r`))
      throw new Error(`terminal ${leafId} refused the agent command`);
    await this.waitFor(
      () => (this.app().readBuffer(leafId, 60) ?? "").includes("Thinking"),
      `agent output in terminal ${leafId}`,
    );
  }

  async newAgentTab(
    title: string,
    extraArgs = "",
  ): Promise<{ tabId: number; leafId: number }> {
    const { tabId, leafIds } = this.app().newAgentGroupTab(
      this.scenario.cwds?.agent,
      title,
      1,
    );
    await this.waitFor(
      () => this.app().tabs.some((t) => t.id === tabId),
      "new tab",
    );
    await this.startAgent(leafIds[0], extraArgs);
    return { tabId, leafId: leafIds[0] };
  }

  async newShellTab(
    blocks = false,
  ): Promise<{ tabId: number; leafId: number }> {
    const cwd = this.scenario.cwds?.shell;
    const tabId = blocks ? this.app().newBlockTab(cwd) : this.app().newTab(cwd);
    await this.waitFor(
      () => this.app().tabs.some((t) => t.id === tabId),
      "new tab",
    );
    const tab = this.app().tabs.find((t) => t.id === tabId);
    if (tab?.kind !== "terminal") throw new Error("new tab is not a terminal");
    await this.sessionReady(tab.activeLeafId);
    return { tabId, leafId: tab.activeLeafId };
  }

  select(tabId: number): void {
    this.app().setActiveId(tabId);
  }

  /** Switches to a Space and returns the active tab id there, warming a cold tab. */
  async switchSpace(spaceId: string): Promise<number> {
    this.app().setActiveSpace(spaceId);
    await this.waitFor(
      () => this.app().activeSpaceId === spaceId,
      `Space ${spaceId}`,
      10_000,
    );
    const active = this.app().tabs.find(
      (tab) => tab.id === this.app().activeId,
    );
    if (active?.spaceId !== spaceId) {
      const tabs = this.app().tabs.filter((tab) => tab.spaceId === spaceId);
      if (tabs.length === 0) throw new Error(`Space ${spaceId} has no tab`);
      this.app().setActiveId(tabs[tabs.length - 1].id);
      await this.waitFor(() => {
        const tab = this.app().tabs.find(
          (tab) => tab.id === this.app().activeId,
        );
        return tab?.spaceId === spaceId;
      }, `an active tab in Space ${spaceId}`);
    }
    return this.app().activeId;
  }

  async native(
    action: Record<string, unknown>,
  ): Promise<Result & Record<string, unknown>> {
    return nativeWindow<Result & Record<string, unknown>>(action);
  }

  /** Brings the window to the front at the scenario's size and waits until it is key and active. */
  async frontWindow(): Promise<void> {
    const size = this.scenario.window;
    if (size)
      await this.native({
        cmd: "setSize",
        width: size.width,
        height: size.height,
      });
    const front = await this.native({ cmd: "activate" });
    if (!front.ok)
      throw new Error("benchmark window could not become key and active");
  }

  /**
   * Another application (or the user) may take activation between samples; a sample is only
   * valid evidence with the window key and the app active, so ask for it back first.
   */
  async ensureFront(): Promise<void> {
    const state = await this.native({ cmd: "snapshot" });
    if (state.appActive && state.key && state.occlusionVisible) return;
    this.refronted += 1;
    await this.native({ cmd: "activate" });
    await pause(300);
  }

  refronted = 0;

  /**
   * With `scenario.gc`, asks WebKit for a full garbage collection (WKProcessPool testing SPI) and
   * samples again: what is still held afterwards is not JavaScript garbage.
   */
  async collectGarbage(): Promise<void> {
    const mode = this.scenario.gc;
    if (!mode) return;
    const gc =
      mode === "alloc"
        ? await allocateGarbage()
        : await this.native({ cmd: "gc" });
    await pause(2000);
    await this.sync("post-gc+2s", { gc });
    await pause(8000);
    await this.sync("post-gc+10s");
  }

  /**
   * Mitigation probe: every `everyS` seconds the page allocates and drops `chunks` zero-filled
   * ArrayBuffers of `chunkMb` MiB (never touched, so not resident) to push JavaScriptCore into a
   * full collection, which releases the native objects pinned by dead WebGPU wrappers. Not a
   * product feature; it shows whether an in-app valve could replace the testing SPI.
   */
  startValve(): void {
    const valve = this.scenario.valve;
    if (!valve) return;
    const run = async () => {
      for (let index = 0; index < valve.chunks; index++) {
        const buffer = new Uint8Array(valve.chunkMb * 1024 * 1024);
        buffer[0] = index;
        await macrotask();
      }
    };
    setInterval(() => void run(), valve.everyS * 1000);
  }

  /**
   * Samples `tick-N` every `tickS` seconds for `durationS` (against the clock, so the time a
   * sample takes does not stretch the schedule); without ticks just waits.
   */
  async ticks(durationS: number, tickS: number | undefined): Promise<void> {
    const start = performance.now();
    if (!tickS || tickS <= 0) {
      await pause(durationS * 1000);
      return;
    }
    for (let n = 1; n * tickS < durationS; n++) {
      await pause(Math.max(0, start + n * tickS * 1000 - performance.now()));
      await this.sync(`tick-${n}`, { elapsedMs: performance.now() - start });
    }
    await pause(Math.max(0, start + durationS * 1000 - performance.now()));
  }

  /** Idle settle samples shared by the cycling scenarios. */
  async settle(): Promise<void> {
    await pause(10_000);
    await this.sync("end+10s");
    await pause(20_000);
    await this.sync("end+30s");
    await this.collectGarbage();
  }
}

/**
 * Tab layout as a string, one letter per tab: s = idle shell, b = idle shell in command-block mode
 * (its pane is shorter: the command bar takes the bottom), a = agent, p = a tab split into two
 * agent panes. "sa" (alias "2"): shell + agent; "saps" (alias "4"): shell, agent, split pair, shell.
 */
function tabKinds(variant: string | undefined): string {
  if (!variant || variant === "2") return "sa";
  if (variant === "4") return "saps";
  if (!/^[sbap]+$/.test(variant))
    throw new Error(`unknown tabs variant ${variant}`);
  return variant;
}

async function tabsScenario(run: ScenarioRun): Promise<void> {
  const { scenario } = run;
  const kinds = tabKinds(scenario.variant);
  const cycles = scenario.cycles ?? 40;
  const dwellMs = scenario.dwellMs ?? 3000;
  const first = await run.booted();
  run.startValve();
  const order = [first.tabId];
  const leaves: number[][] = [[first.leafId]];
  if (kinds[0] === "a" || kinds[0] === "p") await run.startAgent(first.leafId);
  for (let index = 1; index < kinds.length; index++) {
    const kind = kinds[index];
    if (kind === "s" || kind === "b") {
      const tab = await run.newShellTab(kind === "b");
      order.push(tab.tabId);
      leaves.push([tab.leafId]);
    } else {
      const tab = await run.newAgentTab(
        kind === "p" ? "agent pair" : "agent",
        `--seed ${index + 1}`,
      );
      const group = [tab.leafId];
      if (kind === "p") {
        run.select(tab.tabId);
        await pause(500);
        const second = run.app().splitActivePane(tab.tabId, "row");
        if (second === null) throw new Error("split refused");
        await run.startAgent(second, `--seed ${index + 11}`);
        group.push(second);
      }
      order.push(tab.tabId);
      leaves.push(group);
    }
  }
  // The tab shown at baseline (and for the whole run with `noSwitch`): index into the tab order.
  const home = order[scenario.holdTab ?? 0] ?? first.tabId;
  run.select(home);
  await pause(5000);
  await run.sync("setup", { variant: kinds, cycles, dwellMs, order, leaves });
  await pause(2000);
  await run.sync("baseline", { cycle: 0, tab: home });
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const target = order[((scenario.holdTab ?? 0) + cycle) % order.length];
    const switchedAt = Date.now();
    // Control run (`noSwitch`): identical timing, samples and workload but the tab never changes.
    if (!scenario.noSwitch) run.select(target);
    await pause(dwellMs);
    await run.sync(`switch-${cycle}`, {
      cycle,
      step: "visible",
      tab: target,
      switchedAt,
    });
  }
  await run.sync("cycles-complete");
  await run.settle();
}

/**
 * Records the smoothness of one gesture: starts the probe, runs it, lets the last frames land and
 * returns the summary.
 */
async function smoothly<T>(
  gesture: () => Promise<T>,
): Promise<{ result: T; smooth: SmoothSummary }> {
  const probe = installSmoothProbe();
  probe.start();
  const result = await gesture();
  // The final size lands when the gesture is over: wait for every grid to have it.
  const ended = performance.now();
  let settleMs = 0;
  while (probe.pending() > 0) {
    await pause(4);
    settleMs = performance.now() - ended;
    if (settleMs > 1500) {
      settleMs = -1;
      break;
    }
  }
  await pause(200);
  return { result, smooth: probe.stop(Math.round(settleMs)) };
}

type SplitLayout = {
  tabId: number;
  leaves: number[];
  dir: "row" | "col";
  /** Marker every prompt of the shell pane starts with (to count copies of it in scrollback). */
  promptMarker: string;
};

/**
 * Shell pane (10k lines of scrollback, then its prompt) next to an agent (`a`) or another shell
 * (`s`). Variants: `sa` zsh (the app's shell integration, OSC 133) + agent, `ba` bash without
 * any integration + agent, `ss` two zsh; `-col` stacks the panes instead of putting them side by
 * side. A shell at its prompt is what a resize erases and redraws.
 */
async function splitLayout(
  run: ScenarioRun,
  variant: string | undefined,
): Promise<SplitLayout> {
  const name = variant ?? "sa";
  const kinds = name.replace("-col", "");
  const dir = name.endsWith("-col") ? "col" : "row";
  const first = await run.booted();
  const promptMarker = kinds[0] === "b" ? "BPR> " : "ZPR> ";
  const fill = async (leafId: number, bash: boolean) => {
    // No shell integration for bash: it keeps its own prompt and Ghostty never erases it.
    if (bash) {
      writeToSession(leafId, "exec bash --noprofile --norc\r");
      await pause(1500);
    }
    writeToSession(leafId, "seq 1 10000\r");
    await run.waitFor(
      () => (run.app().readBuffer(leafId, 40) ?? "").includes("10000"),
      `scrollback in terminal ${leafId}`,
    );
    await pause(500);
    // The marked prompt comes after the bulk output so none of its lines scroll away.
    writeToSession(leafId, bash ? "PS1='BPR> '\r" : "PROMPT='ZPR> '\r");
    await pause(500);
    writeToSession(leafId, "echo ready\r");
    await pause(500);
    writeToSession(leafId, "echo ready again\r");
    await pause(800);
  };
  await fill(first.leafId, kinds[0] === "b");
  const second = run.app().splitActivePane(first.tabId, dir);
  if (second === null) throw new Error("split refused");
  await pause(800);
  await run.sessionReady(second);
  if (kinds[1] === "s") await fill(second, false);
  else await run.startAgent(second, "--history 3000");
  await pause(2000);
  return {
    tabId: first.tabId,
    leaves: [first.leafId, second],
    dir,
    promptMarker,
  };
}

/** Copies of the shell prompt and of the agent's live region in the scrollback of both panes. */
function duplicates(run: ScenarioRun, layout: SplitLayout) {
  const count = (leafId: number, needle: string) =>
    (run.app().readBuffer(leafId, 100_000) ?? "")
      .split("\n")
      .filter((line) => line.includes(needle)).length;
  const [shell, other] = layout.leaves;
  return {
    prompts: count(shell, layout.promptMarker),
    // The agent's region exists once; a second copy is left over from a repaint that missed.
    agentRegions: count(other, "esc to interrupt"),
    agentInputBoxes: count(other, 'Try "fix the failing test"'),
  };
}

async function resizeScenario(run: ScenarioRun): Promise<void> {
  const { scenario } = run;
  const cycles = scenario.cycles ?? 3;
  const steps = scenario.steps ?? 120;
  const stepPoints = scenario.stepPoints ?? 4;
  const intervalMs = scenario.stepIntervalMs ?? 16;
  const live = scenario.live ?? true;
  let layout: SplitLayout | null = null;
  if (scenario.variant) {
    layout = await splitLayout(run, scenario.variant);
  } else {
    const first = await run.booted();
    await run.startAgent(first.leafId, "--history 3000");
  }
  await pause(3000);
  await run.sync("setup", {
    cycles,
    steps,
    stepPoints,
    intervalMs,
    live,
    leaves: layout?.leaves,
  });
  await pause(2000);
  await run.sync("baseline", {
    cycle: 0,
    dupes: layout ? duplicates(run, layout) : undefined,
  });
  const drag = async (cycle: number, step: "shrink" | "grow") => {
    const sign = step === "shrink" ? -1 : 1;
    const { result, smooth } = await smoothly(() =>
      run.native({
        cmd: "resizeSteps",
        dw: sign * stepPoints,
        dh: (sign * stepPoints) / 2,
        count: steps,
        intervalMs,
        live,
        layersMid: cycle === 1 && step === "shrink",
      }),
    );
    await run.sync(`${step}-${cycle}`, { cycle, step, resize: result, smooth });
  };
  for (let cycle = 1; cycle <= cycles; cycle++) {
    // Growing first takes the window past the size the canvas was allocated for.
    const order = scenario.growFirst
      ? (["grow", "shrink"] as const)
      : (["shrink", "grow"] as const);
    for (const step of order) await drag(cycle, step);
  }
  await pause(1500);
  await run.sync("resize-settled", {
    dupes: layout ? duplicates(run, layout) : undefined,
  });
  await run.settle();
}

/**
 * Drives a divider with DOM pointer events at `hz` samples a second along `position`. WebKit
 * reports `buttons` from the physical mouse, so a synthetic NSEvent drag looks released to the
 * divider library; pointer events dispatched here go through the library's own document
 * listeners and everything after them (layout, React, observers, the renderer) is the real path.
 * A late timer skips ahead to the sample for the time it woke at, like a mouse that coalesces.
 */
async function dragWithPointer(
  handle: HTMLElement,
  position: (index: number) => { x: number; y: number },
  events: number,
  hz: number,
): Promise<{ events: number; sent: number; lateMaxMs: number; ms: number }> {
  const capture = HTMLElement.prototype.setPointerCapture;
  // The synthetic pointer is not an active pointer to WebKit; capture would throw.
  HTMLElement.prototype.setPointerCapture = () => undefined;
  const fire = (
    type: string,
    target: EventTarget,
    point: { x: number; y: number },
    buttons: number,
  ) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        clientX: point.x,
        clientY: point.y,
        button: type === "pointermove" ? -1 : 0,
        buttons,
        view: window,
      }),
    );
  try {
    const start = position(0);
    fire("pointerdown", handle, start, 1);
    const began = performance.now();
    let sent = 0;
    let lateMax = 0;
    let index = 0;
    while (index < events) {
      const due = began + ((index + 1) * 1000) / hz;
      const wait = due - performance.now();
      if (wait > 0) await pause(wait);
      const now = performance.now();
      lateMax = Math.max(lateMax, now - due);
      index = Math.min(
        events,
        Math.max(index + 1, Math.floor(((now - began) * hz) / 1000)),
      );
      fire("pointermove", document, position(index), 1);
      sent += 1;
    }
    fire("pointerup", document, position(events), 0);
    return {
      events,
      sent,
      lateMaxMs: Math.round(lateMax * 10) / 10,
      ms: Math.round(performance.now() - began),
    };
  } finally {
    HTMLElement.prototype.setPointerCapture = capture;
  }
}

/** Divider drags with real mouse events: the divider sweeps back and forth like a hand would. */
async function splitDragScenario(run: ScenarioRun): Promise<void> {
  const { scenario } = run;
  const cycles = scenario.cycles ?? 3;
  const seconds = scenario.dragS ?? 6;
  const amplitude = scenario.dragAmplitude ?? 0.2;
  const hz = scenario.mouseHz ?? 125;
  const layout = await splitLayout(run, scenario.variant ?? "sa");
  // The divider between the panes, not the sidebar's (the first handle in the document).
  const handle = () =>
    document
      .querySelector("[data-pane-leaf]")
      ?.closest('[data-slot="resizable-panel-group"]')
      ?.querySelector<HTMLElement>(':scope > [data-slot="resizable-handle"]') ??
    null;
  await run.waitFor(() => handle() !== null, "pane divider");
  await pause(1000);
  await run.sync("setup", {
    cycles,
    seconds,
    amplitude,
    hz,
    leaves: layout.leaves,
    dir: layout.dir,
  });
  await pause(2000);
  await run.sync("baseline", { cycle: 0, dupes: duplicates(run, layout) });
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const el = handle();
    if (!el) throw new Error("pane divider disappeared");
    const rect = el.getBoundingClientRect();
    const vertical = layout.dir === "col";
    const x0 = rect.left + rect.width / 2;
    const y0 = rect.top + rect.height / 2;
    const room = vertical
      ? (el.parentElement?.clientHeight ?? 600)
      : (el.parentElement?.clientWidth ?? 1000);
    const swing = room * amplitude;
    const events = Math.round(seconds * hz);
    // Alternating drift: the divider never creeps toward its limit over the cycles.
    const drift = cycle % 2 === 1 ? 0.5 : -0.5;
    const position = (index: number) => {
      // Two full sweeps per drag, easing in and out at both ends, plus a drift that leaves the
      // divider away from where it started: the gesture has a final size to apply.
      const ease = Math.min(1, index / 10, (events - index) / 10);
      const offset =
        swing * Math.sin((2 * Math.PI * index) / (hz * (seconds / 2))) * ease +
        drift * swing * (index / events);
      return vertical ? { x: x0, y: y0 + offset } : { x: x0 + offset, y: y0 };
    };
    const { result: drag, smooth } = await smoothly(() =>
      dragWithPointer(el, position, events, hz),
    );
    await run.sync(`drag-${cycle}`, {
      cycle,
      step: "drag",
      drag,
      smooth,
    });
    await pause(1000);
  }
  await pause(1500);
  await run.sync("resize-settled", { dupes: duplicates(run, layout) });
  await run.settle();
}

async function occlusionScenario(run: ScenarioRun): Promise<void> {
  const { scenario } = run;
  const cycles = scenario.cycles ?? 20;
  const hiddenMs = scenario.hiddenMs ?? 3000;
  const visibleMs = scenario.visibleMs ?? 2000;
  const first = await run.booted();
  await run.startAgent(first.leafId);
  await pause(3000);
  await run.sync("setup", { cycles, hiddenMs, visibleMs });
  await pause(2000);
  await run.sync("baseline", { cycle: 0 });
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const hide = await run.native({ cmd: "hide", mode: "orderout" });
    await run.native({ cmd: "sleep", ms: hiddenMs });
    await run.sync(`cycle-${cycle}-hidden`, { cycle, step: "hidden", hide });
    const show = await run.native({ cmd: "show", mode: "orderout" });
    await pause(visibleMs);
    await run.sync(`cycle-${cycle}-visible`, { cycle, step: "visible", show });
  }
  await run.sync("cycles-complete");
  await run.settle();
}

async function agentsSteadyScenario(run: ScenarioRun): Promise<void> {
  const { scenario } = run;
  const durationS = scenario.durationS ?? 60;
  const warmupS = scenario.warmupS ?? 5;
  const hidden = scenario.hiddenAgents ?? 6;
  const first = await run.booted();
  await run.startAgent(first.leafId);
  for (let i = 0; i < hidden; i++)
    await run.newAgentTab(`agent ${i + 2}`, `--seed ${i + 2}`);
  run.select(first.tabId);
  await pause(warmupS * 1000);
  await run.sync("setup-complete", { hiddenAgents: hidden });
  await run.sync("measure-start", { durationS });
  const start = performance.now();
  await pause(durationS * 1000);
  await run.sync("measure-end", { elapsedMs: performance.now() - start });
  await run.collectGarbage();
}

/** Idle-wakeup probes: take away one suspected source of page-driven display refreshes. */
const IDLE_PROBE_CSS: Record<string, string> = {
  selection:
    "textarea[aria-label='Terminal input']::selection { background: transparent !important; color: transparent !important; }",
  "caret-transparent":
    "textarea, input { caret-color: transparent !important; }",
  "caret-animation-manual":
    "textarea, input { caret-animation: manual !important; }",
  "zero-size":
    "textarea[aria-label='Terminal input'] { width: 0 !important; height: 0 !important; padding: 0 !important; border: 0 !important; }",
  clip: "textarea[aria-label='Terminal input'] { clip-path: inset(50%) !important; }",
  "display-contents":
    "textarea[aria-label='Terminal input'] { contain: strict !important; content-visibility: hidden !important; }",
};

function applyIdleProbe(probe: string | undefined): void {
  if (probe === "blur") (document.activeElement as HTMLElement | null)?.blur();
  if (probe === "selection") {
    const el = document.activeElement;
    if (el instanceof HTMLTextAreaElement) {
      el.value = "\u00a0";
      el.setSelectionRange(0, 1);
    }
  }
  if (probe === "selection-nofocus-div") {
    const div = document.createElement("div");
    div.tabIndex = -1;
    document.body.append(div);
    div.focus({ preventScroll: true });
  }
  if (probe === "readonly") {
    for (const input of document.querySelectorAll<HTMLTextAreaElement>(
      "textarea",
    ))
      input.readOnly = true;
  }
  const css = probe ? IDLE_PROBE_CSS[probe] : undefined;
  if (css) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
  }
}

async function idleScenario(run: ScenarioRun): Promise<void> {
  const durationS = run.scenario.durationS ?? 30;
  const warmupS = run.scenario.warmupS ?? 5;
  await run.booted();
  applyIdleProbe(run.scenario.probe);
  await pause(warmupS * 1000);
  await run.sync("setup-complete");
  await run.sync("measure-start", { durationS });
  const start = performance.now();
  await run.ticks(durationS, run.scenario.tickS);
  await run.sync("measure-end", { elapsedMs: performance.now() - start });
  await run.collectGarbage();
}

/** What a dev server prints: a line every 3 s, a burst of module transforms every 30 s. */
const DEV_SERVER =
  'i=0; while true; do i=$((i+1)); echo "[dev] $(date +%T) page reload /src/App.tsx"; if [ $((i%10)) = 0 ]; then for j in $(seq 1 30); do echo "  transform src/modules/m$j.tsx"; done; fi; sleep 3; done';

/** Clicks explorer rows (by path suffix, shortest first) to expand them; absent rows are skipped. */
async function expandExplorer(run: ScenarioRun, suffixes: string[]) {
  const expanded: string[] = [];
  for (const suffix of suffixes) {
    const find = () =>
      [
        ...document.querySelectorAll<HTMLElement>(
          `[data-fs-path$="/${suffix}"]`,
        ),
      ].sort(
        (a, b) =>
          (a.dataset.fsPath ?? "").length - (b.dataset.fsPath ?? "").length,
      )[0];
    try {
      await run.waitFor(() => find() !== undefined, suffix, 8000);
    } catch {
      continue;
    }
    find()?.click();
    expanded.push(suffix);
    await pause(400);
  }
  return expanded;
}

/**
 * The reported condition: the explorer on a workspace directory (git decorations on), a dev
 * server in the active terminal and two more shells, while `scripts/app-lab/fs-churn.mjs` (started
 * by the orchestrator after `measure-start`, stopped after `measure-end`) edits files and writes
 * builds into directories the explorer watches. Sampled every `tickS`, then a full collection.
 */
async function fsChurnScenario(run: ScenarioRun): Promise<void> {
  const { scenario } = run;
  const durationS = scenario.durationS ?? 600;
  const warmupS = scenario.warmupS ?? 5;
  const first = await run.booted();
  await run.sessionReady(first.leafId);
  if (!writeToSession(first.leafId, `${DEV_SERVER}\r`))
    throw new Error("terminal refused the dev server command");
  for (let i = 0; i < 2; i++) await run.newShellTab();
  run.select(first.tabId);
  const expanded = await expandExplorer(run, [
    "src-tauri",
    "src-tauri/src",
    "src",
    "src/modules",
    "src/modules/explorer",
  ]);
  await pause(warmupS * 1000);
  await run.sync("setup-complete", { expanded });
  await run.sync("measure-start", { durationS, churn: true });
  const start = performance.now();
  await run.ticks(durationS, scenario.tickS ?? 30);
  await run.sync("measure-end", { elapsedMs: performance.now() - start });
  await run.collectGarbage();
}

const CMD = 1 << 20;
const OPT = 1 << 19;
const CTRL = 1 << 18;
const SHIFT = 1 << 17;

type KeyStroke = {
  chars: string;
  code: number;
  flags?: number;
  ignoring?: string;
};

const INPUT_READER =
  'python3 -u -c \'import os,tty;tty.setraw(0);print("READY",end="\\r\\n");[print("RX:"+os.read(0,256).hex(),end="\\r\\n") for _ in iter(int,1)]\'';

const hex = (text: string) =>
  Array.from(new TextEncoder().encode(text), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Real WKWebView input: native key events (`sendEvent:`, through the system input context) and
 * the input method's `NSTextInputClient` calls, with a raw-mode reader in the PTY printing the
 * bytes it receives. Results go to the orchestrator's page.log as `[input-check]` lines.
 */
async function inputScenario(run: ScenarioRun): Promise<void> {
  const { leafId } = await run.booted();
  const textarea = (): HTMLTextAreaElement | null =>
    document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Terminal input']",
    );
  const armed = () => {
    const el = textarea();
    return (
      el !== null &&
      el.value === "\u00a0" &&
      el.selectionStart === 0 &&
      el.selectionEnd === 1 &&
      document.activeElement === el
    );
  };
  const results: string[] = [];
  const report = async (line: string) => {
    results.push(line);
    await run.log(`[input-check] ${line}`);
  };
  textarea()?.focus();
  writeToSession(leafId, `${INPUT_READER}\r`);
  await run.waitFor(
    () => (run.app().readBuffer(leafId, 100) ?? "").includes("READY"),
    "input reader",
  );
  let seen = 0;
  const received = () =>
    (run.app().readBuffer(leafId, 300) ?? "")
      .split("\n")
      .map((line) => /RX:([0-9a-f]+)/.exec(line)?.[1])
      .filter((value): value is string => value !== undefined);
  const key = async (stroke: KeyStroke, repeat = false) => {
    for (const up of [false, true]) {
      await run.native({
        cmd: "key",
        chars: stroke.chars,
        charsIgnoringModifiers: stroke.ignoring ?? stroke.chars,
        keyCode: stroke.code,
        flags: stroke.flags ?? 0,
        up,
        repeat: repeat && !up,
      });
      await pause(15);
    }
  };
  const text = async (op: string, value = "") => {
    await run.native({ cmd: "text", op, text: value });
  };
  const check = async (
    name: string,
    expected: string,
    action: () => Promise<void>,
  ) => {
    await action();
    await pause(400);
    const all = received();
    const got = all.slice(seen).join("");
    seen = all.length;
    const ok = got === expected;
    await report(
      `${ok ? "PASS" : "FAIL"} ${name}: got ${got || "-"} want ${expected} armed=${armed()}`,
    );
  };
  const A = { chars: "a", code: 0 };
  await key(A);
  await pause(300);
  seen = received().length;
  await report(`warm-up key delivered=${seen}`);
  await check("plain a", "61", () => key(A));
  await check("shift+z", "5a", () =>
    key({ chars: "Z", ignoring: "z", code: 6, flags: SHIFT }),
  );
  await check("return", "0d", () => key({ chars: "\r", code: 36 }));
  await check("backspace", "7f", () => key({ chars: "\u007f", code: 51 }));
  await check("tab", "09", () => key({ chars: "\t", code: 48 }));
  await check("left arrow", "1b5b44", () =>
    key({ chars: "\uf702", code: 123, flags: 1 << 23 }),
  );
  await check("ctrl+c", "03", () =>
    key({ chars: "\u0003", ignoring: "c", code: 8, flags: CTRL }),
  );
  await check("option+a (å)", "c3a5", () =>
    key({ chars: "å", ignoring: "a", code: 0, flags: OPT }),
  );
  await check("repeat x5", "6262626262", async () => {
    for (let index = 0; index < 5; index++)
      await key({ chars: "b", code: 11 }, index > 0);
  });
  // Synthetic NSEvents do not reach the keyboard layout's dead-key state, so the dead key is
  // driven the way the system delivers it: marked "´" (compositionstart), then "é" committed.
  await check("dead key option+e, e (marked + commit)", "c3a9", async () => {
    await text("setMarked", "\u00b4");
    await pause(100);
    await report(
      `dead-key mid-composition value=${JSON.stringify(textarea()?.value)}`,
    );
    await text("insert", "\u00e9");
  });
  await check("IME marked + commit", "e697a5e69cac", async () => {
    await text("setMarked", "に");
    await pause(100);
    const first = textarea()?.value;
    await text("setMarked", "にほ");
    await pause(100);
    const second = textarea()?.value;
    await report(
      `ime mid-composition values=${JSON.stringify([first, second])}`,
    );
    await text("insert", "日本");
  });
  await check("IME commit then key", "e38182" + "61", async () => {
    await text("setMarked", "あ");
    await pause(50);
    await text("insert", "あ");
    await pause(100);
    await key(A);
  });
  await check("emoji insertText", hex("😀"), () => text("insert", "😀"));
  const saved = await readTerminalClipboard();
  await writeTerminalClipboard("pasted-text");
  await check("cmd+v paste", hex("pasted-text"), () =>
    key({ chars: "v", code: 9, flags: CMD }),
  );
  await writeTerminalClipboard("SENTINEL");
  await key({ chars: "c", code: 8, flags: CMD });
  await pause(300);
  const afterCopy = await readTerminalClipboard();
  await report(
    `${afterCopy === "SENTINEL" ? "PASS" : "FAIL"} cmd+c without selection leaves clipboard: ${JSON.stringify(afterCopy)}`,
  );
  await check("cmd+a then x", "78", async () => {
    await key({ chars: "a", code: 0, flags: CMD });
    await key({ chars: "x", code: 7 });
  });
  await writeTerminalClipboard(saved);
  const first = run.app().activeId;
  await check("tab switch away and back, then a", "61", async () => {
    const second = await run.newShellTab();
    await pause(500);
    run.select(second.tabId);
    await pause(500);
    run.select(first);
    await pause(800);
    await key(A);
  });
  await check("window ordered out and back, then a", "61", async () => {
    await run.native({ cmd: "hide", mode: "orderout" });
    await pause(1500);
    await run.native({ cmd: "show", mode: "orderout" });
    await pause(1000);
    await key(A);
  });
  await report(`final armed=${armed()}`);
  await report(
    `summary ${results.filter((line) => line.startsWith("FAIL")).length} failures of ${results.filter((line) => /^(PASS|FAIL)/.test(line)).length}`,
  );
}

/** One observable step of the workflow scenario, as reported to the orchestrator. */
type WorkflowStep = { name: string; ok: boolean; detail: string };

/** Terminal panes a tab owns (a split tab has two leaves per split). */
function paneLeaves(tab: Tab): number {
  if (tab.kind !== "terminal") return 0;
  const walk = (node: unknown): number => {
    const current = node as { kind?: string; children?: unknown[] };
    if (current?.kind === "leaf") return 1;
    return (current?.children ?? []).reduce<number>(
      (sum, child) => sum + walk(child),
      0,
    );
  };
  return walk(tab.paneTree);
}

/**
 * The accepted representative workload (spec: "Measurement gates"): two Spaces, four
 * terminal panes, two busy synthetic agents, several text files and one active preview, then
 * sustained terminal streaming, hidden/show cycles and editor open/close cycles. `stress`
 * (run.py's `--scenario stress`) runs the same shape with more agents, more streaming panes and
 * larger files, so the two reports stay comparable.
 *
 * Every phase is sampled by the orchestrator (Linux: `/proc` Pss/Rss per role and a 1 Hz
 * timeline). The scenario never asserts a numeric budget: it reports what the real app did.
 */
async function resourceScenario(
  run: ScenarioRun,
): Promise<Record<string, unknown>> {
  const { scenario } = run;
  const workspace = scenario.workspace;
  if (!workspace)
    throw new Error(
      "the resource scenario needs `workspace` (scripts/app-lab/run.py creates the fixtures)",
    );
  const files = scenario.files ?? [];
  const cycles = scenario.cycles ?? 3;
  const closeCycles = scenario.closeCycles ?? 3;
  const hiddenMs = scenario.hiddenMs ?? 3000;
  const visibleMs = scenario.visibleMs ?? 2000;
  const streamSeconds = scenario.streamSeconds ?? 30;
  const agents = scenario.agents ?? 2;
  const streams = Math.min(4, scenario.streams ?? 2);
  const streamCommand = scenario.streamCommand;
  const app = () => run.app();

  const first = await run.booted();
  // Startup milestone: the first terminal tab owns a live shell. The orchestrator subtracts
  // navigation start (page clock) and the native process start to report cold start.
  await run.sync("booted", {
    workload: scenario.workload,
    tabs: app().tabs.length,
    panes: app().tabs.reduce((sum, tab) => sum + paneLeaves(tab), 0),
  });
  // Idle terminal: one live shell, nothing running, no streaming or agents yet. The orchestrator
  // derives idle CPU from the cumulative CPU counters of the booted and idle samples.
  const idleSeconds = scenario.idleSeconds ?? 5;
  await pause(idleSeconds * 1000);
  await run.sync("idle", { idleSeconds, tabs: app().tabs.length });

  const spaceA = app().activeSpaceId ?? app().tabs[0]?.spaceId;
  if (!spaceA) throw new Error("the application reports no active Space");
  const spaceB = app().createSpace("Lab B", workspace);
  const step = async (name: string, extra: Record<string, unknown> = {}) => {
    await run.sync(name, {
      spaceA,
      spaceB,
      workload: scenario.workload,
      ...extra,
    });
  };

  // Space A: the boot tab split into two panes.
  run.select(first.tabId);
  const splitA = app().splitActivePane(first.tabId, "row");
  if (splitA === null) throw new Error("Space A refused the split");
  await run.sessionReady(splitA);
  const leavesA = [first.leafId, splitA];

  // Space B: a second terminal tab, split into two panes as well (four panes in total).
  const tabB = app().newTabInSpace(spaceB, workspace);
  run.select(tabB);
  await run.waitFor(
    () => app().tabs.some((tab) => tab.id === tabB),
    "the Space B tab",
  );
  const tabBState = app().tabs.find((tab) => tab.id === tabB);
  if (tabBState?.kind !== "terminal")
    throw new Error("the Space B tab is not a terminal");
  await run.sessionReady(tabBState.activeLeafId);
  const splitB = app().splitActivePane(tabB, "row");
  if (splitB === null) throw new Error("Space B refused the split");
  await run.sessionReady(splitB);
  const leavesB = [tabBState.activeLeafId, splitB];

  // One busy synthetic agent per Space (more in the stress workload).
  const agentsBuilt: number[] = [];
  for (let index = 0; index < agents; index++) {
    const inA = index % 2 === 0;
    app().setActiveSpace(inA ? spaceA : spaceB);
    // The application applies a Space switch on its next render.
    await pause(700);
    const agent = await run.newAgentTab(
      `agent ${index + 1} ${inA ? "A" : "B"}`,
      `--seed ${20 + index}`,
    );
    agentsBuilt.push(agent.tabId);
  }

  // Several text files through the app's own planner, opened in the Space that owns them.
  const firstHalf = Math.ceil(files.length / 2);
  const editorTabs: number[] = [];
  app().setActiveSpace(spaceA);
  await pause(700);
  for (const file of files.slice(0, firstHalf)) {
    editorTabs.push(app().openFileTab(file, true));
    await pause(150);
  }
  app().setActiveSpace(spaceB);
  await pause(700);
  for (const file of files.slice(firstHalf)) {
    editorTabs.push(app().openFileTab(file, true));
    await pause(150);
  }

  // Back to Space A with the one active preview (the app's own preview pane).
  app().setActiveSpace(spaceA);
  await pause(900);
  if (!scenario.previewUrl)
    throw new Error("the resource scenario needs `previewUrl`");
  const previewTab = app().openPreview(scenario.previewUrl);
  await pause(1500);
  if (app().activeId !== previewTab)
    throw new Error("the preview tab did not become active");

  const panes = app().tabs.reduce((sum, tab) => sum + paneLeaves(tab), 0);
  const layout = {
    spaces: new Set(app().tabs.map((tab) => tab.spaceId)).size,
    knownSpaces: app().spaces.length,
    panes,
    editors: editorTabs.length,
    agents: agentsBuilt.length,
    previewTab,
  };
  await step("setup", layout);
  await pause(2000);
  await step("space-a", layout);
  app().setActiveSpace(spaceB);
  await pause(1200);
  await step("space-b", layout);
  app().setActiveSpace(spaceA);
  await pause(1200);
  await step("baseline", layout);

  await step("measure-start", layout);
  // Sustained terminal streaming in up to four panes; the fixture stops on its own.
  const streamLeaves = [leavesA[1], leavesB[0], leavesA[0], leavesB[1]].slice(
    0,
    Math.max(1, streams),
  );
  if (streamCommand) {
    for (const leafId of streamLeaves)
      writeToSession(leafId, `${streamCommand} --seconds ${streamSeconds}\r`);
  }
  await step("stream-start", { ...layout, streamLeaves });
  await pause(streamSeconds * 1000);
  await step("stream-end", { ...layout, streamSeconds });

  // Editor open/close cycles: the decoded file and its editor are released on close.
  const closeFile = scenario.closeFile ?? files[0];
  if (closeFile) {
    for (let cycle = 1; cycle <= closeCycles; cycle++) {
      const tabId = app().openFileTab(closeFile, true);
      await run.waitFor(
        () => app().activeId === tabId,
        "the close-cycle editor tab",
        15_000,
      );
      await pause(600);
      await step(`close-cycle-${cycle}-open`, {
        cycle,
        tabId,
        file: closeFile,
      });
      app().closeTab(tabId);
      await pause(800);
      await step(`close-cycle-${cycle}-closed`, { cycle, tabId });
    }
    // Leave the preview active again, like the baseline.
    if (app().tabs.some((tab) => tab.id === previewTab)) run.select(previewTab);
    else app().openPreview(scenario.previewUrl);
    await pause(600);
  }

  // Hidden/show cycles: the window is really hidden (WebKitGTK has no occlusion signal).
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const hide = await run.native({ cmd: "hide", mode: "orderout" });
    await pause(hiddenMs);
    await step(`cycle-${cycle}-hidden`, { cycle, step: "hidden", hide });
    const show = await run.native({ cmd: "show", mode: "orderout" });
    await pause(visibleMs);
    await step(`cycle-${cycle}-visible`, { cycle, step: "visible", show });
  }

  await step("measure-end", layout);
  await run.settle();
  return {
    workload: scenario.workload,
    layout,
    cycles,
    hiddenMs,
    visibleMs,
    closeCycles,
    streamSeconds,
    streamLeaves,
    agents: agentsBuilt,
    editors: editorTabs,
  };
}

/**
 * Boot-only scenario for cold/warm startup: the orchestrator relaunches it with a fresh profile
 * (cold) and then with the same profile (warm), so the reports differ only by caches.
 */
async function startupScenario(
  run: ScenarioRun,
): Promise<Record<string, unknown>> {
  const first = await run.booted();
  await run.sync("booted", { tabId: first.tabId, leafId: first.leafId });
  return { startup: true, tabId: first.tabId, leafId: first.leafId };
}

/**
 * The acceptance workflow through the real application: a shell spawns, a marker round-trips
 * exactly, a second tab opens, the active pane splits, the app switches back and a temp file
 * opens in an editor tab with its text rendered. POSIX-only shell constructs: tab-borne shells
 * are the passwd login shell (bash on Fedora), not `$SHELL`. Pass/fail lines go to page.log and
 * the summary travels in the final `done` sync.
 */
async function workflowScenario(
  run: ScenarioRun,
): Promise<Record<string, unknown>> {
  const { scenario } = run;
  const file = scenario.file;
  const firstLine = scenario.fileText;
  if (!file || !firstLine)
    throw new Error(
      "the workflow scenario needs a file and its text (scripts/app-lab/run.py creates both)",
    );
  const token = `wf-${Date.now().toString(36)}`;
  const expectedEcho = `WF-ECHO:${token}`;
  const steps: WorkflowStep[] = [];
  const check = async (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    await run.log(`[workflow] ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };
  const buffer = (leafId: number) => run.app().readBuffer(leafId, 400) ?? "";
  /** Records a failing step and returns the message (the caller throws it). */
  const failed = async (name: string, detail: string) => {
    await check(name, false, detail);
    return `workflow step failed: ${name}: ${detail}`;
  };

  const first = await run.booted();
  await run.sync("workflow-shell", { token });
  const booted = run
    .app()
    .tabs.some((tab) => tab.id === first.tabId && tab.kind === "terminal");
  await check(
    "shell spawn",
    booted,
    `tab ${first.tabId} leaf ${first.leafId} in ${run
      .app()
      .tabs.map((tab) => tab.kind)
      .join(",")}`,
  );

  // 1. The written marker, echoed back by the real shell through the real PTY.
  writeToSession(first.leafId, `printf '%s\\n' '${expectedEcho}'\r`);
  try {
    await run.waitFor(
      () =>
        buffer(first.leafId)
          .split("\n")
          .some((line) => line.trim() === expectedEcho),
      "the echoed marker",
      30_000,
    );
  } catch (error) {
    throw new Error(await failed("echo exactness", String(error)));
  }
  // The typed command line also contains the marker; only the output line equals it exactly.
  const copies = buffer(first.leafId)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line === expectedEcho).length;
  await check("echo exactness", copies === 1, `${copies} exact copies`);
  await run.sync("workflow-echo", { token, copies });

  // 2. A second terminal tab, with its own shell.
  const second = await run.newShellTab();
  await check(
    "new tab",
    second.tabId !== first.tabId &&
      run
        .app()
        .tabs.some((tab) => tab.id === second.tabId && tab.kind === "terminal"),
    `tab ${second.tabId} leaf ${second.leafId}, ${run.app().tabs.length} tabs`,
  );

  // 3. Split the first tab's active pane; the new leaf must get a live session too.
  run.select(first.tabId);
  await pause(500);
  const splitLeaf = run.app().splitActivePane(first.tabId, "row");
  if (splitLeaf === null) {
    throw new Error(
      await failed("split pane", "the application refused the split"),
    );
  }
  try {
    await run.sessionReady(splitLeaf);
  } catch (error) {
    throw new Error(
      await failed(
        "split pane",
        `no session in the new leaf: ${String(error)}`,
      ),
    );
  }
  const panes = document.querySelectorAll("[data-pane-leaf]").length;
  await check(
    "split pane",
    panes >= 2,
    `leaf ${splitLeaf}, ${panes} pane leaves`,
  );
  await run.sync("workflow-split", { token, leafId: splitLeaf, panes });

  // 4. Switch away and back: the first tab still owns the split and its scrollback.
  run.select(second.tabId);
  await pause(600);
  run.select(first.tabId);
  await pause(600);
  const returned =
    run.app().activeId === first.tabId &&
    buffer(first.leafId).includes(expectedEcho);
  await check(
    "switch back",
    returned,
    `active ${run.app().activeId}, marker ${returned ? "present" : "lost"}`,
  );

  // 5. Open the temp file through the app's own tab planner and read the editor's text.
  const fileTabId = run.app().openFileTab(file);
  const fileTab = () => run.app().tabs.find((tab) => tab.id === fileTabId);
  try {
    await run.waitFor(
      () => run.app().activeId === fileTabId && fileTab()?.kind === "editor",
      "the file tab",
      20_000,
    );
  } catch (error) {
    throw new Error(await failed("open file tab", String(error)));
  }
  const editorText = () =>
    document.querySelector(".cm-content")?.textContent ?? "";
  try {
    await run.waitFor(
      () => editorText().includes(firstLine),
      "the opened file's text",
      30_000,
    );
  } catch (error) {
    throw new Error(
      await failed(
        "opened file text",
        `${String(error)}: ${editorText().slice(0, 120)}`,
      ),
    );
  }
  const tab = fileTab();
  await check(
    "open file tab",
    tab?.kind === "editor" && tab.path === file,
    `tab ${fileTabId} kind ${tab?.kind} path ${tab?.kind === "editor" ? tab.path : "-"}`,
  );
  await check(
    "opened file text",
    editorText().includes(firstLine),
    JSON.stringify(editorText().slice(0, 120)),
  );
  await run.sync("workflow-file", { token, file, fileTabId });

  const pass = steps.every((step) => step.ok);
  await run.log(
    `[workflow] ${pass ? "PASS" : "FAIL"} summary: ${steps.filter((step) => !step.ok).length} failures of ${steps.length}`,
  );
  return { workflow: { token, pass, steps, fileTabId } };
}

/** One beat or teardown notice posted by the served preview fixture page (see run.py). */
type PreviewFixtureMessage = {
  source: "terax-preview-fixture";
  kind: "beat" | "pagehide";
  instance: string;
  href: string;
  seq: number;
  redirected: boolean;
  visibility: string;
  native: { tauri: boolean; internals: boolean; invoke: string };
  topNav: { attempted: boolean; error: string | null };
  popup: { requested: boolean; opened: boolean; error: string | null };
};

/**
 * The preview acceptance scenario: a real dev-server page in the real webview's iframe, with the
 * app's own tab/Space/window actions around it. The fixture page reports over `postMessage`, so
 * teardown is observed as the frame's page really stopping, not as an attribute change.
 *
 * The orchestrator serves the fixture and, for the `preview-blur` phase, opens a separate
 * application window so the app loses OS focus while its window stays visible.
 */
async function previewScenario(
  run: ScenarioRun,
): Promise<Record<string, unknown>> {
  const steps: WorkflowStep[] = [];
  const check = async (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    await run.log(`[preview] ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };
  const failed = async (name: string, detail: string) => {
    await check(name, false, detail);
    return `preview step failed: ${name}: ${detail}`;
  };

  const messages: PreviewFixtureMessage[] = [];
  const receive = (event: MessageEvent) => {
    const data = event.data as PreviewFixtureMessage | null;
    if (data?.source === "terax-preview-fixture") messages.push(data);
  };
  window.addEventListener("message", receive);

  const frame = () => document.querySelector('iframe[title="Preview"]');
  const beats = () => messages.filter((message) => message.kind === "beat");
  const lastBeat = () => beats()[beats().length - 1] ?? null;
  const instances = () => [...new Set(beats().map((beat) => beat.instance))];
  const waitForBeat = (
    predicate: (message: PreviewFixtureMessage) => boolean,
    what: string,
    timeoutMs = 30_000,
  ) => run.waitFor(() => beats().some(predicate), what, timeoutMs);
  const pauseBeats = async (ms: number) => {
    const before = beats().length;
    await pause(ms);
    return beats().length - before;
  };
  /** Beat-count watermark: only beats received after an action count as evidence of it. */
  const mark = () => beats().length;
  const since = (index: number) => beats().slice(index);
  const waitForNewBeat = (
    index: number,
    predicate: (message: PreviewFixtureMessage) => boolean,
    what: string,
    timeoutMs = 30_000,
  ) => run.waitFor(() => since(index).some(predicate), what, timeoutMs);
  const reloadNotice = (reason?: string) =>
    document.querySelector(
      reason
        ? `[data-preview-reloaded="${reason}"]`
        : "[data-preview-reloaded]",
    );
  /** The instances that already reported; a re-mounted frame must be one that is not here. */
  const seen = () => new Set(instances());
  const waitForFreshPage = (before: Set<string>, what: string) =>
    waitForBeat(
      (message) => message.redirected && !before.has(message.instance),
      what,
    );

  try {
    const first = await run.booted();
    const fixture = run.url("/preview-fixture?redirect=1");
    const previewId = run.app().openPreview(fixture);
    try {
      await run.waitFor(() => Boolean(frame()), "the preview frame", 40_000);
      await waitForBeat(() => true, "the fixture page's first report");
    } catch (error) {
      throw new Error(await failed("open preview", String(error)));
    }
    await check(
      "open preview",
      run.app().activeId === previewId,
      `tab ${previewId}, src ${(frame()?.getAttribute("src") ?? "").slice(0, 72)}`,
    );

    // The server answers with a redirect and the frame follows it. A redirect is navigation of
    // the frame only: the application's own document must stay where it is.
    try {
      await waitForBeat(
        (message) => message.redirected,
        "the redirected preview page",
      );
    } catch (error) {
      throw new Error(await failed("redirect inside frame", String(error)));
    }
    const appHref = location.href;
    const redirected = lastBeat();
    await check(
      "redirect inside frame",
      Boolean(
        redirected?.href.includes("/preview-redirected") &&
          !appHref.includes("/preview-redirected") &&
          location.href === appHref,
      ),
      `frame ${redirected?.href} app ${location.href}`,
    );

    // The frame is a separate, untrusted document: it has no Tauri globals even though the app
    // page does, and its sandbox refuses to move the top-level window.
    await check(
      "native access refused",
      redirected?.native.tauri === false &&
        redirected?.native.internals === false &&
        redirected?.native.invoke === "undefined" &&
        "__TAURI_INTERNALS__" in window,
      `${JSON.stringify(redirected?.native)} parentHasIpc=${"__TAURI_INTERNALS__" in window}`,
    );
    await check(
      "top navigation refused",
      redirected?.topNav.attempted === true &&
        location.href === appHref &&
        !location.href.includes("preview-escape"),
      `attempted=${redirected?.topNav.attempted} error=${redirected?.topNav.error ?? "-"} app=${location.href}`,
    );
    // The frame may ask for a popup (the sandbox grants popups on purpose), but the app installs
    // no new-window handler: no popup window must be handed to untrusted content.
    await check(
      "popup refused",
      redirected?.popup.requested === true &&
        redirected?.popup.opened === false,
      JSON.stringify(redirected?.popup ?? null),
    );

    const instance = redirected?.instance ?? "";
    await run.sync("preview-active", { instance, frames: 1 });

    // Inactive tab: the frame goes away and the page stops reporting in the same turn.
    run.select(first.tabId);
    try {
      await run.waitFor(
        () => !frame(),
        "the frame to unload on a tab switch",
        5000,
      );
    } catch (error) {
      throw new Error(await failed("tab switch unloads", String(error)));
    }
    const beatsAfterSwitch = beats().length;
    await run.sync("preview-tab-hidden", { instance });
    const afterTab = await pauseBeats(1500);
    await check(
      "tab switch unloads",
      !frame() && beats().length === beatsAfterSwitch,
      `${afterTab} beats after teardown, ${beatsAfterSwitch} before`,
    );

    // Viewing a preview never owns the independent server process.
    const ping = await fetch(run.url("/preview-ping"))
      .then((response) => response.json())
      .catch((error) => ({ error: String(error) }));
    await check(
      "dev server survives teardown",
      ping?.pong === true,
      JSON.stringify(ping),
    );

    // Returning re-mounts a fresh document and explains the reload where it happens.
    const beforeTabReturn = seen();
    run.select(previewId);
    try {
      await waitForFreshPage(beforeTabReturn, "the reloaded preview page");
      await run.waitFor(
        () => Boolean(reloadNotice("tab-inactive")),
        "the tab reload notice",
        5000,
      );
    } catch (error) {
      throw new Error(await failed("tab return reloads", String(error)));
    }
    const tabNotice = reloadNotice("tab-inactive");
    await check(
      "tab return reloads",
      Boolean(frame()) && instances().length >= 2,
      `instances ${instances().join(",")}`,
    );
    await check(
      "tab reload disclosed",
      Boolean(tabNotice) &&
        (tabNotice?.textContent ?? "").includes("Preview reloaded") &&
        (tabNotice?.textContent ?? "").toLowerCase().includes("lost"),
      JSON.stringify(tabNotice?.textContent?.slice(0, 160) ?? null),
    );
    await run.sync("preview-tab-returned", {
      instances: instances().length,
    });

    // Inactive Space: every frame of the Space that left the screen unloads. Creating the second
    // Space also activates a new terminal tab, so this cycle asserts the teardown and the reload;
    // the cause is asserted in the plain Space switch below.
    const spaceA =
      run.app().tabs.find((tab) => tab.id === previewId)?.spaceId ?? "";
    const spaceB = run.app().createSpace("Lab B", null);
    // Creating a Space does not switch to it; the frame must unload because this Space
    // becomes inactive, so the switch is part of the fixture.
    run.app().setActiveSpace(spaceB);
    try {
      await run.waitFor(
        () => !frame(),
        "the frame to unload on a Space switch",
        8000,
      );
    } catch (error) {
      throw new Error(await failed("space switch unloads", String(error)));
    }
    const beatsAfterSpace = beats().length;
    await run.sync("preview-space-hidden", { spaceA, spaceB });
    const afterSpace = await pauseBeats(1500);
    await check(
      "space switch unloads",
      !frame() && beats().length === beatsAfterSpace,
      `${afterSpace} beats after teardown, ${beatsAfterSpace} before`,
    );

    const beforeSpaceReturn = instances();
    const spaceReturnMark = mark();
    run.app().setActiveSpace(spaceA);
    try {
      await waitForNewBeat(
        spaceReturnMark,
        (message) =>
          !beforeSpaceReturn.includes(message.instance) && message.redirected,
        "a fresh preview page after returning to the Space",
      );
    } catch (error) {
      throw new Error(await failed("space return reloads", String(error)));
    }
    await check(
      "space return reloads",
      Boolean(frame()) &&
        !beforeSpaceReturn.includes(lastBeat()?.instance ?? ""),
      `before=${beforeSpaceReturn.join(",")} after=${instances().join(",")}`,
    );
    await run.sync("preview-space-returned", {
      instances: instances().length,
    });

    // A plain Space switch creates no tab: the Space alone is why the frame goes away, and the
    // notice on return must name the Space rather than a tab switch the user never made.
    const beforePlainSpace = instances();
    run.app().setActiveSpace(spaceB);
    try {
      await run.waitFor(
        () => !frame(),
        "the frame to unload when only the Space changes",
        8000,
      );
    } catch (error) {
      throw new Error(
        await failed("plain Space switch unloads", String(error)),
      );
    }
    const beatsAfterPlain = beats().length;
    await run.sync("preview-space-away", { spaceA, spaceB });
    const afterPlain = await pauseBeats(1500);
    await check(
      "plain Space switch unloads",
      !frame() && beats().length === beatsAfterPlain,
      `${afterPlain} beats after teardown, ${beatsAfterPlain} before`,
    );

    const plainReturnMark = mark();
    run.app().setActiveSpace(spaceA);
    try {
      await waitForNewBeat(
        plainReturnMark,
        (message) =>
          !beforePlainSpace.includes(message.instance) && message.redirected,
        "the preview page after returning from the plain Space switch",
      );
      await run.waitFor(
        () => Boolean(reloadNotice("space-inactive")),
        "the Space reload notice",
        10_000,
      );
    } catch (error) {
      throw new Error(await failed("space reload disclosed", String(error)));
    }
    const spaceNotice = reloadNotice("space-inactive");
    const spaceReason =
      spaceNotice?.getAttribute("data-preview-reloaded") ?? null;
    await check(
      "space reload disclosed",
      Boolean(spaceNotice) &&
        spaceReason === "space-inactive" &&
        (spaceNotice?.textContent ?? "").includes("another Space") &&
        (spaceNotice?.textContent ?? "").toLowerCase().includes("lost"),
      `reason=${spaceReason} text=${JSON.stringify(spaceNotice?.textContent?.slice(0, 140) ?? null)}`,
    );
    await run.log(
      `[preview] NOTE plain Space return notice reason=${spaceReason} (returning re-renders before the app restores the Space's active tab; the recorded cause must stay the Space)`,
    );
    await run.sync("preview-space-returned-plain", {
      instances: instances().length,
    });

    // Focus loss while the window is still visible is NOT a teardown reason. The orchestrator
    // opens another application for this phase.
    let blurExercised = false;
    const beforeBlur = lastBeat()?.instance ?? "";
    const blurMark = mark();
    await run.sync("preview-blur");
    try {
      await run.waitFor(
        () => !document.hasFocus(),
        "another window to take focus",
        8000,
      );
      blurExercised = !document.hasFocus();
    } catch {
      blurExercised = false;
    }
    if (blurExercised) {
      const beatsAtBlur = since(blurMark).length;
      await pause(1500);
      await check(
        "visible blur keeps the frame",
        Boolean(frame()) &&
          (lastBeat()?.instance ?? "") === beforeBlur &&
          document.visibilityState === "visible" &&
          since(blurMark).length > beatsAtBlur,
        `frame=${Boolean(frame())} hasFocus=${document.hasFocus()} visibility=${document.visibilityState} before=${beforeBlur} last=${lastBeat()?.instance ?? "-"} newBeats=${since(blurMark).length - beatsAtBlur}`,
      );
    } else {
      await run.log(
        "[preview] SKIP visible blur: no other window could take focus on this desktop",
      );
    }

    // A supported hidden signal (the window is unmapped) unloads immediately, and restoring
    // re-mounts. This is the hidden/minimized path the Linux session can actually report.
    const hide = await run.native({ cmd: "hide", mode: "orderout" });
    try {
      await run.waitFor(
        () => !frame(),
        "the frame to unload while the window is hidden",
        8000,
      );
    } catch (error) {
      throw new Error(await failed("hidden window unloads", String(error)));
    }
    const hidden = {
      hide,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      snapshot: await run.native({ cmd: "snapshot" }),
    };
    await run.sync("preview-window-hidden", { hide: hidden });
    await check(
      "hidden window unloads",
      hide.ok === true &&
        !frame() &&
        hidden.visibility !== "visible" &&
        hidden.snapshot.windowVisible === false,
      JSON.stringify({
        visibility: hidden.visibility,
        windowVisible: hidden.snapshot.windowVisible,
      }),
    );

    const beforeRestore = lastBeat()?.instance ?? "";
    const restoreMark = mark();
    const show = await run.native({ cmd: "show", mode: "orderout" });
    try {
      await waitForNewBeat(
        restoreMark,
        (message) => message.instance !== beforeRestore && message.redirected,
        "the preview page after the window is shown",
      );
    } catch (error) {
      throw new Error(await failed("show reloads", String(error)));
    }
    await run.sync("preview-window-restored", { show });
    await check(
      "show reloads",
      Boolean(frame()) && show.ok === true,
      `instances ${instances().join(",")}`,
    );

    // Minimize: whatever signal this desktop reports is what the lifecycle must follow. On
    // Wayland the compositor does not report iconification to the client, so this records the
    // observed case instead of assuming a minimize is visible to the application.
    const minimize = await run.native({ cmd: "hide", mode: "miniaturize" });
    await pause(2000);
    const minimized = {
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      frameLoaded: Boolean(frame()),
      snapshot: await run.native({ cmd: "snapshot" }),
    };
    const signalReported = minimized.visibility !== "visible";
    await run.sync("preview-minimized", { minimize, minimized });
    await check(
      "minimize follows the reported signal",
      minimized.frameLoaded !== signalReported,
      `reportedHidden=${signalReported} visibility=${minimized.visibility} frameLoaded=${minimized.frameLoaded} miniaturized=${minimized.snapshot.miniaturized}`,
    );
    await run.log(
      `[preview] SIGNAL minimize reported=${signalReported} (Wayland compositors do not report iconification; occlusion is not available on Linux either)`,
    );
    const restored = await run.native({ cmd: "show", mode: "miniaturize" });
    try {
      await run.waitFor(
        () => Boolean(frame()),
        "the preview frame after restore",
        10_000,
      );
    } catch (error) {
      throw new Error(await failed("minimize restore reloads", String(error)));
    }
    await check(
      "minimize restore reloads",
      Boolean(frame()),
      `instances ${instances().join(",")}`,
    );
    await run.sync("preview-minimize-restored", { restored });

    // Closing the tab also releases the frame, and the dev server outlives it again.
    const instancesBeforeClose = instances().length;
    run.app().closeTab(previewId);
    try {
      await run.waitFor(
        () => !frame() && !run.app().tabs.some((tab) => tab.id === previewId),
        "the closed preview tab",
        8000,
      );
    } catch (error) {
      throw new Error(await failed("close releases the frame", String(error)));
    }
    const pingAfterClose = await fetch(run.url("/preview-ping"))
      .then((response) => response.json())
      .catch((error) => ({ error: String(error) }));
    await check(
      "close releases the frame and keeps the server",
      !frame() && pingAfterClose?.pong === true,
      `instances before close ${instancesBeforeClose}, ping ${JSON.stringify(pingAfterClose)}`,
    );
    await run.sync("preview-closed", { instances: instances().length });

    // PDF documents go through the same preview surface (the editor pane's media iframe and the
    // app's asset grant), but WebKitGTK hands them to its own viewer document. See
    // `pdfDocuments` for what is asserted and what is left to the named manual checks.
    const pdf = await pdfDocuments(run, check, failed);

    const pass = steps.every((step) => step.ok);
    await run.log(
      `[preview] ${pass ? "PASS" : "FAIL"} summary: ${steps.filter((step) => !step.ok).length} failures of ${steps.length}`,
    );
    return {
      workflow: { pass, steps },
      preview: {
        instances: instances().length,
        messages: messages.length,
        blurExercised,
        minimize: {
          reportedHidden: signalReported,
          visibility: minimized.visibility,
          miniaturized: minimized.snapshot.miniaturized,
        },
        pdf,
      },
    };
  } finally {
    window.removeEventListener("message", receive);
  }
}

/** One asset request/response pair the app's own server answered (see fs::bench_probe). */
type AssetEntry = {
  seq: number;
  owner: string;
  method: string;
  file: string;
  status: number | null;
  mime: string | null;
  bytes: number;
  range: string | null;
  contentRange: string | null;
  acceptRanges: boolean;
  /** The request carried the explicit `override=1` choice (above the read ceiling). */
  explicit: boolean;
  error: string | null;
};

type AssetLog = {
  activeGrants: number;
  dropped: number;
  entries: AssetEntry[];
};

/** The app's own view of its process memory (bench_window memory; Linux reads /proc). */
type MemorySummary = {
  totalPss: number;
  appPss: number;
  webContentPss: number;
  hostPss: number;
  processes: number;
};

function memorySummary(report: Record<string, unknown>): MemorySummary {
  const byRole = (report.byRole ?? {}) as Record<string, { pss?: number }>;
  const pss = (role: string) => byRole[role]?.pss ?? 0;
  return {
    totalPss: Number((report.total as { pss?: number } | undefined)?.pss ?? 0),
    appPss: Number((report.app as { pss?: number } | undefined)?.pss ?? 0),
    webContentPss: pss("web_content"),
    hostPss: pss("host"),
    processes: Number(
      (report.total as { processes?: number } | undefined)?.processes ?? 0,
    ),
  };
}

/** A grant token is a capability: never put it in a report or a log line. */
function redactGrant(url: string): string {
  return url.replace(/token=[0-9a-f]+/i, "token=<grant>");
}

/** One PDF document the phase opened, and where the app's own surface put it. */
type PdfTab = {
  key: keyof PdfFixtures["files"];
  name: string;
  path: string;
  tabId: number;
  frame: () => HTMLIFrameElement | null;
};

type OpenedPdf = PdfTab & {
  /**
   * Whether a `load` event was seen after the driver first saw the frame. Recorded, never asserted:
   * a commit that happened before this listener was attached cannot be distinguished from one that
   * never happened, so the report does not claim the event is absent.
   */
  loaded: Promise<boolean>;
};

/**
 * PDF documents in the real app (issue #30). The app opens a PDF through its own file planner: the
 * editor pane classifies the file as an asset, takes a tab-scoped media grant for it and renders
 * `AssetPreview`, whose delivery gate (`assetDeliveryDecision`) bounds the whole-file read before
 * an iframe with the app's `asset:` URL exists. WebKitGTK then hands the PDF to a document of its
 * own (the built-in PDF.js viewer at `webkit-pdfjs-viewer://`), so what this scenario asserts is:
 *
 * - the app's own gate: a PDF above the approved whole-file read ceiling is not handed to the
 *   viewer until the explicit "Load anyway" choice, and the refusal names the limit and the
 *   external-viewer alternative (the delivery contract, on the surface that owns it);
 * - the transport: the asset server answers `application/pdf` with ranges advertised, observes the
 *   explicit override, and never serves more than the file in one body — recorded natively,
 *   because the PDF document is cross-origin and the app's CSP keeps scripted reads out of
 *   `asset:`;
 * - the frame commits a document the app page cannot read (a separate origin), which is exactly
 *   why no reader function can be asserted from here;
 * - the lifecycle: the tab opens and the app keeps answering, and closing it drops the grant and
 *   the frame;
 * - the error paths: a corrupt PDF and a `.pdf`-named text file.
 *
 * Navigation, zoom, search and text selection happen *inside* that separate document. WebKitGTK
 * gives this repository no native input injection (ticket 32) and the viewer's document is
 * cross-origin, so those checks are named, recorded manual checks in
 * `docs/architecture/pdf-reader.md` rather than automated passes here.
 */
async function pdfDocuments(
  run: ScenarioRun,
  check: (name: string, ok: boolean, detail: string) => Promise<void>,
  failed: (name: string, detail: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  const facts = run.scenario.pdf;
  if (!facts) {
    throw new Error(
      await failed(
        "pdf fixtures",
        "the scenario carries no `pdf` field; scripts/app-lab/run.py provides it",
      ),
    );
  }
  const app = () => run.app();
  const assetLog = async (): Promise<AssetLog> => {
    try {
      return await invoke<AssetLog>("bench_asset_log");
    } catch (error) {
      return {
        activeGrants: -1,
        dropped: 0,
        entries: [],
        error: String(error),
      } as AssetLog;
    }
  };
  const memory = async (): Promise<MemorySummary> => {
    try {
      return memorySummary(await run.native({ cmd: "memory" }));
    } catch {
      return {
        totalPss: 0,
        appPss: 0,
        webContentPss: 0,
        hostPss: 0,
        processes: 0,
      };
    }
  };
  const mib = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;
  const notes: string[] = [];

  // The fixture geometry must map onto the approved per-page ceiling exactly as the generator
  // claims: it parsed the number out of the TypeScript owner, so this catches drift between the
  // two files before any PDF behaviour is attributed to the app.
  const decisions = {
    zoomed: (facts.renders["zoomed-a4"] ?? []).map(({ zoom, bytes }) => ({
      zoom,
      bytes,
      kind: pdfPageDecision(bytes).kind,
    })),
    large: (facts.renders["large-page"] ?? []).map(({ zoom, bytes }) => ({
      zoom,
      bytes,
      kind: pdfPageDecision(bytes).kind,
    })),
  };
  const decisionAt = (
    list: { zoom: number; kind: string }[],
    zoom: number,
    kind: string,
  ) => list.some((entry) => entry.zoom === zoom && entry.kind === kind);
  await check(
    "pdf fixtures map onto the approved page ceiling",
    facts.ceilingBytes === PDF_PAGE_LIMIT_BYTES &&
      decisionAt(decisions.zoomed, 4, "allow") &&
      decisionAt(decisions.zoomed, 8, "refuse") &&
      decisionAt(decisions.large, 0.5, "allow") &&
      decisionAt(decisions.large, 1, "refuse"),
    `generator ${mib(facts.ceilingBytes)} MiB/page, owner ${mib(PDF_PAGE_LIMIT_BYTES)} MiB/page; ` +
      `zoomed ${decisions.zoomed.map((d) => `${d.zoom}x=${d.kind}`).join(" ")}; ` +
      `large ${decisions.large.map((d) => `${d.zoom}x=${d.kind}`).join(" ")}`,
  );

  const nameOf = (key: keyof PdfFixtures["files"]) =>
    facts.files[key].split("/").pop() ?? key;
  const frameFor = (name: string) =>
    document.querySelector<HTMLIFrameElement>(`iframe[title="${name}"]`);

  /** Watches an iframe element for a `load`; a timeout is recorded, not thrown (see `OpenedPdf`). */
  const watchLoad = (element: HTMLIFrameElement): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), 30_000);
      element.addEventListener("load", () => finish(true), { once: true });
    });

  const openTab = async (key: keyof PdfFixtures["files"]): Promise<PdfTab> => {
    const path = facts.files[key];
    const name = nameOf(key);
    await run.log(`[preview] pdf: requesting a tab for ${name} (${path})`);
    const tabId = app().openFileTab(path);
    await run.waitFor(
      () =>
        app().activeId === tabId && app().tabs.some((tab) => tab.id === tabId),
      `the ${name} tab`,
      30_000,
    );
    await run.log(`[preview] pdf: tab ${tabId} for ${name} is active`);
    return { key, name, path, tabId, frame: () => frameFor(name) };
  };

  /** Waits for the app's own surface to mount the frame, then watches its load. */
  const waitFrame = async (opened: PdfTab): Promise<OpenedPdf> => {
    try {
      await run.waitFor(
        () => Boolean(opened.frame()),
        `the ${opened.name} frame`,
        30_000,
      );
    } catch (error) {
      throw new Error(await failed(`pdf ${opened.name} frame`, String(error)));
    }
    await run.log(`[preview] pdf: the ${opened.name} frame exists`);
    return {
      ...opened,
      loaded: watchLoad(opened.frame() as HTMLIFrameElement),
    };
  };

  const closeTab = async (opened: PdfTab) => {
    app().closeTab(opened.tabId);
    try {
      await run.waitFor(
        () =>
          !opened.frame() && !app().tabs.some((tab) => tab.id === opened.tabId),
        `closing ${opened.name}`,
        20_000,
      );
    } catch (error) {
      throw new Error(await failed(`pdf ${opened.name} close`, String(error)));
    }
  };

  const servedFor = (entries: AssetEntry[], name: string) =>
    entries.filter((entry) => entry.file === name);
  /** How the webview actually read the document: whole file in one body, or byte ranges. */
  const readPath = (entries: AssetEntry[], fileBytes: number) => ({
    fileBytes,
    wholeFileResponses: entries.filter(
      (entry) => entry.range === null && entry.status === 200,
    ).length,
    rangeResponses: entries.filter((entry) => entry.status === 206).length,
    refusals: entries.filter((entry) => (entry.status ?? 0) >= 400).length,
    bytesServed: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  });
  /** Waits for the app's asset server to have answered a request for this file. */
  const waitForServed = async (name: string, timeoutMs = 30_000) => {
    const startedAt = performance.now();
    for (;;) {
      const entries = servedFor((await assetLog()).entries, name);
      if (entries.length > 0) return entries;
      if (performance.now() - startedAt > timeoutMs) return entries;
      await pause(200);
    }
  };
  /**
   * What the app can and cannot see about the document it just handed to WebKit.
   *
   * `contentDocument === null` means the frame committed a document from another origin: the
   * application page cannot read its DOM, its page number, its scale or its error state. Reading
   * `contentWindow.location` is then refused as well, which is the second, independent signal.
   * Both are recorded as evidence rather than assumed.
   */
  const documentEvidence = async (opened: OpenedPdf) => {
    const entries = await waitForServed(opened.name);
    let separate = false;
    try {
      await run.waitFor(
        () => opened.frame()?.contentDocument === null,
        `the ${opened.name} document`,
        30_000,
      );
      separate = true;
    } catch {
      separate = false;
    }
    let location = "";
    try {
      const view = opened.frame() as
        | (HTMLIFrameElement & {
            contentWindow?: { location?: { href?: string } };
          })
        | null;
      location = String(view?.contentWindow?.location?.href ?? "");
    } catch (error) {
      location = `refused (${String(error).slice(0, 80)})`;
    }
    const src = opened.frame()?.getAttribute("src") ?? "";
    let scheme = "";
    try {
      scheme = new URL(src).protocol;
    } catch {
      scheme = "unparseable";
    }
    return {
      committed: separate && entries.length > 0,
      separate,
      document: location,
      scheme,
      served: entries.length,
      load: await opened.loaded,
      src: redactGrant(src),
    };
  };

  const start = await assetLog();
  await run.log(
    `[preview] pdf phase: ${Object.keys(facts.files).length} fixtures, ` +
      `grants before=${start.activeGrants}, asset log entries=${start.entries.length}`,
  );
  const baselineMemory = await memory();
  await run.log(
    `[preview] pdf phase: baseline ${mib(baselineMemory.totalPss)} MiB PSS ` +
      `(${mib(baselineMemory.webContentPss)} MiB WebContent)`,
  );
  const served: Record<string, AssetEntry[]> = {};
  const frames: Record<string, Record<string, unknown>> = {};
  const memories: Record<string, MemorySummary> = { baseline: baselineMemory };
  const closeGrant = async (name: string) => {
    const after = await assetLog();
    return {
      file: name,
      activeGrants: after.activeGrants,
      baselineGrants: start.activeGrants,
    };
  };

  // 1. The representative multi-page document: what the app does with a PDF it can preview.
  const textOpened = await openTab("text");
  const text = await waitFrame(textOpened);
  const textEvidence = await documentEvidence(text);
  const textSrc = text.frame()?.getAttribute("src") ?? "";
  await check(
    "pdf text frame uses an app asset grant",
    textSrc.includes("token=") &&
      decodeURIComponent(textSrc).includes(facts.files.text),
    `src ${redactGrant(textSrc).slice(0, 96)} scheme=${textEvidence.scheme}`,
  );
  await check(
    "pdf text frame commits a separate document",
    textEvidence.committed === true,
    `committed=${String(textEvidence.committed)} separate=${String(textEvidence.separate)} ` +
      `served=${String(textEvidence.served)} load=${String(textEvidence.load)} ` +
      `document=${textEvidence.document}`,
  );
  // Evidence, not a check: the app's CSP has no `asset:` in connect-src, so the application page
  // cannot read the document it is showing. Recorded so the report says why the checks above are
  // native observations rather than page reads.
  const scriptedRead = await fetch(textSrc)
    .then((response) => `resolved status=${response.status}`)
    .catch((error: unknown) => `refused (${String(error).slice(0, 120)})`);
  notes.push(
    `scripted fetch of the granted PDF from the app page: ${scriptedRead}`,
  );
  served.text = servedFor((await assetLog()).entries, text.name);
  memories.text = await memory();
  frames.text = textEvidence;
  await run.sync("pdf-text", {
    pdf: { file: text.name, ...textEvidence, memory: memories.text },
  });

  const textServed = served.text;
  await check(
    "pdf served as application/pdf, at most the file's bytes",
    textServed.length > 0 &&
      textServed.every(
        (entry) =>
          entry.mime === "application/pdf" &&
          (entry.status === 200 || entry.status === 206) &&
          entry.bytes > 0 &&
          entry.bytes <= facts.sizes.text &&
          entry.acceptRanges,
      ),
    textServed
      .map(
        (entry) =>
          `${entry.method} ${entry.file} ${entry.status} ${entry.mime} ${entry.bytes}B` +
          ` range=${entry.range ?? "-"} content-range=${entry.contentRange ?? "-"}`,
      )
      .join("; ") || "no request reached the app's asset server",
  );
  // The resource-contract question the decision turns on: does the webview pull the document in
  // one whole-file response, or does it ask for bounded ranges? Recorded either way.
  notes.push(
    `representative PDF (${facts.sizes.text} bytes): ${JSON.stringify(readPath(textServed, facts.sizes.text))}`,
  );

  // A hold, not a delay: with `--pdf-hold-ms` the document stays on screen so the named manual
  // reader checks can be run against this exact window. The orchestrator is waiting for the next
  // phase, so nothing else touches the app while it is held.
  const holdMs = facts.holdMs ?? 0;
  if (holdMs > 0) {
    await run.log(
      `[preview] pdf hold: keeping ${text.name} on screen for ${Math.round(holdMs / 1000)} s`,
    );
    const until = performance.now() + holdMs;
    while (performance.now() < until) await pause(1000);
    await run.log("[preview] pdf hold: finished");
  }

  // 2. A hidden PDF tab. The web preview unloads its frame the moment the tab is hidden, so the
  // same question applies to a document: does presentation pause and does the decoded content go
  // away? The app page cannot read the state of a cross-origin document, so this records what is
  // observable from the outside — the frame element, the native request log and the process
  // memory. The result is a finding for the decision, not a pass condition of the current path.
  const beforeHidden = await assetLog();
  const shellTab = app().newTab();
  try {
    await run.waitFor(
      () => app().activeId === shellTab,
      "a terminal tab in front of the PDF",
      30_000,
    );
    await pause(3000);
  } catch (error) {
    throw new Error(await failed("pdf hidden tab", String(error)));
  }
  const whileHidden = await assetLog();
  const hiddenMemory = await memory();
  const tabReturnRequests = whileHidden.entries.length;
  const hidden = {
    frame: Boolean(text.frame()),
    activeTab: app().activeId,
    pdfTab: text.tabId,
    newRequests: whileHidden.entries.length - beforeHidden.entries.length,
    memory: hiddenMemory,
  };
  await run.sync("pdf-tab-hidden", {
    pdf: { file: text.name, ...hidden, memory: hiddenMemory },
  });
  app().setActiveId(text.tabId);
  await run.waitFor(
    () => app().activeId === text.tabId,
    "the PDF tab again",
    30_000,
  );
  await pause(1500);
  const afterReturn = await assetLog();
  const returned = {
    frame: Boolean(text.frame()),
    newRequests: afterReturn.entries.length - tabReturnRequests,
    reloaded: afterReturn.entries.length > tabReturnRequests,
  };
  await run.sync("pdf-tab-returned", { pdf: { file: text.name, ...returned } });
  notes.push(
    `hidden PDF tab: frame ${hidden.frame ? "stayed mounted" : "unmounted"}, ` +
      `${hidden.newRequests} new asset request(s) while hidden, WebContent ` +
      `${mib(hiddenMemory.webContentPss)} MiB; on return ` +
      `${returned.reloaded ? "the document was reloaded" : "the same document was still loaded"}` +
      ` (${returned.newRequests} new request(s))`,
  );
  app().closeTab(shellTab);
  await run.waitFor(
    () => !app().tabs.some((tab) => tab.id === shellTab),
    "closing the terminal tab",
    20_000,
  );

  await closeTab(text);
  await run.sync("pdf-text-closed", {
    pdf: await closeGrant(text.name),
  });

  // 2. A page whose 100 % render is far above the approved per-page ceiling, at a file size the
  // delivery gate still lets through. The ceiling itself is a *reader* contract (issue #31): the
  // iframe path has no way to compute or enforce it, which is recorded rather than asserted.
  const largeOpened = await openTab("large-page");
  const large = await waitFrame(largeOpened);
  const largeEvidence = await documentEvidence(large);
  served["large-page"] = servedFor((await assetLog()).entries, large.name);
  memories.large = await memory();
  frames["large-page"] = largeEvidence;
  await check(
    "large-page PDF opens without destabilising the app",
    largeEvidence.committed === true &&
      app().tabs.some((tab) => tab.id === large.tabId) &&
      memories.large.totalPss > 0,
    `committed=${String(largeEvidence.committed)} totalPss=${mib(memories.large.totalPss)} MiB ` +
      `(baseline ${mib(baselineMemory.totalPss)} MiB), served ${
        served["large-page"]
          .map((entry) => `${entry.status} ${entry.bytes}B`)
          .join("; ") || "-"
      }`,
  );
  await run.sync("pdf-large", {
    pdf: {
      file: large.name,
      ...largeEvidence,
      memory: memories.large,
      renders: facts.renders["large-page"],
    },
  });
  await closeTab(large);

  // 3. A PDF above the approved whole-file read ceiling: the app's delivery gate answers first.
  // Nothing reaches the viewer until the explicit choice, and the refusal has to explain itself.
  const oversized = await openTab("oversized");
  const gate = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="alert"]')).find(
      (node) =>
        (node.textContent ?? "").includes(
          "Large file needs an explicit choice",
        ),
    ) ?? null;
  try {
    await run.waitFor(
      () => Boolean(gate()),
      "the oversized PDF delivery notice",
      30_000,
    );
  } catch (error) {
    throw new Error(
      await failed(
        "pdf above the read ceiling needs an explicit choice",
        String(error),
      ),
    );
  }
  const notice = gate() as HTMLElement;
  const noticeText = notice.textContent ?? "";
  const noticeButton = (label: string) =>
    Array.from(notice.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => (button.textContent ?? "").trim() === label,
    );
  const loadAnyway = noticeButton("Load anyway");
  // The refusal must name the limit it applied and offer a safe alternative, in the approved
  // numbers (never a copy declared here).
  const readCeiling = `${mib(ASSET_DELIVERY.readBytes)} MiB`;
  const overrideCeiling = `${mib(ASSET_DELIVERY.overrideBytes)} MiB`;
  await check(
    "pdf above the read ceiling needs an explicit choice",
    !oversized.frame() &&
      noticeText.includes(readCeiling) &&
      noticeText.includes(overrideCeiling) &&
      Boolean(noticeButton("Open externally")) &&
      Boolean(loadAnyway),
    `frame=${Boolean(oversized.frame())} ceiling=${readCeiling}/${overrideCeiling} ` +
      `notice=${JSON.stringify(noticeText.slice(0, 200))}`,
  );
  notes.push(
    `${oversized.name} (${facts.sizes.oversized} bytes) is above the approved whole-file read ` +
      "ceiling: the app shows the explicit-choice notice and mounts no frame until it is used.",
  );
  loadAnyway?.click();
  const oversizedFrame = await waitFrame(oversized);
  const oversizedEvidence = await documentEvidence(oversizedFrame);
  served.oversized = servedFor((await assetLog()).entries, oversized.name);
  const oversizedRead = readPath(served.oversized, facts.sizes.oversized ?? 0);
  memories.oversized = await memory();
  frames.oversized = oversizedEvidence;
  await check(
    "explicit load delivers the whole PDF in one response",
    oversizedEvidence.committed === true &&
      oversizedRead.wholeFileResponses === 1 &&
      served.oversized.some(
        (entry) =>
          entry.status === 200 &&
          entry.explicit &&
          entry.bytes === (facts.sizes.oversized ?? 0),
      ),
    `committed=${String(oversizedEvidence.committed)} read=${JSON.stringify(oversizedRead)} ` +
      `entries=${served.oversized
        .map(
          (entry) =>
            `${entry.status}${entry.explicit ? "+override" : ""} ${entry.bytes}B` +
            ` range=${entry.range ?? "-"}`,
        )
        .join("; ")}`,
  );
  notes.push(
    `${oversized.name}: ${JSON.stringify(oversizedRead)} — one whole-file response carries the ` +
      `entire ${mib(facts.sizes.oversized ?? 0)} MiB document after the explicit choice, and the ` +
      "per-page render ceiling is still not computable by this path.",
  );
  await run.sync("pdf-oversized", {
    pdf: {
      file: oversized.name,
      ...oversizedEvidence,
      readPath: oversizedRead,
      memory: memories.oversized,
    },
  });
  await closeTab(oversized);

  // 4. The error paths. The app classifies a file by its *content*, not its extension, so the two
  // error fixtures exercise different paths:
  //  - corrupt.pdf is binary, so it reaches the PDF viewer, which cannot parse it. The viewer's
  //    own error text lives inside the separate document (manual check M5); what is asserted here
  //    is that the app itself survives and the tab stays open.
  //  - not-a-pdf.pdf is valid UTF-8 text, so it opens in the text editor: a misnamed file never
  //    reaches a PDF renderer at all.
  const errors: Record<string, Record<string, unknown>> = {};

  const corruptOpened = await openTab("corrupt");
  const corrupt = await waitFrame(corruptOpened);
  const corruptEvidence = await documentEvidence(corrupt);
  served.corrupt = servedFor((await assetLog()).entries, corrupt.name);
  errors.corrupt = {
    file: corrupt.name,
    ...corruptEvidence,
    served: served.corrupt.map((entry) => ({
      status: entry.status,
      mime: entry.mime,
      bytes: entry.bytes,
      error: entry.error,
    })),
    tabs: app().tabs.length,
  };
  await run.sync("pdf-corrupt", { pdf: errors.corrupt });
  const corruptSnapshot = await run.native({ cmd: "snapshot" });
  await check(
    "corrupt pdf does not destabilise the app",
    app().tabs.some((tab) => tab.id === corrupt.tabId) &&
      corruptSnapshot.windowVisible !== false,
    `tabs=${app().tabs.length} committed=${String(corruptEvidence.committed)} ` +
      `served=${JSON.stringify(errors.corrupt.served)} visible=${String(corruptSnapshot.windowVisible)}`,
  );
  notes.push(
    `${corrupt.name}: served=${JSON.stringify(errors.corrupt.served)}; the viewer's error state ` +
      "is inside the separate PDF document and cannot be read from the app page (manual check M5)",
  );
  await closeTab(corrupt);

  const misnamed = await openTab("not-a-pdf");
  const editorText = () =>
    document.querySelector<HTMLElement>(".cm-content")?.textContent ?? "";
  try {
    await run.waitFor(
      () => editorText().includes("This file is named .pdf"),
      "the misnamed file's text",
      30_000,
    );
  } catch (error) {
    throw new Error(
      await failed("pdf-named text opens as text", String(error)),
    );
  }
  const misnamedFrame = frameFor(misnamed.name);
  errors["not-a-pdf"] = {
    file: misnamed.name,
    openedAs: "text",
    frame: Boolean(misnamedFrame),
  };
  await check(
    "a .pdf name with text content opens as text, not as a document",
    !misnamedFrame && editorText().includes("This file is named .pdf"),
    `frame=${Boolean(misnamedFrame)} text=${JSON.stringify(editorText().slice(0, 80))}`,
  );
  await run.sync("pdf-not-a-pdf", { pdf: errors["not-a-pdf"] });
  app().closeTab(misnamed.tabId);
  await run.waitFor(
    () => !app().tabs.some((tab) => tab.id === misnamed.tabId),
    "closing the misnamed .pdf tab",
    20_000,
  );

  // 5. Closing a PDF tab releases its grant: the spec's "release tab-owned resources and grants on
  // close" is observable natively, through the same probe that recorded the requests.
  const afterAll = await assetLog();
  await check(
    "pdf close releases the media grant",
    afterAll.activeGrants === start.activeGrants,
    `grants ${start.activeGrants} -> ${afterAll.activeGrants}`,
  );
  await run.sync("pdf-closed", {
    pdf: {
      activeGrants: afterAll.activeGrants,
      baselineGrants: start.activeGrants,
    },
  });

  const servedSummary: Record<string, unknown> = {};
  for (const [key, entries] of Object.entries(served)) {
    servedSummary[key] = entries.map((entry) => ({
      method: entry.method,
      status: entry.status,
      mime: entry.mime,
      bytes: entry.bytes,
      range: entry.range,
      contentRange: entry.contentRange,
      explicit: entry.explicit,
      error: entry.error,
    }));
  }
  return {
    textPages: facts.textPages,
    memoryMiB: {
      baseline: mib(baselineMemory.totalPss),
      text: mib(memories.text.totalPss),
      large: mib(memories.large.totalPss),
      oversized: mib(memories.oversized.totalPss),
      webContentBaseline: mib(baselineMemory.webContentPss),
      webContentText: mib(memories.text.webContentPss),
      webContentLarge: mib(memories.large.webContentPss),
      webContentOversized: mib(memories.oversized.webContentPss),
    },
    decisions,
    readPaths: {
      text: readPath(served.text, facts.sizes.text ?? 0),
      oversized: readPath(served.oversized, facts.sizes.oversized ?? 0),
    },
    served: servedSummary,
    frames,
    errors,
    oversized,
    notes,
  };
}

/**
 * Space lifecycle in the real application: one checkout shared by two Spaces,
 * a switch that keeps a hidden terminal's output flowing, the tab close guards,
 * and Space deletion that leaves the project directory alone.
 */
async function spacesScenario(run: ScenarioRun): Promise<unknown> {
  const { scenario } = run;
  const workspace = scenario.workspace;
  const file = scenario.file;
  const firstLine = scenario.fileText;
  if (!workspace || !file || !firstLine)
    throw new Error(
      "the spaces scenario needs a workspace, a file and its text (scripts/app-lab/run.py creates them)",
    );

  const steps: WorkflowStep[] = [];
  const check = async (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    await run.log(`[spaces] ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };
  const failed = async (name: string, detail: string) => {
    await check(name, false, detail);
    return `spaces step failed: ${name}: ${detail}`;
  };
  const pageText = () => document.body.textContent ?? "";
  const guards = () => run.app().pendingGuards();
  const buffer = (leafId: number) => run.app().readBuffer(leafId, 500) ?? "";
  const readFile = (path: string) =>
    invoke<{ kind: string; content?: string }>("fs_read_file", {
      path,
      workspace: { kind: "local" },
      force: false,
    }).then((result) => (result.kind === "text" ? (result.content ?? "") : ""));
  const statOk = (path: string) =>
    invoke("fs_stat", { path, workspace: { kind: "local" } }).then(
      () => true,
      () => false,
    );
  const editorText = () =>
    document.querySelector(".cm-content")?.textContent ?? "";

  const first = await run.booted();
  const spaceA = run.app().activeSpaceId;
  if (!spaceA) throw new Error("the application reports no active Space");

  // 1. Two Spaces on one checkout, with the shared relationship indicated.
  const spaceB = run.app().createSpace("Lab shared", workspace);
  run.app().newTabInSpace(spaceB, workspace);
  await run.switchSpace(spaceB);
  const activeB = run.app().tabs.find((tab) => tab.id === run.app().activeId);
  if (activeB?.kind !== "terminal")
    throw new Error("the second Space did not open a terminal tab");
  await run.sessionReady(activeB.activeLeafId);
  const badge = document.querySelector("[data-shared-root]");
  const badgeRoot = (badge?.getAttribute("data-shared-root") ?? "").replace(
    /\/+$/,
    "",
  );
  await check(
    "shared checkout indication",
    badge !== null && badgeRoot === workspace.replace(/\/+$/, ""),
    `badge ${badge ? badgeRoot : "missing"}; spaces ${run
      .app()
      .spaces.map((s) => s.id)
      .join(",")}`,
  );
  await run.sync("spaces-shared", { spaceA, spaceB, shared: badge !== null });

  // 2. Switching away must not stop a terminal that is no longer on screen.
  const marker = `HIDDEN-${Date.now().toString(36)}`;
  writeToSession(
    first.leafId,
    `for n in 1 2 3 4 5; do printf '%s-%s\\n' '${marker}' "$n"; sleep 0.25; done\r`,
  );
  await run.switchSpace(spaceB);
  await pause(1800);
  const hiddenTab = document.querySelector(
    `[data-terminal-tab="${first.tabId}"]`,
  ) as HTMLElement | null;
  const presentationHidden =
    hiddenTab?.getAttribute("aria-hidden") === "true" &&
    hiddenTab.style.visibility === "hidden";
  await run.switchSpace(spaceA);
  run.select(first.tabId);
  await pause(700);
  const seen = (
    buffer(first.leafId).match(new RegExp(`${marker}-[0-9]`, "g")) ?? []
  ).length;
  await check(
    "switch keeps hidden output flowing",
    seen >= 5 && presentationHidden,
    `${seen}/5 output lines; presentation hidden ${presentationHidden}`,
  );
  await run.sync("spaces-switched", {
    seen,
    presentationHidden,
    activeSpaceId: run.app().activeSpaceId,
  });

  // 3. Closing a tab with a live process asks first; cancel keeps the tab.
  await run.switchSpace(spaceB);
  const busyTab = await run.newShellTab();
  writeToSession(busyTab.leafId, "sleep 30\r");
  await pause(800);
  run.app().requestCloseTab(busyTab.tabId);
  try {
    await run.waitFor(
      () => guards().terminalTabId === busyTab.tabId,
      "the running-process close guard",
      10_000,
    );
  } catch (error) {
    throw new Error(
      await failed("tab close with a running process", String(error)),
    );
  }
  const terminalPrompt = pageText();
  await check(
    "tab close with a running process asks first",
    terminalPrompt.includes("Close Terminal?") &&
      terminalPrompt.includes("A process is running") &&
      run.app().tabs.some((tab) => tab.id === busyTab.tabId),
    `dialog: ${terminalPrompt.includes("Close Terminal?")}`,
  );
  run.app().cancelPendingClose();
  await run.waitFor(
    () => guards().terminalTabId === null,
    "the canceled guard",
  );
  await check(
    "cancel keeps the running terminal",
    run.app().tabs.some((tab) => tab.id === busyTab.tabId),
    `tabs ${run.app().tabs.length}`,
  );
  writeToSession(busyTab.leafId, "\u0003");
  await pause(300);

  // 4. A dirty buffer closes only after a complete save; cancel keeps it dirty.
  const dirtyTabId = run.app().openFileTab(file, true, spaceB);
  try {
    await run.waitFor(
      () =>
        run.app().tabs.some((tab) => tab.id === dirtyTabId) &&
        editorText().includes(firstLine),
      "the opened file",
      20_000,
    );
  } catch (error) {
    throw new Error(await failed("dirty buffer close", String(error)));
  }
  run.app().editEditor(dirtyTabId, "lab typed line\n");
  const dirty = () =>
    run.app().tabs.find((tab) => tab.id === dirtyTabId)?.kind === "editor" &&
    (run.app().tabs.find((tab) => tab.id === dirtyTabId) as { dirty: boolean })
      .dirty;
  await run.waitFor(dirty, "the dirty buffer");
  run.app().requestCloseTab(dirtyTabId);
  await run.waitFor(
    () => guards().closeTabId === dirtyTabId,
    "the unsaved-buffer close guard",
    10_000,
  );
  const dirtyPrompt = pageText();
  await check(
    "dirty buffer close offers saving",
    dirtyPrompt.includes("Unsaved Changes") &&
      dirtyPrompt.includes("Save & Close"),
    `dialog: ${dirtyPrompt.includes("Save & Close")}`,
  );
  run.app().cancelPendingClose();
  await run.waitFor(
    () => guards().closeTabId === null,
    "the canceled close guard",
  );
  await check(
    "cancel keeps the dirty buffer",
    dirty(),
    `tab ${dirtyTabId} still dirty`,
  );

  run.app().requestCloseTab(dirtyTabId);
  await run.waitFor(
    () => guards().closeTabId === dirtyTabId,
    "the unsaved-buffer close guard again",
    10_000,
  );
  run.app().saveAndCloseTab();
  try {
    await run.waitFor(
      () => !run.app().tabs.some((tab) => tab.id === dirtyTabId),
      "the saved tab to close",
      20_000,
    );
  } catch (error) {
    throw new Error(await failed("save and close", String(error)));
  }
  const savedText = await readFile(file);
  await check(
    "save and close persists before closing",
    savedText.includes("lab typed line"),
    `${savedText.length} bytes on disk`,
  );
  await run.sync("spaces-tab-close", { dirtyTabId, saved: true });

  // 5. Space deletion resolves dirty buffers and processes, then removes only
  //    saved organization; cancel leaves the work and the folder intact.
  const spaceC = run.app().createSpace("Lab delete", workspace);
  run.app().newTabInSpace(spaceC, workspace);
  await run.switchSpace(spaceC);
  const activeC = run.app().tabs.find((tab) => tab.id === run.app().activeId);
  if (activeC?.kind !== "terminal")
    throw new Error("the deletion Space did not open a terminal tab");
  await run.sessionReady(activeC.activeLeafId);
  writeToSession(activeC.activeLeafId, "sleep 30\r");
  const deletedDirtyTab = run.app().openFileTab(file, true, spaceC);
  await run.waitFor(
    () =>
      run.app().tabs.some((tab) => tab.id === deletedDirtyTab) &&
      editorText().includes("lab typed line"),
    "the file in the deletion Space",
    20_000,
  );
  run.app().editEditor(deletedDirtyTab, "deletion draft\n");
  await run.waitFor(
    () =>
      run.app().tabs.find((tab) => tab.id === deletedDirtyTab)?.kind ===
        "editor" &&
      (
        run.app().tabs.find((tab) => tab.id === deletedDirtyTab) as {
          dirty: boolean;
        }
      ).dirty,
    "the dirty buffer in the deletion Space",
  );

  run.app().requestDeleteSpace(spaceC);
  try {
    await run.waitFor(
      () => guards().spaceDeleteId === spaceC,
      "the Space deletion guard",
      10_000,
    );
  } catch (error) {
    throw new Error(await failed("Space delete guard", String(error)));
  }
  const deletePrompt = pageText();
  await check(
    "Space delete summarizes unsaved work and processes",
    deletePrompt.includes("Delete Space?") &&
      deletePrompt.includes("unsaved changes") &&
      deletePrompt.includes("may still be running") &&
      deletePrompt.includes("Files and worktrees on disk are not deleted"),
    `dialog text ${deletePrompt.includes("Delete Space?")}`,
  );
  run.app().cancelDeleteSpace();
  await run.waitFor(
    () => guards().spaceDeleteId === null,
    "the canceled Space deletion",
  );
  await check(
    "cancel keeps the Space, its tabs and its dirty buffer",
    run.app().spaces.some((space) => space.id === spaceC) &&
      run
        .app()
        .tabs.some(
          (tab) =>
            tab.spaceId === spaceC &&
            tab.id === deletedDirtyTab &&
            tab.kind === "editor" &&
            tab.dirty,
        ),
    `spaces ${run.app().spaces.length}, tabs ${run.app().tabs.length}`,
  );
  await run.sync("spaces-delete-canceled", { spaceC });

  run.app().requestDeleteSpace(spaceC);
  await run.waitFor(
    () => guards().spaceDeleteId === spaceC,
    "the Space deletion guard again",
    10_000,
  );
  run.app().saveAndDeleteSpace();
  try {
    await run.waitFor(
      () => !run.app().spaces.some((space) => space.id === spaceC),
      "the Space to be deleted",
      20_000,
    );
  } catch (error) {
    throw new Error(await failed("save and delete Space", String(error)));
  }
  await check(
    "deleting the Space removes saved organization only",
    !run.app().tabs.some((tab) => tab.spaceId === spaceC) &&
      (await statOk(workspace)) &&
      run.app().spaces.some((space) => space.id === spaceA),
    `project folder ${(await statOk(workspace)) ? "present" : "MISSING"}`,
  );
  await run.sync("spaces-deleted", {
    projectDirExists: await statOk(workspace),
    remainingSpaces: run.app().spaces.length,
  });

  const pass = steps.every((step) => step.ok);
  await run.log(
    `[spaces] ${pass ? "PASS" : "FAIL"} summary: ${steps.filter((step) => !step.ok).length} failures of ${steps.length}`,
  );
  return {
    workflow: {
      pass,
      steps,
      spaceA,
      spaceB,
      shared: badge !== null,
      hiddenOutputLines: seen,
      presentationHidden,
      projectDirExists: await statOk(workspace),
    },
  };
}

/**
 * The image acceptance scenario through the real application: representative
 * formats are opened through the app's own file-tab planner, and the rendered
 * element's decoded size is asserted (not the extension). Oversized, corrupt
 * and hidden-tab states are observed through the surface the app really shows,
 * and closing the tab is asserted to release both the decoded-viewer slot and
 * the tab-owned asset grant scope.
 */
async function imagesScenario(
  run: ScenarioRun,
): Promise<Record<string, unknown>> {
  const { scenario } = run;
  const fixtures = scenario.images;
  if (!fixtures)
    throw new Error(
      "the images scenario needs fixture paths (scripts/app-lab/run.py creates them)",
    );
  const steps: WorkflowStep[] = [];
  const formats: Record<string, unknown> = {};
  const check = async (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    await run.log(`[images] ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };
  const failed = async (name: string, detail: string) => {
    await check(name, false, detail);
    return `images step failed: ${name}: ${detail}`;
  };

  /** The visible image surface, skipping the aria-hidden wrapper of an inactive tab. */
  const surface = () =>
    [...document.querySelectorAll<HTMLElement>("[data-image-viewer]")].find(
      (element) => !element.closest('[aria-hidden="true"]'),
    ) ?? null;
  const surfaceState = () => surface()?.dataset.imageState ?? null;
  const image = () =>
    surface()?.querySelector<HTMLImageElement>("img[data-image-preview]") ??
    null;
  const viewers = () => useViewerAdmissionStore.getState().viewers;
  const waitForState = (state: string, what: string, timeoutMs = 30_000) =>
    run.waitFor(() => surfaceState() === state, what, timeoutMs);
  const waitForDecoded = (what: string) =>
    run.waitFor(
      () => {
        const element = image();
        return Boolean(element?.complete && (element?.naturalWidth ?? 0) > 0);
      },
      what,
      30_000,
    );

  try {
    const first = await run.booted();
    const open = async (path: string) => {
      const tabId = run.app().openFileTab(path);
      run.select(tabId);
      return tabId;
    };

    for (const name of [
      "png",
      "jpeg",
      "gif",
      "webp",
      "bmp",
      "ico",
      "avif",
    ] as const) {
      const tabId = await open(fixtures[name]);
      try {
        await waitForState("ready", `the ${name} image surface`);
        await waitForDecoded(`the decoded ${name} raster`);
      } catch (error) {
        throw new Error(await failed(`${name} renders`, String(error)));
      }
      const element = image();
      await check(
        `${name} renders`,
        element?.naturalWidth === 64 &&
          element?.naturalHeight === 64 &&
          element?.dataset.imageFormat === name,
        `${element?.naturalWidth}x${element?.naturalHeight} format=${element?.dataset.imageFormat} state=${surfaceState()}`,
      );
      formats[name] = {
        width: element?.naturalWidth ?? 0,
        height: element?.naturalHeight ?? 0,
      };
      await run.sync(`images-${name}`, {
        width: element?.naturalWidth ?? 0,
        height: element?.naturalHeight ?? 0,
      });
      run.app().closeTab(tabId);
      await run.waitFor(
        () =>
          viewers().every((viewer) => !viewer.id.startsWith(`image:${tabId}:`)),
        `the ${name} viewer slot to be released`,
        8000,
      );
    }

    // SVG is not routed to the image surface: an explicitly opened .svg stays
    // an editable text tab, even though the webview decodes inline SVG.
    {
      const tabId = await open(fixtures.svg);
      try {
        await run.waitFor(
          () =>
            (document.querySelector(".cm-content")?.textContent ?? "").includes(
              "<svg",
            ),
          "the SVG source in the editor",
          30_000,
        );
      } catch (error) {
        throw new Error(await failed("svg stays text", String(error)));
      }
      const tab = run.app().tabs.find((entry) => entry.id === tabId);
      await check(
        "svg stays an editable text tab",
        tab?.kind === "editor" &&
          !document.querySelector("[data-image-viewer]"),
        `tab ${tabId} kind ${tab?.kind}`,
      );
      run.app().closeTab(tabId);
      await run.waitFor(
        () => !run.app().tabs.some((entry) => entry.id === tabId),
        "the SVG tab to close",
        8000,
      );
    }

    // A recognized header above the 64 MiB decoded ceiling is refused from the
    // header dimensions, before the element is ever mounted.
    {
      const tabId = await open(fixtures.oversized);
      try {
        await waitForState("oversized", "the oversized refusal");
      } catch (error) {
        throw new Error(await failed("oversized refused", String(error)));
      }
      const text = surface()?.textContent ?? "";
      await check(
        "oversized refused before decode",
        !image() && text.includes("64 MiB") && text.includes("Open externally"),
        `${surfaceState()}: ${text.slice(0, 160)}`,
      );
      await check(
        "oversized holds no decoded slot",
        viewers().length === 0,
        `${viewers().length} admitted viewers`,
      );
      run.app().closeTab(tabId);
      await run.waitFor(
        () => !run.app().tabs.some((tab) => tab.id === tabId),
        "the oversized tab to close",
        8000,
      );
    }

    // Corrupt input must produce an informative state, never a blank pane or a crash.
    {
      const tabId = await open(fixtures.corrupt);
      try {
        await waitForState("corrupt", "the corrupt-image notice");
      } catch (error) {
        throw new Error(await failed("corrupt reports", String(error)));
      }
      const text = surface()?.textContent ?? "";
      await check(
        "corrupt reports an honest state",
        !image() &&
          text.includes("could not be decoded") &&
          text.includes("Retry") &&
          text.includes("Open externally"),
        `${surfaceState()}: ${text.slice(0, 160)}`,
      );
      run.app().closeTab(tabId);
      await run.waitFor(
        () => !run.app().tabs.some((tab) => tab.id === tabId),
        "the corrupt tab to close",
        8000,
      );
    }

    // A hidden tab stops presenting: the decoded element and its slot go away,
    // and returning remounts it.
    {
      const tabId = await open(fixtures.png);
      try {
        await waitForState("ready", "the PNG surface");
        await waitForDecoded("the decoded PNG raster");
      } catch (error) {
        throw new Error(await failed("hidden-tab setup", String(error)));
      }
      run.select(first.tabId);
      try {
        await run.waitFor(
          () =>
            Boolean(
              document.querySelector(
                '[data-image-viewer][data-image-state="hidden"]',
              ),
            ) && !document.querySelector("img[data-image-preview]"),
          "the hidden tab to stop presenting the image",
          8000,
        );
      } catch (error) {
        throw new Error(await failed("hidden tab stops decode", String(error)));
      }
      await check(
        "hidden tab releases the raster",
        viewers().length === 0 &&
          !document.querySelector("img[data-image-preview]"),
        `${viewers().length} admitted viewers`,
      );
      run.select(tabId);
      try {
        await waitForDecoded("the raster to return with the tab");
      } catch (error) {
        throw new Error(await failed("visible tab returns", String(error)));
      }
      await check(
        "visible tab returns",
        Boolean(image()) && viewers().length === 1,
        `${viewers().length} admitted viewers`,
      );
      run.app().closeTab(tabId);
    }

    // Repeated open/close cycles must not retain decoded data or grants.
    let released = true;
    let detail = "";
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const tabId = await open(fixtures.png);
      try {
        await waitForDecoded(`cycle ${cycle + 1}'s raster`);
      } catch (error) {
        throw new Error(
          await failed(`cycle ${cycle + 1} opens`, String(error)),
        );
      }
      run.app().closeTab(tabId);
      try {
        await run.waitFor(
          () =>
            !run.app().tabs.some((tab) => tab.id === tabId) &&
            viewers().length === 0 &&
            assetScopes.size === 0,
          `cycle ${cycle + 1} to release raster and grants`,
          10_000,
        );
      } catch (error) {
        released = false;
        detail = String(error);
      }
      if (!released) break;
      detail = `cycle ${cycle + 1}: ${viewers().length} viewers, ${assetScopes.size} grant scopes`;
    }
    await check(
      "open/close cycles release rasters and grants",
      released && viewers().length === 0 && assetScopes.size === 0 && !image(),
      detail,
    );

    const pass = steps.every((step) => step.ok);
    await run.log(
      `[images] ${pass ? "PASS" : "FAIL"} summary: ${steps.filter((step) => !step.ok).length} failures of ${steps.length}`,
    );
    return {
      images: {
        pass,
        steps,
        formats,
        retainedViewers: viewers().length,
        retainedGrantScopes: assetScopes.size,
      },
    };
  } catch (error) {
    return {
      images: {
        pass: false,
        steps: [
          ...steps,
          { name: "scenario completed", ok: false, detail: String(error) },
        ],
        formats,
      },
    };
  }
}

/**
 * Destructive Git across Spaces, through the panel's own guard.
 *
 * A dirty buffer in one Space must block a discard requested from the panel;
 * an unacknowledged confirmation and a plan whose Git state changed after the
 * dialog opened are both refused, and every refusal is observed to leave the
 * file and the index unchanged. The successful discard at the end is the
 * control: the same path still mutates when it is deliberately confirmed.
 */
async function gitScenario(run: ScenarioRun): Promise<unknown> {
  const fixture = run.scenario.git;
  if (!fixture)
    throw new Error(
      "the git scenario needs a scratch repository (scripts/app-lab/run.py creates it)",
    );
  const steps: WorkflowStep[] = [];
  const check = async (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    await run.log(`[git] ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };
  const failed = async (name: string, detail: string) => {
    await check(name, false, detail);
    return `git step failed: ${name}: ${detail}`;
  };
  const app = () => run.app();
  const pending = () => app().destructiveGit().pending;
  const gitStatus = () =>
    invoke<{
      changedFiles: {
        path: string;
        staged: boolean;
        unstaged: boolean;
        untracked: boolean;
      }[];
    }>("git_status", {
      repoRoot: fixture.repo,
      workspace: { kind: "local" },
    });
  const fileStatus = async (path: string) =>
    (await gitStatus()).changedFiles.find((file) => file.path === path) ?? null;
  const readFile = (path: string) =>
    invoke<{ kind: string; content?: string }>("fs_read_file", {
      path,
      workspace: { kind: "local" },
      force: false,
    }).then((result) => (result.kind === "text" ? (result.content ?? "") : ""));
  const editorText = () =>
    document.querySelector(".cm-content")?.textContent ?? "";
  const dirty = (tabId: number) => {
    const tab = app().tabs.find((candidate) => candidate.id === tabId);
    return tab?.kind === "editor" && tab.dirty;
  };
  const requestDiscard = async (path: string) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (pending()) app().destructiveGit().cancel();
      await app().destructiveGit().requestDiscard([path]);
      const plan = pending();
      if (plan?.affected.includes(path)) return plan;
      app().destructiveGit().cancel();
      await pause(250);
    }
    throw new Error(`no destructive plan was built for ${path}`);
  };

  try {
    await run.booted();

    const space = app().createSpace("Git guard", fixture.repo);
    app().newTabInSpace(space, fixture.repo);
    await run.switchSpace(space);
    // The scratch repository is a fresh root: open its terminal so the shell
    // authorizes the directory before the editor asks for the file.
    const gitTerminal = app().tabs.find(
      (tab) => tab.spaceId === space && tab.kind === "terminal",
    );
    if (gitTerminal?.kind !== "terminal")
      throw new Error("the Git-lab Space did not get a terminal tab");
    await run.sessionReady(gitTerminal.activeLeafId);
    await invoke("workspace_authorize", {
      path: fixture.repo,
      workspace: { kind: "local" },
    });
    const fileATab = app().openFileTab(fixture.fileA, true, space);
    await run.waitFor(
      () => app().tabs.some((tab) => tab.id === fileATab),
      "the file tab",
      20_000,
    );
    run.select(fileATab);
    await pause(1500);
    await run.log(
      `[git] tab ${fileATab}; tabs ${app()
        .tabs.map((tab) => `${tab.id}:${tab.kind}:${tab.spaceId}`)
        .join("|")}; active ${app().activeId}; editors ${
        document.querySelectorAll(".cm-content").length
      }; body ${(document.body.textContent ?? "").slice(0, 240)}`,
    );
    await run.waitFor(
      () => editorText().includes(fixture.baseA),
      "the tracked file in the editor",
      20_000,
    );

    // The panel follows the active file's repository, so mount it only once
    // the Git-lab Space is the context.
    app().openSourceControl();
    await run.waitFor(
      () => app().destructiveGit().mounted && app().destructiveGit().ready,
      "the Source Control destructive guard",
      30_000,
    );
    await check(
      "the Source Control guard mounts",
      app().destructiveGit().mounted,
      "bridge mounted and repository status ready",
    );
    app().editEditor(fileATab, "unsaved in the buffer\n");
    await run.waitFor(() => dirty(fileATab), "the dirty buffer");

    // 1. A dirty buffer in another pane of the same checkout blocks the discard.
    const firstPlan = await requestDiscard("src/a.ts");
    await run.waitFor(() => pending() !== null, "the discard dialog");
    const dialogText = document.body.textContent ?? "";
    await check(
      "the discard dialog names the unsaved buffer and its Space",
      firstPlan.blockers.some(
        (blocker) =>
          blocker.kind === "unsavedBuffer" &&
          blocker.tabId === fileATab &&
          blocker.spaceName === "Git guard",
      ) &&
        dialogText.includes("Discard changes?") &&
        dialogText.includes("unsaved changes") &&
        dialogText.includes("src/a.ts"),
      `blockers ${firstPlan.blockers.length}; dialog ${dialogText.includes("Discard changes?")}`,
    );

    // 2. Confirming without the acknowledgement is refused, and nothing moves.
    await app().destructiveGit().confirm({
      unsavedBuffers: [],
      activeWork: [],
      force: false,
    });
    await run.waitFor(
      () => typeof pending()?.stale === "string",
      "the unacknowledged refusal",
      10_000,
    );
    const afterRefusalStatus = await fileStatus("src/a.ts");
    const afterRefusalDisk = await readFile(fixture.fileA);
    await check(
      "an unacknowledged confirmation leaves the file and index unchanged",
      pending()?.stale?.includes("Acknowledge") === true &&
        afterRefusalDisk.includes(fixture.editedA) &&
        afterRefusalStatus?.staged === false &&
        afterRefusalStatus?.unstaged === true &&
        dirty(fileATab) &&
        editorText().includes("unsaved in the buffer"),
      `stale ${pending()?.stale ?? "none"}; disk edited ${afterRefusalDisk.includes(fixture.editedA)}; staged ${afterRefusalStatus?.staged}`,
    );
    await run.sync("git-refused-unacknowledged", {
      stale: pending()?.stale ?? null,
      disk: afterRefusalDisk.length,
    });

    // 3. Work started after the dialog opened makes the confirmation stale.
    const secondPlan = await requestDiscard("src/a.ts");
    await invoke("git_stage", {
      repoRoot: fixture.repo,
      paths: ["src/a.ts"],
      workspace: { kind: "local" },
    });
    await app()
      .destructiveGit()
      .confirm({
        unsavedBuffers: [fileATab],
        activeWork: [],
        force: false,
      });
    await run.waitFor(
      () => pending()?.stale?.includes("changed since") === true,
      "the stale-plan refusal",
      10_000,
    );
    const staleStatus = await fileStatus("src/a.ts");
    const staleDisk = await readFile(fixture.fileA);
    await check(
      "a plan that went stale is refused and performs no discard",
      secondPlan.fingerprint !== pending()?.fingerprint &&
        staleDisk.includes(fixture.editedA) &&
        staleStatus?.staged === true &&
        dirty(fileATab),
      `new fingerprint ${pending()?.fingerprint !== secondPlan.fingerprint}; disk edited ${staleDisk.includes(fixture.editedA)}; staged ${staleStatus?.staged}`,
    );
    await run.sync("git-refused-stale", {
      stale: pending()?.stale ?? null,
      staged: staleStatus?.staged ?? null,
    });

    app().destructiveGit().cancel();
    await run.waitFor(() => pending() === null, "the canceled dialog");
    await check(
      "cancel leaves the dialog closed and the buffer intact",
      pending() === null &&
        dirty(fileATab) &&
        (await readFile(fixture.fileA)).includes(fixture.editedA),
      "no pending plan, buffer still dirty",
    );

    // 4. The same action still works when it is deliberately confirmed.
    const bPlan = await requestDiscard("src/b.ts");
    await check(
      "a clean-buffer discard has no blockers",
      bPlan.blockers.length === 0,
      `blockers ${bPlan.blockers.length}`,
    );
    await app().destructiveGit().confirm({
      unsavedBuffers: [],
      activeWork: [],
      force: false,
    });
    await run.waitFor(
      () =>
        pending() === null &&
        (document.body.textContent ?? "").includes("Discarded"),
      "the confirmed discard",
      15_000,
    );
    const deadline = performance.now() + 10_000;
    let bDisk = await readFile(fixture.fileB);
    while (!bDisk.startsWith(fixture.baseB) && performance.now() < deadline) {
      await pause(150);
      bDisk = await readFile(fixture.fileB);
    }
    const bStatus = await fileStatus("src/b.ts");
    await check(
      "a confirmed discard restores the working file and keeps the index",
      bDisk.startsWith(fixture.baseB) && bStatus === null,
      `disk restored ${bDisk.startsWith(fixture.baseB)}; status ${JSON.stringify(bStatus)}`,
    );
    await run.sync("git-confirmed", {
      restored: bDisk.startsWith(fixture.baseB),
    });
  } catch (error) {
    throw new Error(await failed("scenario completed", String(error)));
  }

  const pass = steps.every((step) => step.ok);
  await run.log(
    `[git] ${pass ? "PASS" : "FAIL"} summary: ${steps.filter((step) => !step.ok).length} failures of ${steps.length}`,
  );
  return { git: { pass, steps } };
}

const SCENARIOS: Record<
  BenchScenario["name"],
  (run: ScenarioRun) => Promise<unknown>
> = {
  tabs: tabsScenario,
  resize: resizeScenario,
  "split-drag": splitDragScenario,
  occlusion: occlusionScenario,
  "agents-steady": agentsSteadyScenario,
  idle: idleScenario,
  "fs-churn": fsChurnScenario,
  input: inputScenario,
  workflow: workflowScenario,
  spaces: spacesScenario,
  git: gitScenario,
  preview: previewScenario,
  images: imagesScenario,
  resource: resourceScenario,
  stress: resourceScenario,
  startup: startupScenario,
};

let started = false;

/** Starts the configured scenario once the application has mounted; no-op without one. */
export async function startBenchDriver(app: () => BenchAppApi): Promise<void> {
  if (started) return;
  const config = (window as unknown as { __teraxBenchConfig?: BenchConfig })
    .__teraxBenchConfig;
  if (!config?.scenario || !config.reportUrl) return;
  started = true;
  const run = new ScenarioRun(config.reportUrl, config.scenario, app);
  try {
    await pause(1500);
    await run.sync("blank", { identifier: config.identifier });
    const summary = (await SCENARIOS[config.scenario.name](run)) as
      | Record<string, unknown>
      | undefined;
    await run.sync("done", summary ?? {});
  } catch (error) {
    console.error("[bench] scenario failed:", error);
    await reportError(config.reportUrl, error);
  } finally {
    await invoke("bench_exit").catch(() => undefined);
  }
}
