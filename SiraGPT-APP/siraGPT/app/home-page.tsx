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
import { useEffect } from "react"
import { motion } from "framer-motion"
import {
  Cpu,
  FileText,
  ImageIcon,
  MessageSquare,
  Search,
  Sparkles,
  Plus,
  ChevronDown,
  Share2,
  Send,
  Paperclip,
  Globe,
  Settings,
  Code,
  Paintbrush,
  BarChart3,
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
  useEffect(() => {
    // Enable standard browser scrolling on the public landing page
    const htmlEl = document.documentElement
    const bodyEl = document.body

    htmlEl.style.overflow = "auto"
    htmlEl.style.height = "auto"
    htmlEl.style.overscrollBehavior = "auto"

    bodyEl.style.overflow = "auto"
    bodyEl.style.height = "auto"
    bodyEl.style.overscrollBehavior = "auto"

    return () => {
      // Revert back to app-shell overflow:hidden locks when leaving
      htmlEl.style.overflow = ""
      htmlEl.style.height = ""
      htmlEl.style.overscrollBehavior = ""

      bodyEl.style.overflow = ""
      bodyEl.style.height = ""
      bodyEl.style.overscrollBehavior = ""
    }
  }, [])

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
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {/* Glowing blobs */}
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full bg-indigo-500/10 dark:bg-indigo-500/5 blur-[120px] mix-blend-screen animate-pulse" style={{ animationDuration: "8s" }} />
          <div className="absolute top-1/3 left-1/3 w-[400px] h-[400px] rounded-full bg-pink-500/10 dark:bg-pink-500/5 blur-[100px] mix-blend-screen animate-pulse" style={{ animationDuration: "12s" }} />
          <div className="absolute top-1/2 right-1/4 w-[450px] h-[450px] rounded-full bg-cyan-500/10 dark:bg-cyan-500/5 blur-[110px] mix-blend-screen animate-pulse" style={{ animationDuration: "10s" }} />
        </div>

        <div className="relative mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto max-w-4xl text-center">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              className="inline-flex items-center gap-2 rounded-full border border-violet-500/20 dark:border-violet-500/30 bg-violet-500/5 dark:bg-violet-500/10 px-4 py-1.5 text-xs font-semibold text-violet-600 dark:text-violet-300 mb-8 backdrop-blur-md shadow-lg shadow-violet-500/5"
            >
              <Sparkles className="h-3.5 w-3.5 animate-pulse text-violet-500" />
              <span className="tracking-wide">Plataforma de Inteligencia Artificial Multimodal — v2.0</span>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
              className="text-4xl font-extrabold tracking-tight sm:text-5xl md:text-6xl lg:text-7xl leading-[1.1] md:leading-[1.05]"
            >
              Todo el poder de la IA en{" "}
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-violet-600 via-fuchsia-500 to-pink-500 dark:from-violet-400 dark:via-fuchsia-400 dark:to-pink-400 drop-shadow-sm">
                un solo lugar
              </span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto mt-6 max-w-3xl text-base text-muted-foreground/90 leading-relaxed md:text-xl font-normal"
            >
              Chatea con <span className="text-foreground font-semibold">GPT-5.5</span>,{" "}
              <span className="text-foreground font-semibold">Claude Opus 4.7</span>,{" "}
              <span className="text-foreground font-semibold">Gemini 3.5 Pro</span> y más. Genera imágenes, analiza documentos, diseña prototipos e investiga con agentes de IA especializados.
            </motion.p>

            {/* Stats */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto mt-16 max-w-4xl rounded-2xl border border-border/40 bg-background/30 dark:bg-card/20 p-6 backdrop-blur-md shadow-xl grid grid-cols-2 gap-6 sm:grid-cols-4"
            >
              {stats.map((stat) => (
                <div key={stat.label} className="flex flex-col items-center justify-center p-2 rounded-xl hover:bg-accent/10 transition-colors">
                  <span className="text-3xl font-extrabold tracking-tight sm:text-4xl bg-gradient-to-b from-foreground to-foreground/80 bg-clip-text text-transparent">
                    {stat.value}
                  </span>
                  <span className="mt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground/80">{stat.label}</span>
                </div>
              ))}
            </motion.div>
          </div>

          {/* Featured capabilities quick preview */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="mx-auto mt-20 max-w-5xl"
          >
            <div className="relative rounded-2xl border border-border/50 bg-card/60 p-1.5 backdrop-blur-sm shadow-2xl shadow-violet-500/5 dark:shadow-violet-500/10">
              {/* Outer gradient glow line */}
              <div className="absolute -inset-px rounded-2xl bg-gradient-to-r from-violet-500/20 via-fuchsia-500/20 to-pink-500/20 opacity-70 blur-sm pointer-events-none" />
              
              <div className="relative overflow-hidden rounded-xl bg-background border border-border/40">
                {/* Simulated chat UI preview */}
                <div className="flex h-[520px] md:h-[620px]">
                  {/* Sidebar */}
                  <div className="hidden w-64 border-r border-border/50 bg-muted/20 p-4 md:flex flex-col justify-between">
                    <div>
                      {/* Workspace selector */}
                      <div className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-accent/50 cursor-pointer transition-colors mb-4">
                        <div className="flex items-center gap-2">
                          <div className="h-5 w-5 rounded bg-violet-600 flex items-center justify-center text-[10px] font-bold text-white shadow-sm">
                            S
                          </div>
                          <span className="text-xs font-semibold text-foreground">Sira Workspace</span>
                        </div>
                        <ChevronDown className="h-3 w-3 text-muted-foreground" />
                      </div>

                      {/* New Chat Button */}
                      <div className="flex items-center justify-center gap-2 rounded-xl border border-border/80 bg-background/50 hover:bg-accent hover:text-accent-foreground py-2 px-3 text-xs font-medium cursor-pointer transition-all shadow-sm">
                        <Plus className="h-3.5 w-3.5" />
                        <span>Nuevo Chat</span>
                      </div>

                      {/* Agentes Activos Section */}
                      <div className="mt-6">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80 px-2 block mb-2">
                          Agentes Especializados
                        </span>
                        <div className="space-y-1">
                          <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-accent/30 text-xs font-medium text-foreground cursor-pointer">
                            <div className="flex items-center gap-2">
                              <Code className="h-3.5 w-3.5 text-violet-500" />
                              <span>Asistente de Código</span>
                            </div>
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          </div>
                          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-accent/40 text-xs font-medium text-muted-foreground cursor-pointer transition-colors">
                            <Paintbrush className="h-3.5 w-3.5" />
                            <span>Diseñador Creativo</span>
                          </div>
                          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-accent/40 text-xs font-medium text-muted-foreground cursor-pointer transition-colors">
                            <BarChart3 className="h-3.5 w-3.5" />
                            <span>Analista Financiero</span>
                          </div>
                        </div>
                      </div>

                      {/* Recientes Section */}
                      <div className="mt-6">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80 px-2 block mb-2">
                          Documentos y Chats
                        </span>
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-accent/30 text-xs text-muted-foreground cursor-pointer transition-colors truncate">
                            <FileText className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">Analisis_Mercado_Q2.xlsx</span>
                          </div>
                          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-accent/30 text-xs text-muted-foreground cursor-pointer transition-colors truncate">
                            <FileText className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">Pitch_Deck_Proyecto_v3.pdf</span>
                          </div>
                          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-accent/30 text-xs text-muted-foreground cursor-pointer transition-colors truncate">
                            <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">Ideas para Estrategia SEO</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Sidebar Footer */}
                    <div className="border-t border-border/50 pt-3">
                      <div className="flex items-center gap-2 px-2">
                        <div className="h-7 w-7 rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 flex items-center justify-center text-[10px] font-bold text-white shadow-md">
                          L
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="text-xs font-semibold text-foreground truncate">Luis Pérez</span>
                          <span className="text-[9px] text-muted-foreground truncate">Plan Premium</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Chat area */}
                  <div className="flex flex-1 flex-col bg-background/50 backdrop-blur-md">
                    {/* Header */}
                    <div className="flex items-center justify-between border-b border-border/50 px-4 py-3 bg-muted/10">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 rounded-xl bg-background/80 border border-border/60 px-3 py-1.5 text-xs font-semibold text-foreground shadow-sm hover:bg-accent cursor-pointer transition-colors">
                          <span className="text-[14px]">🤖</span>
                          <span>GPT-5.5 (Ultra-Orchestrated)</span>
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        </div>
                        <div className="hidden sm:flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                          <span className="h-1 w-1 rounded-full bg-emerald-500" />
                          <span>Activo</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
                          <Share2 className="h-4 w-4" />
                        </div>
                        <div className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
                          <Settings className="h-4 w-4" />
                        </div>
                      </div>
                    </div>

                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                      {/* User message */}
                      <div className="flex justify-end">
                        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-primary px-4 py-3 shadow-md shadow-primary/10">
                          <p className="text-xs sm:text-sm text-primary-foreground leading-relaxed">
                            Analiza el crecimiento del proyecto y genera un informe visual.
                          </p>
                        </div>
                      </div>

                      {/* Assistant message */}
                      <div className="flex gap-3">
                        <div className="h-8 w-8 shrink-0 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white shadow-md shadow-violet-500/10">
                          <Sparkles className="h-4 w-4" />
                        </div>
                        <div className="max-w-[85%] space-y-3">
                          <div className="rounded-2xl rounded-tl-sm border border-border/50 bg-card/60 p-4 shadow-sm backdrop-blur-md">
                            <p className="text-xs sm:text-sm text-foreground leading-relaxed">
                              He analizado el documento de forma exhaustiva. Basado en los datos históricos suministrados de Q1 y Q2, he proyectado un incremento de rentabilidad del <span className="text-violet-600 dark:text-violet-400 font-bold">24%</span> para el siguiente trimestre. Aquí tienes el desglose visual:
                            </p>
                            
                            {/* Premium CSS Chart Mockup */}
                            <div className="mt-4 rounded-xl border border-border/40 bg-muted/40 p-3 space-y-3">
                              <div className="flex justify-between items-center text-[10px] font-semibold text-muted-foreground">
                                <span>PROYECCIÓN DE CRECIMIENTO</span>
                                <span className="text-emerald-500">+24.3%</span>
                              </div>
                              <div className="grid grid-cols-4 gap-2 pt-2">
                                {[
                                  { label: "Q1", value: "h-12", color: "from-violet-500 to-violet-600" },
                                  { label: "Q2", value: "h-20", color: "from-fuchsia-500 to-fuchsia-600" },
                                  { label: "Q3 (Est)", value: "h-28", color: "from-pink-500 to-pink-600" },
                                  { label: "Q4 (Proyect)", value: "h-36", color: "from-indigo-500 to-indigo-600" },
                                ].map((item) => (
                                  <div key={item.label} className="flex flex-col items-center gap-1.5">
                                    <div className="w-full bg-accent/40 rounded-md h-36 flex items-end overflow-hidden">
                                      <div className={`w-full ${item.value} rounded-b-md bg-gradient-to-t ${item.color} shadow-lg shadow-violet-500/5 animate-pulse`} />
                                    </div>
                                    <span className="text-[9px] font-bold text-muted-foreground">{item.label}</span>
                                  </div>
                                ))}
                              </div>
                            </div>

                            <p className="text-xs sm:text-sm text-foreground leading-relaxed mt-4">
                              Además, he generado la ilustración del prototipo solicitado utilizando el Agente de Diseño Creativo:
                            </p>

                            {/* Gorgeous Generated Image Mockup */}
                            <div className="mt-3 relative group overflow-hidden rounded-xl border border-border/40 bg-black/40 aspect-[16/9] flex items-center justify-center shadow-lg">
                              {/* Background abstract colorful mesh */}
                              <div className="absolute inset-0 bg-gradient-to-tr from-violet-900/60 via-fuchsia-900/40 to-cyan-900/50 mix-blend-color-dodge pointer-events-none" />
                              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 rounded-full bg-gradient-to-br from-violet-500/20 to-pink-500/20 blur-xl animate-pulse" />
                              
                              {/* Futuristic geometric shapes */}
                              <div className="relative border border-white/10 rounded-2xl p-4 bg-white/5 backdrop-blur-xl shadow-2xl w-4/5 text-center space-y-2 border-t-white/20">
                                <div className="h-6 w-6 rounded-full bg-gradient-to-br from-cyan-400 to-violet-500 mx-auto animate-spin" style={{ animationDuration: "12s" }} />
                                <span className="text-[10px] font-bold tracking-widest text-white/90 block uppercase">Sira Core UI Prototipo</span>
                                <span className="text-[8px] text-white/60 block leading-normal">Grid de datos reactiva & Dashboard AI</span>
                              </div>

                              <div className="absolute bottom-2.5 right-2.5 rounded-full border border-violet-500/30 bg-violet-950/80 px-2 py-0.5 text-[8px] font-bold text-violet-300 backdrop-blur-sm shadow-md">
                                ✨ Sira Art Engine — v3.0
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Input */}
                    <div className="border-t border-border/50 p-4 bg-muted/5">
                      <div className="flex flex-col gap-2 rounded-2xl border border-border bg-background p-2.5 shadow-lg">
                        <div className="flex items-center gap-2">
                          <input 
                            type="text" 
                            disabled
                            placeholder="Pregunta cualquier cosa a GPT-5.5, Claude 4.7..." 
                            className="text-xs sm:text-sm bg-transparent flex-1 focus:outline-none border-none text-muted-foreground px-2"
                          />
                        </div>
                        <div className="flex items-center justify-between border-t border-border/30 pt-2 px-1">
                          <div className="flex items-center gap-1">
                            <div className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
                              <Paperclip className="h-4 w-4" />
                            </div>
                            <div className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
                              <ImageIcon className="h-4 w-4" />
                            </div>
                            <div className="hidden sm:flex items-center gap-1.5 ml-2 border-l border-border/50 pl-3">
                              <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-[10px] font-medium text-muted-foreground">Búsqueda Web</span>
                              <div className="h-4 w-7 rounded-full bg-violet-600 p-0.5 cursor-pointer">
                                <div className="h-3 w-3 rounded-full bg-white ml-3" />
                              </div>
                            </div>
                          </div>
                          
                          <div className="h-8 w-8 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 flex items-center justify-center text-white shadow-md shadow-violet-600/20 hover:scale-105 cursor-pointer transition-transform">
                            <Send className="h-3.5 w-3.5" />
                          </div>
                        </div>
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
