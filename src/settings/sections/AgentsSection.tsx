import { SectionHeader } from "../components/SectionHeader";
import { AgentHooksGroup } from "../components/AgentHooksGroup";

/**
 * External-agent hook configuration. The built-in AI personas, snippets and
 * custom instructions that used to live here were removed with built-in chat
 * (ticket #12); the reviewed hook install/remove flow is retained (ticket #20).
 */
export function AgentsSection() {
  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Agents"
        description="Optional hooks for terminal coding agents. A hook is reviewed before it is written, and only this fork's entries are added or removed. Launching an agent never installs one."
      />
      <AgentHooksGroup />
    </div>
  );
}
