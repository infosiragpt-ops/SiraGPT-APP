import type { Metadata } from "next"
import HomePage from "./home-page"

export const metadata: Metadata = {
  title: "Sira GPT — Plataforma de IA Multimodal",
  description:
    "ChatGPT, Claude, Gemini, Grok y más en una sola plataforma. Chatea, genera imágenes, analiza documentos, diseña prototipos e investiga con IA.",
  keywords: [
    "IA",
    "chatbot",
    "GPT-4",
    "Claude",
    "Gemini",
    "generación de imágenes",
    "AI platform",
    "asistente de IA",
    "productividad",
  ],
  authors: [{ name: "Sira GPT" }],
  creator: "Sira GPT",
  metadataBase: new URL("https://siragpt.com"),
  openGraph: {
    title: "Sira GPT — Plataforma de IA Multimodal",
    description:
      "Los mejores modelos de IA en una sola plataforma. Chatea, crea e investiga con IA de próxima generación.",
    type: "website",
    locale: "es_ES",
  },
  twitter: {
    card: "summary_large_image",
    title: "Sira GPT — Plataforma de IA Multimodal",
    description:
      "Los mejores modelos de IA en una sola plataforma. Chatea, crea e investiga con IA de próxima generación.",
  },
}

export const dynamic = "force-dynamic"

export default function Page() {
  return <HomePage />
}
