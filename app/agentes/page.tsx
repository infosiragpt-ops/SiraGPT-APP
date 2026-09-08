import type { Metadata } from "next"

import { AgentsHomeSurface } from "@/components/agents-home-surface"

export const metadata: Metadata = {
  title: "Agentes — SiraGPT",
  description: "Home de agentes de SiraGPT. El nombre del producto es agentes, no chat.",
  robots: { index: false, follow: false },
}

export const dynamic = "force-dynamic"

export default function AgentesPage() {
  return <AgentsHomeSurface />
}
