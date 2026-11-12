import { invoke } from "@tauri-apps/api/core";
import { setWindowVibrancy } from "@/modules/settings/store";
import { whenSessionReady, writeToSession } from "@/modules/terminal";
import type { Tab } from "@/modules/tabs";
import {
  readTerminalClipboard,
  writeTerminalClipboard,
} from "@/modules/terminal/lib/terminalClipboard";
import { collectDiagnostics } from "./diagnostics";
import { nativeWindow, reportError, reportPhase } from "./report";
import { installSmoothProbe, type SmoothSummary } from "./smoothProbe";
import type { BenchAppApi, BenchConfig, BenchScenario } from "./types";

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
      },
    };
  } finally {
    window.removeEventListener("message", receive);
  }
}

/** A rendered Markdown image, identified by the alt text the fixture wrote. */
function markdownImage(alt: string): HTMLImageElement | null {
  return document.querySelector<HTMLImageElement>(
    `[data-streamdown="image"][alt="${alt}"]`,
  );
}

/** A document-rendered link; the hardened href may be normalized to `/path`. */
function markdownLink(fragment: string): HTMLAnchorElement | null {
  return (
    [...document.querySelectorAll<HTMLAnchorElement>("a")].find((anchor) =>
      (anchor.getAttribute("href") ?? "").includes(fragment),
    ) ?? null
  );
}

function buttonWithText(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").includes(text),
    ) ?? null
  );
}

/**
 * The Markdown acceptance scenario through the real WebKitGTK webview.
 *
 * It drives the app's own Markdown tab planner and observes what the page really rendered and
 * fetched: an in-Space image, a symlink escape refused by the native grant, an outside
 * document confined to its own folder, an explicit grant, a counted remote image that is only
 * fetched after the person chooses, inert links, the syntax ceiling, and grant revocation on
 * close. The terminal cwd changes through the same `setLeafCwd` update an OSC 7 report drives.
 */
