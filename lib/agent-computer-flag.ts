/**
 * Explicit feature flag for the Grok-bot-style noVNC ComputerViewer.
 * Unset / empty keeps the existing Selkies/PNG department pane unchanged.
 */
export function isAgentComputerEnabled(
  env: { NEXT_PUBLIC_AGENT_COMPUTER?: string; SIRAGPT_AGENT_COMPUTER?: string } = {
    NEXT_PUBLIC_AGENT_COMPUTER: process.env.NEXT_PUBLIC_AGENT_COMPUTER,
    SIRAGPT_AGENT_COMPUTER: process.env.SIRAGPT_AGENT_COMPUTER,
  },
): boolean {
  const raw = String(env.NEXT_PUBLIC_AGENT_COMPUTER || env.SIRAGPT_AGENT_COMPUTER || "")
    .trim()
    .toLowerCase()
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes"
}
