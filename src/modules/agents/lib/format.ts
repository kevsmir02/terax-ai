const LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  pi: "Pi",
  opencode: "OpenCode",
  grok: "Grok",
  // The terminal CLI, not the separate Antigravity desktop application.
  antigravity: "Antigravity CLI",
  terax: "Terax",
};

export function displayAgent(agent: string): string {
  if (!agent) return "Agent";
  return (
    LABELS[agent.toLowerCase()] ??
    agent.charAt(0).toUpperCase() + agent.slice(1)
  );
}
