"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * Contador suave de caracteres del composer.
 *
 * No hay límite duro en el textarea — el contador aparece sólo cuando
 * el usuario ya escribió bastante (>1500 chars) y cambia de color al
 * acercarse a 4000 (suave) o pasar 8000 (advertencia visible).
 *
 * Diseño deliberadamente discreto: chip pequeño en grises, sin borde,
 * tipografía tabular para que no "salte" al cambiar el ancho del número.
 * Vive dentro del cluster derecho del composer, junto al micrófono y al
 * botón de enviar.
 */
export function ComposerCharCounter({ input }: { input: string }) {
  const length = input.length
  const SOFT_HINT = 1500
  const SOFT_WARN = 4000
  const HARD_WARN = 8000

  if (length < SOFT_HINT) return null

  const formatted = length >= 1000
    ? `${(length / 1000).toFixed(1).replace(".0", "")}k`
    : String(length)

  return (
    <span
      aria-live="polite"
      aria-label={`${length} caracteres escritos`}
      className={cn(
        "select-none px-1.5 text-[11px] font-medium tabular-nums tracking-tight",
        "transition-colors duration-200",
        length >= HARD_WARN
          ? "text-amber-600 dark:text-amber-400"
          : length >= SOFT_WARN
            ? "text-foreground/70"
            : "text-muted-foreground/60",
      )}
    >
      {formatted}
    </span>
  )
}
