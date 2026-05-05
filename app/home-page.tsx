"use client"

import { BrandLogo } from "@/components/BrandLogo"
import { BottomGlowBar } from "@/components/BottomGlowBar"
import { CTASection } from "@/components/landing/CTASection"
import { FeaturesSection } from "@/components/landing/FeaturesSection"
import { Footer } from "@/components/landing/Footer"
import { HowItWorks } from "@/components/landing/HowItWorks"
import { PricingSection } from "@/components/landing/PricingSection"
import { TestimonialsSection } from "@/components/landing/TestimonialsSection"
import { LoginButton, SignUpButton } from "@/components/AuthNavButtons"
import { ThemeToggle } from "@/components/theme-toggle"
import { motion } from "framer-motion"
import {
  ArrowRight,
  Cpu,
  FileText,
  ImageIcon,
  MessageSquare,
  Search,
  Sparkles,
} from "lucide-react"
import Link from "next/link"

const stats = [
  { label: "Modelos de IA", value: "12+" },
  { label: "Usuarios activos", value: "10K+" },
  { label: "Documentos procesados", value: "500K+" },
  { label: "Países", value: "40+" },
]

const trustLogos = [
  { name: "OpenAI", icon: MessageSquare },
  { name: "Anthropic", icon: Cpu },
  { name: "Google", icon: Search },
  { name: "ElevenLabs", icon: Sparkles },
  { name: "Stripe", icon: FileText },
]

export default function HomePage() {
  return (
    <div className="relative min-h-screen bg-gradient-to-b from-white to-gray-50 dark:from-[#05070A] dark:to-gray-950 text-gray-900 dark:text-white overflow-x-hidden">
      <BottomGlowBar />

      {/* Header */}
      <header className="fixed top-0 w-full z-50 border-b border-gray-200 dark:border-white/10 bg-white/80 dark:bg-black/50 backdrop-blur-xl">
        <div className="container mx-auto flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
          <BrandLogo />

          <nav className="hidden md:flex items-center gap-1">
            <Link
              href="#features"
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Características
            </Link>
            <Link
              href="#how-it-works"
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Cómo funciona
            </Link>
            <Link
              href="#pricing"
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Precios
            </Link>
          </nav>

          <motion.div
            className="flex items-center gap-2 md:gap-3"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
          >
            <ThemeToggle />
            <LoginButton href="/auth/login" />
            <div className="hidden sm:block">
              <SignUpButton href="/auth/register" />
            </div>
          </motion.div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative flex min-h-screen items-center justify-center pt-24 md:pt-32">
        {/* Background subtle radial gradient */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-[800px] w-[800px] rounded-full bg-primary/3 blur-[150px]" />
        </div>

        <div className="relative mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto max-w-4xl text-center">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-accent/40 px-3 py-1 text-xs font-medium text-foreground/80 mb-8"
            >
              <Sparkles className="h-3 w-3" />
              <span>Plataforma de IA multimodal — v2.0</span>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
              className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl lg:text-7xl"
            >
              Todo el poder de la IA en{" "}
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500">
                un solo lugar
              </span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground leading-relaxed md:text-xl"
            >
              Chatea con GPT-4, Claude 3.5, Gemini Pro y más. Genera imágenes, analiza documentos, diseña prototipos e investiga con agentes de IA especializados.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row"
            >
              <Link
                href="/auth/register"
                className="group inline-flex h-12 items-center gap-2 rounded-xl bg-primary px-7 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 hover:shadow-primary/30"
              >
                Empezar gratis
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                href="/chat"
                className="inline-flex h-12 items-center gap-2 rounded-xl border border-border bg-background px-7 text-sm font-semibold text-foreground transition-all hover:bg-accent"
              >
                Probar demo
              </Link>
            </motion.div>

            {/* Stats */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto mt-16 grid max-w-2xl grid-cols-2 gap-8 border-t border-border/40 pt-8 sm:grid-cols-4"
            >
              {stats.map((stat) => (
                <div key={stat.label} className="flex flex-col items-center">
                  <span className="text-2xl font-bold tracking-tight sm:text-3xl">
                    {stat.value}
                  </span>
                  <span className="mt-1 text-xs text-muted-foreground">{stat.label}</span>
                </div>
              ))}
            </motion.div>
          </div>

          {/* Featured capabilities quick preview */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="mx-auto mt-20 max-w-5xl"
          >
            <div className="relative rounded-2xl border border-border/50 bg-card/60 p-1 backdrop-blur-sm shadow-2xl shadow-foreground/5">
              <div className="overflow-hidden rounded-xl bg-background">
                {/* Simulated chat UI preview */}
                <div className="flex h-[420px] md:h-[520px]">
                  {/* Sidebar */}
                  <div className="hidden w-60 border-r border-border/50 bg-muted/30 p-3 md:block">
                    <div className="flex items-center gap-2 rounded-lg bg-accent p-2">
                      <MessageSquare className="h-4 w-4" />
                      <span className="text-xs font-medium">Nuevo chat</span>
                    </div>
                    <div className="mt-3 space-y-1.5">
                      {[1, 2, 3].map((i) => (
                        <div
                          key={i}
                          className="h-8 rounded-md bg-muted/50 animate-pulse"
                          style={{ animationDelay: `${i * 0.2}s` }}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Chat area */}
                  <div className="flex flex-1 flex-col">
                    {/* Header */}
                    <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-6 w-6 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500" />
                        <span className="text-sm font-medium">Sira GPT</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <ImageIcon className="h-4 w-4 text-muted-foreground" />
                        <FileText className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>

                    {/* Messages */}
                    <div className="flex-1 overflow-hidden p-4 space-y-4">
                      {/* User message */}
                      <div className="flex justify-end">
                        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5">
                          <p className="text-sm text-primary-foreground">
                            Analiza este paper y genera un resumen ejecutivo
                          </p>
                        </div>
                      </div>
                      {/* Assistant message */}
                      <div className="flex gap-3">
                        <div className="h-7 w-7 shrink-0 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500" />
                        <div className="max-w-[85%] space-y-2">
                          <div className="h-3 w-48 rounded bg-muted animate-pulse" />
                          <div className="h-3 w-full rounded bg-muted animate-pulse" />
                          <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
                          <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
                        </div>
                      </div>
                    </div>

                    {/* Input */}
                    <div className="border-t border-border/50 p-3">
                      <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5">
                        <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30" />
                        <div className="h-3 flex-1 rounded bg-muted animate-pulse" />
                        <div className="h-7 w-7 rounded-lg bg-primary" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Trust logos */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 1 }}
            className="mt-16 flex flex-col items-center gap-6"
          >
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Impulsado por
            </p>
            <div className="flex flex-wrap items-center justify-center gap-8 opacity-40 grayscale transition-opacity hover:opacity-70">
              {trustLogos.map((logo) => (
                <div key={logo.name} className="flex items-center gap-2">
                  <logo.icon className="h-5 w-5" />
                  <span className="text-sm font-medium">{logo.name}</span>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      {/* Content Sections */}
      <div id="features">
        <FeaturesSection />
      </div>

      <div id="how-it-works">
        <HowItWorks />
      </div>

      <TestimonialsSection />

      <div id="pricing">
        <PricingSection />
      </div>

      <CTASection />

      <Footer />
    </div>
  )
}
