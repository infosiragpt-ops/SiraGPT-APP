"use client"

/**
 * KeyboardShortcutsModal — small help overlay listing the global keyboard
 * shortcuts available in the chat interface. Opened via Cmd/Ctrl + / from
 * anywhere in the chat surface (the global listener is wired in
 * chat-interface-enhanced.tsx).
 *
 * The modal itself relies on the shadcn Dialog primitive which already
 * provides:
 *   - role="dialog" + aria-modal
 *   - focus trap + focus restoration
 *   - Escape-to-close
 * so this component just renders the descriptive content.
 */

import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

export interface ShortcutDescriptor {
  /** Pre-formatted keys to render. Each entry is rendered in a <kbd>. */
  keys: string[]
  /** Human-readable description (Spanish, matching the rest of the UI). */
  description: string
}

export const CHAT_KEYBOARD_SHORTCUTS: ShortcutDescriptor[] = [
  { keys: ["Enter"], description: "Enviar mensaje" },
  { keys: ["⌘/Ctrl", "Enter"], description: "Enviar mensaje (alternativo)" },
  { keys: ["Shift", "Enter"], description: "Nueva línea en el mensaje" },
  { keys: ["⌘/Ctrl", "K"], description: "Enfocar búsqueda" },
  { keys: ["/"], description: "Abrir menú de comandos" },
  { keys: ["↑"], description: "Editar último mensaje (composer vacío)" },
  { keys: ["Esc"], description: "Cerrar herramientas / cancelar / desenfocar" },
  { keys: ["⌘/Ctrl", "/"], description: "Mostrar esta ayuda" },
  { keys: ["?"], description: "Mostrar esta ayuda (alternativo)" },
]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  shortcuts?: ShortcutDescriptor[]
}

export default function KeyboardShortcutsModal({
  open,
  onOpenChange,
  shortcuts = CHAT_KEYBOARD_SHORTCUTS,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Atajos de teclado</DialogTitle>
          <DialogDescription>
            Atajos disponibles en la interfaz de chat.
          </DialogDescription>
        </DialogHeader>
        <ul className="mt-2 divide-y divide-border/40">
          {shortcuts.map((s, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-4 py-2 text-sm"
            >
              <span className="text-foreground">{s.description}</span>
              <span className="flex items-center gap-1">
                {s.keys.map((k, idx) => (
                  <React.Fragment key={idx}>
                    {idx > 0 && (
                      <span className="text-xs text-muted-foreground">+</span>
                    )}
                    <kbd className="rounded-md border border-border/60 bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground shadow-sm">
                      {k}
                    </kbd>
                  </React.Fragment>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
