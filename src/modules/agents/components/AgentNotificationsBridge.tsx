import type { Tab } from "@/modules/tabs";
import {
  hasLeaf,
  leafIdForPty,
  subscribeAgentSignals,
} from "@/modules/terminal";
import { useEffect, useRef } from "react";
import { routeAgentNotification } from "../lib/route";
import { signalStatus } from "../lib/status";
import type { AgentSession, AgentSignal, NotificationKind } from "../lib/types";
import { useWindowFocus } from "../lib/useWindowFocus";
import { useAgentStore } from "../store/agentStore";

type Activate = (tabId: number, leafId: number) => void;
type Ctx = {
  tabs: Tab[];
  activeId: number;
  focused: boolean;
  onActivate: Activate;
  /** Space id -> Space name, for Space identity in notifications. */
  spaceNames: Record<string, string>;
};

function tabInfo(
  tabs: Tab[],
  leafId: number,
): { tabId: number; spaceId: string } | null {
  for (const t of tabs) {
    if (t.kind === "terminal" && hasLeaf(t.paneTree, leafId)) {
      return { tabId: t.id, spaceId: t.spaceId };
    }
  }
  return null;
}

function route(session: AgentSession, kind: NotificationKind, ctx: Ctx): void {
  const info = tabInfo(ctx.tabs, session.leafId);

  routeAgentNotification({
    source: "terminal",
    agent: session.agent,
    kind,
    spaceName: info ? ctx.spaceNames[info.spaceId] : undefined,
    focused: ctx.focused,
    visible: ctx.activeId === session.tabId,
    // Stop fires every turn, so a finished turn only updates the bell; attention
    // toasts. Neither path moves focus.
    allowToast: kind === "attention",
    tabId: session.tabId,
    leafId: session.leafId,
    onActivate: () => ctx.onActivate(session.tabId, session.leafId),
  });
}

/** Applies one detector signal to the notification stores and router. */
export function handleAgentSignal(sig: AgentSignal, ctx: Ctx): void {
  const leafId = leafIdForPty(sig.id);
  if (leafId === null) return;
  const store = useAgentStore.getState();
  const verdict = signalStatus(sig.kind);

  switch (sig.kind) {
    case "started": {
      const info = tabInfo(ctx.tabs, leafId);
      if (!info) return;
      store.start(leafId, info.tabId, sig.agent ?? "agent");
      return;
    }
    case "working":
      if (verdict.status) store.setStatus(leafId, verdict.status);
      return;
    case "attention":
    case "finished": {
      // The process keeps the pane after a finished turn, so the session stays
      // running; only an event can produce the notification.
      if (verdict.status) store.setStatus(leafId, verdict.status);
      const session = store.sessions[leafId];
      if (!session) return;
      if (verdict.event === "attention") route(session, "attention", ctx);
      else if (verdict.turnEnded) route(session, "turn-finished", ctx);
      return;
    }
    case "exited":
      store.finish(leafId);
      return;
  }
}

export function AgentNotificationsBridge({
  tabs,
  activeId,
  onActivate,
  spaceNames,
}: {
  tabs: Tab[];
  activeId: number;
  onActivate: Activate;
  spaceNames?: Record<string, string>;
}) {
  const focused = useWindowFocus();
  const ctxRef = useRef<Ctx>({
    tabs,
    activeId,
    focused,
    onActivate,
    spaceNames: spaceNames ?? {},
  });
  ctxRef.current = {
    tabs,
    activeId,
    focused,
    onActivate,
    spaceNames: spaceNames ?? {},
  };

  // Shares the terminal module's single `terax:agent-signal` listener.
  useEffect(
    () =>
      subscribeAgentSignals((signal) =>
        handleAgentSignal(signal as AgentSignal, ctxRef.current),
      ),
    [],
  );

  return null;
}