async function markdownScenario(
  run: ScenarioRun,
): Promise<Record<string, unknown>> {
  const config = run.scenario.markdown;
  if (!config)
    throw new Error(
      "the markdown scenario needs its fixture paths (scripts/app-lab/run.py creates them)",
    );
  const steps: WorkflowStep[] = [];
  const check = async (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    await run.log(`[markdown] ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };
  const failed = async (name: string, detail: string) => {
    await check(name, false, detail);
    return `markdown step failed: ${name}: ${detail}`;
  };
  const remoteHits = async (): Promise<number> => {
    try {
      const response = await fetch(run.url("/preview-ping"));
      const body = (await response.json()) as { markdownRemoteHits?: number };
      return body.markdownRemoteHits ?? 0;
    } catch {
      return -1;
    }
  };

  const domState = () => {
    const tabs = run
      .app()
      .tabs.map((tab) =>
        tab.kind === "terminal" ||
        tab.kind === "editor" ||
        tab.kind === "preview" ||
        tab.kind === "markdown"
          ? `${tab.kind}:${"path" in tab ? tab.path : "cwd" in tab ? tab.cwd : "url" in tab ? tab.url : ""}`
          : tab.kind,
      )
      .join(",");
    const body = document.querySelector(".select-text")?.textContent ?? "";
    return `tabs [${tabs}], active ${run.app().activeId}, page ${JSON.stringify(body.slice(0, 120))}, imgs ${document.querySelectorAll("img").length}, notice ${JSON.stringify((document.querySelector("[data-markdown-asset-notice]")?.textContent ?? "").slice(0, 160))}, alert ${JSON.stringify((document.querySelector('[role="alert"]')?.textContent ?? "").slice(0, 160))}`;
  };

  const first = await run.booted();

  // 1. A document inside the Space: its image loads from the configured root, and a symlink
  //    inside that root which points outside is refused by the native canonical check.
  const insideTab = run.app().openMarkdownTab(config.insideDoc);
  try {
    await run.waitFor(
      () =>
        run.app().activeId === insideTab &&
        markdownImage("inside")?.naturalWidth === 16,
      "the in-Space Markdown image",
      20_000,
    );
  } catch (error) {
    throw new Error(
      await failed("inside document image", `${String(error)}; ${domState()}`),
    );
  }
  const insideSrc = markdownImage("inside")?.src ?? "";
  await check(
    "inside document image",
    insideSrc.includes("token="),
    insideSrc || "no src",
  );
  try {
    await run.waitFor(
      () => markdownImage("escape")?.complete === true,
      "the symlink escape attempt",
      15_000,
    );
  } catch (error) {
    throw new Error(await failed("symlink escape refused", String(error)));
  }
  const escaped = markdownImage("escape");
  await check(
    "symlink escape refused",
    escaped !== null && escaped.naturalWidth === 0,
    `naturalWidth ${escaped?.naturalWidth ?? "missing"}`,
  );

  // 2. The mutable terminal cwd changes; the document's access must not follow it.
  run.app().setLeafCwd(first.leafId, "/tmp");
  run.select(first.tabId);
  try {
    await run.waitFor(
      () => {
        const tab = run
          .app()
          .tabs.find((candidate) => candidate.id === first.tabId);
        return tab?.kind === "terminal" && tab.cwd === "/tmp";
      },
      "the terminal cwd update",
      10_000,
    );
  } catch (error) {
    throw new Error(await failed("terminal cwd changes", String(error)));
  }
  run.select(insideTab);
  await pause(400);
  const afterCwd = markdownImage("inside");
  await check(
    "cwd change does not change document access",
    afterCwd?.src === insideSrc && afterCwd.naturalWidth === 16,
    `src ${afterCwd?.src === insideSrc ? "unchanged" : "changed"}, naturalWidth ${afterCwd?.naturalWidth ?? 0}`,
  );

  // 3. A document outside the Space root anchors on its own folder; a sibling image beyond it
  //    needs the explicit grant the notice offers.
  const outsideTab = run.app().openMarkdownTab(config.outsideDoc);
  try {
    await run.waitFor(
      () =>
        run.app().activeId === outsideTab &&
        markdownImage("own")?.naturalWidth === 16,
      "the outside document's own image",
      20_000,
    );
  } catch (error) {
    throw new Error(
      await failed("outside document own-folder image", String(error)),
    );
  }
  await check(
    "outside document own-folder image",
    markdownImage("parent") === null,
    "the outside image waits for consent",
  );
  const allow = buttonWithText("Allow");
  if (!allow)
    throw new Error(await failed("explicit grant offered", "no Allow button"));
  allow.click();
  try {
    await run.waitFor(
      () => markdownImage("parent")?.naturalWidth === 16,
      "the explicitly granted outside image",
      20_000,
    );
  } catch (error) {
    throw new Error(await failed("explicit outside grant", String(error)));
  }
  await check(
    "explicit outside grant",
    (markdownImage("parent")?.src ?? "").includes("token="),
    "loaded after the person chose",
  );

  // 4. Remote content: rendering the document fetches nothing; the counted pixel is requested
  //    only after the deliberate choice.
  const hitsBefore = await remoteHits();
  const remoteTab = run.app().openMarkdownTab(config.remoteDoc);
  try {
    await run.waitFor(
      () => run.app().activeId === remoteTab && buttonWithText("Load") !== null,
      "the remote-consent notice",
      20_000,
    );
  } catch (error) {
    throw new Error(await failed("remote consent notice", String(error)));
  }
  await pause(600);
  const beforeConsent = await remoteHits();
  await check(
    "remote image is not fetched automatically",
    markdownImage("remote") === null && hitsBefore === 0 && beforeConsent === 0,
    `image ${markdownImage("remote") ? "present" : "absent"}, hits ${hitsBefore}->${beforeConsent}`,
  );
  const loadRemote = buttonWithText("Load 1 remote image");
  if (!loadRemote)
    throw new Error(await failed("remote consent button", "no Load button"));
  loadRemote.click();
  try {
    await run.waitFor(
      () => (markdownImage("remote")?.naturalWidth ?? 0) > 0,
      "the consented remote image",
      20_000,
    );
  } catch (error) {
    throw new Error(await failed("consented remote load", String(error)));
  }
  const afterConsent = await remoteHits();
  await check(
    "consented remote load",
    afterConsent > beforeConsent,
    `hits ${beforeConsent}->${afterConsent}`,
  );

  // 5. A relative link is inert: it never navigates the application webview or opens a tab.
  const linkTab = run.app().openMarkdownTab(config.linkDoc);
  try {
    await run.waitFor(
      () =>
        run.app().activeId === linkTab && markdownLink("elsewhere.md") !== null,
      "the link document",
      20_000,
    );
  } catch (error) {
    throw new Error(await failed("link document", String(error)));
  }
  const hrefBefore = window.location.href;
  const tabsBefore = run.app().tabs.length;
  document
    .querySelector<HTMLAnchorElement>('a[href="./elsewhere.md"]')
    ?.click();
  await pause(500);
  await check(
    "relative link cannot navigate the app",
    window.location.href === hrefBefore && run.app().tabs.length === tabsBefore,
    `url ${window.location.href === hrefBefore ? "unchanged" : "changed"}, tabs ${tabsBefore}->${run.app().tabs.length}`,
  );

  // 6. Above the 4 MiB syntax ceiling the document still opens, without highlighting. Closing
  //    its tab revokes the asset grant it held, and a late completion does not resurrect it.
  const largeTab = run.app().openMarkdownTab(config.largeDoc);
  try {
    await run.waitFor(
      () =>
        run.app().activeId === largeTab &&
        document.querySelector('[data-syntax="off"]') !== null &&
        markdownImage("large")?.naturalWidth === 16,
      "the large document",
      40_000,
    );
  } catch (error) {
    throw new Error(
      await failed("large document without syntax", String(error)),
    );
  }
  const largeSrc = markdownImage("large")?.src ?? "";
  await check(
    "large document opens without syntax",
    largeSrc.includes("token="),
    largeSrc || "no asset src",
  );
  run.app().closeTab(largeTab);
  await pause(800);
  const servedAfterClose = await new Promise<boolean>((resolve) => {
    if (!largeSrc) {
      resolve(false);
      return;
    }
    const probe = new Image();
    probe.onload = () => resolve(true);
    probe.onerror = () => resolve(false);
    probe.src = largeSrc;
  });
  await check(
    "close revokes the document's asset grant",
    largeSrc !== "" && !servedAfterClose,
    `asset ${servedAfterClose ? "still served" : "refused"}`,
  );
  await check(
    "closed document does not resurrect",
    run.app().tabs.every((tab) => tab.id !== largeTab) &&
      document.querySelector('[data-syntax="off"]') === null,
    `tab ${run.app().tabs.some((tab) => tab.id === largeTab) ? "present" : "gone"}`,
  );

  const pass = steps.every((step) => step.ok);
  await run.log(
    `[markdown] ${pass ? "PASS" : "FAIL"} summary: ${steps.filter((step) => !step.ok).length} failures of ${steps.length}`,
  );
  return {
    markdown: {
      pass,
      steps,
      insideTab,
      outsideTab,
      remoteTab,
      linkTab,
      cwdAfter: "/tmp",
      remoteHits: { before: hitsBefore, after: afterConsent },
    },
  };
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
  markdown: markdownScenario,
  preview: previewScenario,
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
  // Forward console warnings/errors to the run log so a failing step leaves its cause behind.
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      void fetch(`${config.reportUrl}/log`, {
        method: "POST",
        body: `console.${level}: ${args.map((value) => String(value)).join(" ")}`,
      }).catch(() => undefined);
    };
  }
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
