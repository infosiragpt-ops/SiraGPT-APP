"use client"

import * as React from "react"
import { motion } from "framer-motion"
import type { LucideIcon } from "lucide-react"
import {
  BarChart3,
  Calculator,
  Code2,
  FileText,
  ImageIcon,
  Languages,
  Lightbulb,
  ListChecks,
  PenLine,
  Presentation,
  Search,
  Settings2,
  Sparkles,
  Table,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { pickDisplayName, pickGreeting, sampleSixFromPool } from "@/lib/hero-presentation"

type ExamplePrompt = {
  label: string
  prompt: string
  icon: LucideIcon
}

// Pool of prompts the hero rotates through. The render code samples
// 6 from this list per mount so the surface feels alive instead of
// the same fixed grid every session. Order is stable within a single
// page view but reshuffles on next mount (new chat / page reload).
const PROMPT_POOL: ExamplePrompt[] = [
  {
    label: "Resumir un documento",
    prompt: "Adjunta o pega aquí un documento y pídeme un resumen ejecutivo con los puntos clave, recomendaciones y próximos pasos.",
    icon: FileText,
  },
  {
    label: "Generar una imagen",
    prompt: "Genera una imagen fotorrealista de ",
    icon: ImageIcon,
  },
  {
    label: "Explicar código",
    prompt: "Explícame este código paso a paso y sugiéreme mejoras: ",
    icon: Code2,
  },
  {
    label: "Buscar en la web",
    prompt: "Busca en la web información reciente sobre ",
    icon: Search,
  },
  {
    label: "Redactar un email",
    prompt: "Redacta un email profesional para ",
    icon: PenLine,
  },
  {
    label: "Lluvia de ideas",
    prompt: "Ayúdame con una lluvia de ideas para ",
    icon: Lightbulb,
  },
  {
    label: "Traducir al inglés",
    prompt: "Traduce el siguiente texto al inglés manteniendo el tono y los matices: ",
    icon: Languages,
  },
  {
    label: "Comparar opciones",
    prompt: "Compara estas opciones en una tabla con criterios claros y una recomendación final: ",
    icon: Table,
  },
  {
    label: "Crear presentación",
    prompt: "Genera una presentación profesional con 10 diapositivas sobre ",
    icon: Presentation,
  },
  {
    label: "Analizar datos",
    prompt: "Analiza estos datos, genera un resumen ejecutivo y propón visualizaciones recomendadas: ",
    icon: BarChart3,
  },
  {
    label: "Resolver matemáticas",
    prompt: "Resuelve este problema matemático paso a paso, mostrando el razonamiento: ",
    icon: Calculator,
  },
  {
    label: "Plan de tareas",
    prompt: "Convierte esta meta en un plan de tareas accionables con prioridades y fechas: ",
    icon: ListChecks,
  },
]

function sampleSixPrompts(): ExamplePrompt[] {
  return sampleSixFromPool(PROMPT_POOL)
}

const ONBOARDING_STORAGE_KEY = "siragpt:chat-onboarding:v1"

interface ChatEmptyStateHeroProps {
  userName?: string | null
  onSelectPrompt: (prompt: string) => void
  className?: string
}

export function ChatEmptyStateHero({
  userName,
  onSelectPrompt,
  className,
}: ChatEmptyStateHeroProps) {
  const greeting = React.useMemo(pickGreeting, [])
  const firstName = React.useMemo(() => pickDisplayName(userName), [userName])
  // Sample once per mount: stable while the user is reading the hero,
  // re-randomised when they navigate back. `useMemo` with an empty
  // dep array gives us per-mount stability without re-rendering on
  // every keystroke in the composer below.
  const prompts = React.useMemo(sampleSixPrompts, [])
  const [completedSteps, setCompletedSteps] = React.useState<Record<string, boolean>>({})

  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(ONBOARDING_STORAGE_KEY)
      if (saved) setCompletedSteps(JSON.parse(saved))
    } catch {
      // The checklist is an enhancement; a blocked localStorage must never
      // prevent the chat composer from rendering.
    }
  }, [])

  const completeStep = React.useCallback((step: string) => {
    setCompletedSteps((current) => {
      const next = { ...current, [step]: true }
      try {
        window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Keep the optimistic UI state even when storage is unavailable.
      }
      return next
    })
  }, [])

  const handlePromptSelect = React.useCallback((prompt: string) => {
    completeStep("first-prompt")
    onSelectPrompt(prompt)
  }, [completeStep, onSelectPrompt])

  const onboardingSteps = [
    {
      id: "first-prompt",
      label: "Envía tu primer mensaje",
      action: () => handlePromptSelect("Ayúdame a organizar mi semana en un plan claro y realista."),
      icon: Sparkles,
    },
    {
      id: "personalize",
      label: "Personaliza tus respuestas",
      href: "/settings?s=personalization",
      onClick: () => completeStep("personalize"),
      icon: Settings2,
    },
    {
      id: "code",
      label: "Prueba el espacio de código",
      href: "/code",
      onClick: () => completeStep("code"),
      icon: Code2,
    },
  ]
  const completedCount = onboardingSteps.filter((step) => completedSteps[step.id]).length
  const onboardingComplete = completedCount === onboardingSteps.length

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className={cn("w-full pb-6", className)}
    >
      <div className="mb-6 flex items-center justify-center gap-2 text-muted-foreground">
        <span
          aria-hidden
          className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/15 via-fuchsia-500/15 to-pink-500/15 ring-1 ring-foreground/[0.06] dark:ring-white/[0.06]"
        >
          <Sparkles className="h-3.5 w-3.5 text-foreground/70" strokeWidth={1.75} />
        </span>
        <span className="text-xs font-medium tracking-wide">Sira GPT</span>
      </div>

      <h1 className="mb-2 text-center text-[22px] font-semibold tracking-[-0.022em] text-foreground xs:text-[24px] sm:text-[34px] md:text-[40px] break-words px-2">
        {firstName ? (
          <>
            {greeting},{" "}
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500">
              {firstName}
            </span>
          </>
        ) : (
          greeting
        )}
      </h1>

      <p className="mx-auto mb-6 sm:mb-8 max-w-md text-center text-[14px] sm:text-[15px] leading-relaxed text-muted-foreground px-4">
        ¿En qué te puedo ayudar hoy?
      </p>

      <div className="mx-auto grid w-full max-w-2xl grid-cols-2 gap-2 sm:grid-cols-3 px-2">
        {/* Plain buttons on purpose: per-chip framer animations froze at
            their initial state (opacity 0) when mounted inside the chat
            canvas, leaving an invisible grid. The parent motion.div already
            fades the whole hero in; the chips ride that entrance. */}
        {prompts.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => handlePromptSelect(item.prompt)}
            className={cn(
              "group flex items-center gap-2 rounded-2xl border border-border/60 bg-card/60 px-3 py-2.5 text-left",
              "shadow-[0_1px_2px_rgba(15,23,42,0.03)] dark:shadow-none",
              "transition-all duration-base ease-smooth",
              "hover:border-border hover:bg-accent/60 hover:shadow-[0_2px_6px_rgba(15,23,42,0.06)] hover:-translate-y-[1px]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "active:translate-y-0",
            )}
          >
            <span
              aria-hidden
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground transition-colors duration-200 group-hover:bg-foreground/10 group-hover:text-foreground"
            >
              <item.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
            </span>
            <span className="truncate text-[13px] font-medium text-foreground/85 group-hover:text-foreground">
              {item.label}
            </span>
          </button>
        ))}
      </div>

      {!onboardingComplete && (
        <section
          aria-label="Primeros pasos"
          className="mx-auto mt-6 w-full max-w-2xl rounded-2xl border border-border/55 bg-muted/20 p-3 sm:p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-foreground">Primeros pasos</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {completedCount} de {onboardingSteps.length} completados
              </p>
            </div>
            <div
              aria-label={`${completedCount} de ${onboardingSteps.length} pasos completados`}
              className="h-1.5 w-20 overflow-hidden rounded-full bg-border/50"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={onboardingSteps.length}
              aria-valuenow={completedCount}
            >
              <div
                className="h-full rounded-full bg-foreground/70 transition-[width] duration-300"
                style={{ width: `${(completedCount / onboardingSteps.length) * 100}%` }}
              />
            </div>
          </div>
          <div className="grid gap-1 sm:grid-cols-3">
            {onboardingSteps.map((step) => {
              const done = Boolean(completedSteps[step.id])
              const content = (
                <>
                  <span className={cn(
                    "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                    done ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-background text-muted-foreground",
                  )}>
                    {done ? <span aria-hidden>✓</span> : <step.icon className="h-3.5 w-3.5" strokeWidth={1.8} />}
                  </span>
                  <span className={cn("truncate text-[12px] font-medium", done && "text-muted-foreground line-through")}>
                    {step.label}
                  </span>
                </>
              )

              if (step.href) {
                return (
                  <a
                    key={step.id}
                    href={step.href}
                    onClick={step.onClick}
                    className="group flex min-w-0 items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
                  >
                    {content}
                  </a>
                )
              }
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={step.action}
                  className="group flex min-w-0 items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
                >
                  {content}
                </button>
              )
            })}
          </div>
        </section>
      )}

      {/* Discoverability hint — quiet line under the prompt grid that
          surfaces the most useful global shortcut (⌘K / Ctrl+K opens
          the chat search). Tailwind's `kbd` lookalike style keeps it
          legible without competing with the hero. */}
      <p className="mt-6 flex items-center justify-center gap-1.5 text-[11.5px] text-muted-foreground">
        <span>Buscar chats</span>
        <kbd className="inline-flex h-5 items-center rounded-md border border-border/55 bg-muted/40 px-1.5 font-mono text-[10.5px] font-medium tracking-wide text-foreground/75">
          ⌘K
        </kbd>
      </p>
    </motion.div>
  )
}

export default ChatEmptyStateHero
