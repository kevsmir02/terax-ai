import { beforeEach, describe, expect, it, vi } from "vitest";

const preferences = vi.hoisted(() => ({
  agentNotifications: true,
  agentNotificationSound: true,
}));
const notifications = vi.hoisted(() => ({
  pushNotification: vi.fn(),
  osNotify: vi.fn(async () => "requested" as const),
  playSound: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => preferences },
}));
vi.mock("../components/AgentToast", () => ({
  showAgentToast: notifications.showToast,
}));
vi.mock("../store/agentStore", () => ({
  useAgentStore: {
    getState: () => ({ pushNotification: notifications.pushNotification }),
  },
}));
vi.mock("./notify", () => ({ osNotify: notifications.osNotify }));
vi.mock("./sound", () => ({
  playAgentNotificationSound: notifications.playSound,
}));

beforeEach(() => {
  vi.clearAllMocks();
  preferences.agentNotifications = true;
  preferences.agentNotificationSound = true;
});

describe("routeAgentNotification sound preference", () => {
  it("plays sound after requesting a native notification", async () => {
    const { routeAgentNotification } = await import("./route");

    routeAgentNotification({
      source: "terminal",
      agent: "codex",
      kind: "attention",
      focused: false,
      visible: false,
      allowToast: true,
      tabId: 101,
      leafId: 201,
      onActivate: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(notifications.osNotify).toHaveBeenCalledOnce(),
    );

    expect(notifications.playSound).toHaveBeenCalledOnce();
  });

  it("keeps native notifications silent when sound is disabled", async () => {
    preferences.agentNotificationSound = false;
    const { routeAgentNotification } = await import("./route");

    routeAgentNotification({
      source: "terminal",
      agent: "codex",
      kind: "attention",
      focused: false,
      visible: false,
      allowToast: true,
      tabId: 102,
      leafId: 202,
      onActivate: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(notifications.osNotify).toHaveBeenCalledOnce(),
    );

    expect(notifications.pushNotification).toHaveBeenCalledOnce();
    expect(notifications.playSound).not.toHaveBeenCalled();
  });

  it("keeps in-app toasts silent when sound is disabled", async () => {
    preferences.agentNotificationSound = false;
    const { routeAgentNotification } = await import("./route");

    routeAgentNotification({
      source: "terminal",
      agent: "gemini",
      kind: "attention",
      focused: true,
      visible: false,
      allowToast: true,
      tabId: 103,
      leafId: 203,
      onActivate: vi.fn(),
    });

    expect(notifications.showToast).toHaveBeenCalledOnce();
    expect(notifications.playSound).not.toHaveBeenCalled();
  });
});

describe("routeAgentNotification payload", () => {
  it("builds the payload from the agent, kind and Space name only", async () => {
    const { routeAgentNotification } = await import("./route");

    routeAgentNotification({
      source: "terminal",
      agent: "claude",
      kind: "turn-finished",
      spaceName: "api",
      focused: false,
      visible: false,
      allowToast: false,
      tabId: 104,
      leafId: 204,
      onActivate: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(notifications.osNotify).toHaveBeenCalledOnce(),
    );

    expect(notifications.osNotify).toHaveBeenCalledWith(
      "Claude Code turn finished",
      "Space: api",
    );
    expect(notifications.pushNotification).toHaveBeenCalledWith({
      source: "terminal",
      agent: "claude",
      kind: "turn-finished",
      tabId: 104,
      leafId: 204,
    });
  });

  it("suppresses a repeated notification inside the cooldown", async () => {
    const { routeAgentNotification } = await import("./route");
    const args = {
      source: "terminal" as const,
      agent: "pi",
      kind: "attention" as const,
      focused: false,
      visible: false,
      allowToast: false,
      tabId: 105,
      leafId: 205,
      onActivate: vi.fn(),
    };

    routeAgentNotification(args);
    routeAgentNotification(args);
    await vi.waitFor(() =>
      expect(notifications.osNotify).toHaveBeenCalledOnce(),
    );

    expect(notifications.pushNotification).toHaveBeenCalledOnce();
  });
});
