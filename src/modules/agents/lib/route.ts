import { usePreferencesStore } from "@/modules/settings/preferences";
import { showAgentToast } from "../components/AgentToast";
import { useAgentStore } from "../store/agentStore";
import { resolveAgentNotificationDelivery } from "./delivery";
import { agentNotificationContent } from "./notificationContent";
import { createAgentNotificationGate } from "./notificationGate";
import { osNotify } from "./notify";
import { playAgentNotificationSound } from "./sound";
import type { AgentSource, NotificationKind } from "./types";

const shouldDeliver = createAgentNotificationGate();

type RouteArgs = {
  source: AgentSource;
  agent: string;
  kind: NotificationKind;
  /** The Space's own name; the only project identity a notification carries. */
  spaceName?: string | null;
  focused: boolean;
  /** True when the user is currently looking at this agent. */
  visible: boolean;
  /** Allow an in-app toast when focused but not looking at the agent. */
  allowToast: boolean;
  tabId?: number;
  leafId?: number;
  onActivate: () => void;
};

/**
 * Single delivery point for agent attention and completion. The payload is
 * built here from the allowlisted fields (agent, kind, Space name) so no caller
 * can put prompt, transcript or file text into a notification.
 */
export function routeAgentNotification({
  source,
  agent,
  kind,
  spaceName,
  focused,
  visible,
  allowToast,
  tabId = 0,
  leafId = 0,
  onActivate,
}: RouteArgs): void {
  const preferences = usePreferencesStore.getState();
  if (!preferences.agentNotifications) return;
  const delivery = resolveAgentNotificationDelivery({
    focused,
    visible,
    allowToast,
  });
  if (delivery === "none") return;
  if (!shouldDeliver({ source, agent, kind, tabId, leafId })) return;

  const content = agentNotificationContent({ agent, kind, spaceName });

  useAgentStore
    .getState()
    .pushNotification({ source, agent, kind, tabId, leafId });

  if (delivery === "native") {
    void osNotify(content.title, content.body).then((result) => {
      if (
        result === "requested" &&
        usePreferencesStore.getState().agentNotificationSound
      ) {
        playAgentNotificationSound();
      }
    });
    return;
  }
  if (delivery === "toast") {
    if (preferences.agentNotificationSound) playAgentNotificationSound();
    showAgentToast({ agent, ...content, onActivate });
  }
}
