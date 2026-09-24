"use client"

import * as React from "react"
import { Zap } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { readComposerFastMode, writeComposerFastMode } from "@/lib/chat/composer-session"
import { cn } from "@/lib/utils"

/**
 * Lightning toggle on the composer toolbar: "Modo rápido" answers with the
 * plain stream (no agentic loop). Reasoning effort moved to the foot of the
 * model menu, so this control is a single pressed/unpressed switch.
 */
export function ComposerFastModeToggle() {
  const [fast, setFast] = React.useState(false)

  React.useEffect(() => {
    setFast(readComposerFastMode())
  }, [])

  const label = fast ? "Modo rápido activado" : "Modo rápido desactivado"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="composer-fast-toggle"
          aria-pressed={fast}
          aria-label={label}
          className={cn("composer-effort-chip composer-fast-toggle", fast && "is-on")}
          onClick={() => {
            const next = !fast
            setFast(next)
            writeComposerFastMode(next)
          }}
        >
          <Zap
            className="h-3.5 w-3.5 shrink-0"
            strokeWidth={2.2}
            fill={fast ? "currentColor" : "none"}
            aria-hidden
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} className="max-w-[15rem] text-center">
        <span className="block font-medium">Modo rápido</span>
        <span className="block text-[11.5px] opacity-80">
          {fast ? "Activado: responde directo, sin herramientas." : "Actívalo para respuestas directas, sin herramientas."}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
