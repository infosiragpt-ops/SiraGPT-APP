import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = {
  title: "Planes",
  description:
    "Dos planes, sin letra pequeña: Pro por $10 USD al mes o una propuesta a la medida de tu equipo.",
}

export default function PlanesLayout({ children }: { children: ReactNode }) {
  return children
}
