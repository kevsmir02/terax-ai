import type { PresenceState } from "@/lib/usePresence";
import { lazy, Suspense } from "react";

const AgentRunBridgeInner = lazy(() =>
  import("./AgentRunBridge").then((m) => ({ default: m.AgentRunBridge })),
);

const AiMiniWindowInner = lazy(() =>
  import("./AiMiniWindow").then((m) => ({ default: m.AiMiniWindow })),
);

const AiInputBarConnectInner = lazy(() =>
  import("./AiInputBar").then((m) => ({ default: m.AiInputBarConnect })),
);

export function AgentRunBridge() {
  return (
    <Suspense fallback={null}>
      <AgentRunBridgeInner />
    </Suspense>
  );
}

export function AiMiniWindow({ state }: { state: PresenceState }) {
  return (
    <Suspense fallback={null}>
      <AiMiniWindowInner state={state} />
    </Suspense>
  );
}

export function AiInputBarConnect({ onAdd }: { onAdd: () => void }) {
  return (
    <Suspense fallback={null}>
      <AiInputBarConnectInner onAdd={onAdd} />
    </Suspense>
  );
}
