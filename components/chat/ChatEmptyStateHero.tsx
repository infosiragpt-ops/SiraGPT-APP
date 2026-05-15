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
  Sparkles,
  Table,
} from "lucide-react"

import { cn } from "@/lib/utils"

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
  // Fisher–Yates shuffle for an unbiased sample. Six is the grid
  // (3 columns × 2 rows on desktop, 2 × 3 on mobile).
  const a = [...PROMPT_POOL]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, 6)
}

function pickGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 6) return "Buenas noches"
  if (hour < 13) return "Buenos días"
  if (hour < 20) return "Buenas tardes"
  return "Buenas noches"
}

function pickDisplayName(userName?: string | null): string | null {
  if (!userName) return null
  const trimmed = userName.trim()
  if (!trimmed) return null
  const first = trimmed.split(/\s+/)[0]
  if (!first || first.length > 24) return null
  return first
}

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

      <h1 className="mb-2 text-center text-[28px] font-semibold tracking-[-0.022em] text-foreground sm:text-[34px] md:text-[40px]">
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

      <p className="mx-auto mb-8 max-w-md text-center text-[15px] leading-relaxed text-muted-foreground">
        ¿En qué te puedo ayudar hoy?
      </p>

      <div className="mx-auto grid w-full max-w-2xl grid-cols-2 gap-2 sm:grid-cols-3">
        {prompts.map((item, index) => (
          <motion.button
            key={item.label}
            type="button"
            onClick={() => onSelectPrompt(item.prompt)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.4,
              delay: 0.08 + index * 0.04,
              ease: [0.22, 1, 0.36, 1],
            }}
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
          </motion.button>
        ))}
      </div>

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
