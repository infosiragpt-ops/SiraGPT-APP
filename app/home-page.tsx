"use client"

import { BrandLogo } from "@/components/BrandLogo"
import { LoginButton } from "@/components/AuthNavButtons"
import { ThemeToggle } from "@/components/theme-toggle"
import { useEffect } from "react"
import { motion } from "framer-motion"
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Code2,
  CreditCard,
  Headphones,
  Layers3,
  Search,
  Sparkles,
} from "lucide-react"
import Link from "next/link"

const providers = [
  { name: "OpenAI", detail: "Modelos GPT", icon: Bot },
  { name: "Gemini", detail: "Google AI", icon: Sparkles },
  { name: "Claude", detail: "Anthropic", icon: BrainCircuit },
  { name: "DeepSeek", detail: "Razonamiento", icon: Search },
  { name: "Stripe", detail: "Pagos", icon: CreditCard },
  { name: "Replit", detail: "Apps", icon: Code2 },
  { name: "ElevenLabs", detail: "Voz", icon: Headphones },
  { name: "OpenClaw", detail: "Agentes", icon: Layers3 },
]

const highlights = [
  "Una cuenta para modelos, voz, agentes y pagos",
  "Interfaz limpia para trabajar desde móvil o escritorio",
  "Acento visual listo en #FF0000 para producción",
]

export default function HomePage() {
  useEffect(() => {
    const htmlEl = document.documentElement
    const bodyEl = document.body

    htmlEl.style.overflow = "auto"
    htmlEl.style.height = "auto"
    htmlEl.style.overscrollBehavior = "auto"

    bodyEl.style.overflow = "auto"
    bodyEl.style.height = "auto"
    bodyEl.style.overscrollBehavior = "auto"

    return () => {
      htmlEl.style.overflow = ""
      htmlEl.style.height = ""
      htmlEl.style.overscrollBehavior = ""

      bodyEl.style.overflow = ""
      bodyEl.style.height = ""
      bodyEl.style.overscrollBehavior = ""
    }
  }, [])

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-white text-neutral-950 dark:bg-neutral-950 dark:text-white">
      <header className="fixed top-0 z-50 w-full border-b border-neutral-200/80 bg-white/90 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/90">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-3 md:px-6 md:py-4">
          <BrandLogo />

          <motion.div
            className="flex items-center gap-2 md:gap-3"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.35 }}
          >
            <ThemeToggle />
            <LoginButton href="/auth/login" />
          </motion.div>
        </div>
      </header>

      <main className="sira-home-main relative min-h-screen">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(255,0,0,0.08) 0%, rgba(255,255,255,0) 34%), linear-gradient(rgba(15,23,42,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.045) 1px, transparent 1px)",
            backgroundSize: "auto, 88px 88px, 88px 88px",
          }}
        />

        <section className="sira-hero-section relative mx-auto flex min-h-screen w-full max-w-7xl px-5 py-12 md:px-8 md:py-16">
          <div className="grid w-full items-center gap-10 lg:grid-cols-2 lg:gap-12">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="mx-auto max-w-2xl text-center lg:mx-0 lg:text-left"
            >
              <div className="sira-badge inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                <span>Impulsado por IA de frontera</span>
              </div>

              <h1 className="mt-7 text-5xl font-black leading-none sm:text-6xl md:text-7xl lg:text-8xl">
                Sira GPT
              </h1>

              <p className="mt-6 text-lg leading-8 text-neutral-700 dark:text-neutral-300 md:text-xl">
                Una landing simple, profesional y minimalista para mostrar que la plataforma trabaja con los modelos y servicios clave de IA en una sola experiencia.
              </p>

              <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row lg:items-start">
                <Link
                  href="/auth/register"
                  className="sira-primary-cta inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full px-6 text-sm font-bold text-white transition duration-200 active:scale-95 sm:w-auto"
                >
                  Empezar ahora
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
                <Link
                  href="/auth/login"
                  className="sira-secondary-cta inline-flex min-h-12 w-full items-center justify-center rounded-full border border-neutral-300 bg-white px-6 text-sm font-bold text-neutral-950 transition duration-200 dark:border-white/20 dark:bg-white/5 dark:text-white sm:w-auto"
                >
                  Entrar
                </Link>
              </div>

              <div className="mt-8 grid gap-3 text-left">
                {highlights.map((item) => (
                  <div key={item} className="flex items-start gap-3 text-sm leading-6 text-neutral-700 dark:text-neutral-300">
                    <CheckCircle2 className="sira-red mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.08 }}
              className="relative mx-auto w-full max-w-3xl"
            >
              <div className="mb-5 text-center lg:text-left">
                <p className="sira-red text-xs font-black uppercase">Impulsado por</p>
                <h2 className="mt-3 text-2xl font-black leading-tight text-neutral-950 dark:text-white md:text-4xl">
                  OpenAI, Gemini, Claude, DeepSeek, Stripe, Replit, ElevenLabs y OpenClaw.
                </h2>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {providers.map(({ name, detail, icon: Icon }) => (
                  <div
                    key={name}
                    className="provider-card group flex min-h-24 items-center gap-4 rounded-lg border border-neutral-200 p-4 transition duration-200 dark:border-white/10"
                  >
                    <span className="provider-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border transition duration-200">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-lg font-black leading-tight text-neutral-950 dark:text-white">
                        {name}
                      </span>
                      <span className="mt-1 block text-sm leading-5 text-neutral-500 dark:text-neutral-400">
                        {detail}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        </section>

        <div aria-hidden className="sira-bottom-line h-1 w-full" />
      </main>

      <style jsx global>{`
        .sira-red {
          color: #ff0000;
        }

        .sira-home-main {
          padding-top: 88px !important;
        }

        .sira-hero-section {
          align-items: flex-start;
        }

        .sira-badge {
          color: #ff0000;
          border: 1px solid rgba(255, 0, 0, 0.2);
          background: rgba(255, 0, 0, 0.08);
          box-shadow: 0 14px 42px rgba(255, 0, 0, 0.12);
        }

        .sira-primary-cta {
          background: #ff0000;
          box-shadow: 0 18px 40px rgba(255, 0, 0, 0.24);
        }

        .sira-primary-cta:hover {
          background: #e60000;
        }

        .sira-primary-cta:focus-visible,
        .sira-secondary-cta:focus-visible {
          outline: 2px solid #ff0000;
          outline-offset: 4px;
        }

        .sira-secondary-cta:hover {
          color: #ff0000;
          border-color: rgba(255, 0, 0, 0.45);
        }

        .provider-card {
          background: rgba(255, 255, 255, 0.86);
          box-shadow: 0 12px 35px rgba(15, 23, 42, 0.06);
        }

        .provider-card:hover {
          border-color: rgba(255, 0, 0, 0.35);
          box-shadow: 0 18px 46px rgba(255, 0, 0, 0.1);
        }

        .provider-icon {
          color: #ff0000;
          border-color: rgba(255, 0, 0, 0.18);
          background: rgba(255, 0, 0, 0.08);
        }

        .provider-card:hover .provider-icon {
          color: #ffffff;
          background: #ff0000;
        }

        .sira-bottom-line {
          background: #ff0000;
        }

        :global(.dark) .provider-card {
          background: rgba(255, 255, 255, 0.045);
          box-shadow: none;
        }

        :global(.dark) .provider-card:hover {
          border-color: rgba(255, 0, 0, 0.5);
        }

        @media (min-width: 1024px) {
          .sira-home-main {
            padding-top: 80px !important;
          }

          .sira-hero-section {
            align-items: center;
          }
        }
      `}</style>
    </div>
  )
}
