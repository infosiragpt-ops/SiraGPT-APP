"use client"

import * as React from "react"
import { motion } from "framer-motion"
import type { LucideIcon } from "lucide-react"
import {
  Code2,
  FileText,
  ImageIcon,
  Lightbulb,
  PenLine,
  Search,
  Sparkles,
} from "lucide-react"

import { cn } from "@/lib/utils"

type ExamplePrompt = {
  label: string
  prompt: string
  icon: LucideIcon
}

const EXAMPLE_PROMPTS: ExamplePrompt[] = [
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
]

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
        {EXAMPLE_PROMPTS.map((item, index) => (
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
              "transition-all duration-[var(--duration-base,220ms)] ease-[var(--ease-out-smooth,cubic-bezier(0.22,1,0.36,1))]",
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
    </motion.div>
  )
}

export default ChatEmptyStateHero
