import type { Metadata } from "next"
import HomePage from "./home-page"

export const metadata: Metadata = {
  title: "SiraGPT — Plataforma de IA Multimodal",
  description:
    "SiraGPT integra OpenAI, Gemini, Claude, DeepSeek, Stripe, Replit, ElevenLabs y OpenClaw en una experiencia de IA profesional.",
  keywords: [
    "IA",
    "chatbot",
    "OpenAI",
    "Claude",
    "Gemini",
    "DeepSeek",
    "Stripe",
    "Replit",
    "ElevenLabs",
    "OpenClaw",
    "generación de imágenes",
    "AI platform",
    "asistente de IA",
    "productividad",
  ],
  authors: [{ name: "SiraGPT" }],
  creator: "SiraGPT",
  metadataBase: new URL("https://siragpt.com"),
  openGraph: {
    title: "SiraGPT — Plataforma de IA Multimodal",
    description:
      "OpenAI, Gemini, Claude, DeepSeek, Stripe, Replit, ElevenLabs y OpenClaw en una sola plataforma.",
    type: "website",
    locale: "es_ES",
  },
  twitter: {
    card: "summary_large_image",
    title: "SiraGPT — Plataforma de IA Multimodal",
    description:
      "Una landing minimalista para la plataforma IA de Sira GPT.",
  },
}

export const dynamic = "force-dynamic"

export default function Page() {
  return <HomePage />
}
