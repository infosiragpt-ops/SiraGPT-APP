import type { Metadata } from "next"

import { AgentsHomeSurface } from "@/components/agents-home-surface"

export const metadata: Metadata = {
  title: "Agentes — SiraGPT",
  description: "Conversación de agentes. El nombre del producto es agentes, no chat.",
  robots: { index: false, follow: false },
}

export const dynamic = "force-dynamic"

export default function AgentesConversationPage() {
  return <AgentsHomeSurface />
}
