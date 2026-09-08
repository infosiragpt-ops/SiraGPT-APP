"use client"

import * as React from "react"
import { Check, Eye, Folder, Lock, Shield, ShieldAlert, type LucideIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  type ComposerPermissionId,
  readComposerPermission,
  writeComposerPermission,
} from "@/lib/chat/composer-session"
import { cn } from "@/lib/utils"

const LEVELS: Array<{
  id: ComposerPermissionId
  label: string
  description: string
  icon: LucideIcon
}> = [
  {
    id: "default",
    label: "Default",
    description: "Seguir la política configurada del agente.",
    icon: Shield,
  },
  {
    id: "read",
    label: "Solo lectura",
    description: "Lectura dentro de la raíz de la sesión; se bloquean las escrituras y los comandos.",
    icon: Eye,
  },
  {
    id: "protected",
    label: "Protegido",
    description: "Sin tools de escritura hasta que exista un revisor de aprobación.",
    icon: Lock,
  },
  {
    id: "workspace",
    label: "Workspace",
    description: "La computadora sigue acotada a /workspace de esta conversación.",
    icon: Folder,
  },
  {
    id: "full",
    label: "Acceso completo",
    description: "Sin revisor; los archivos y comandos no tienen restricciones extra.",
    icon: ShieldAlert,
  },
]

export function ComposerPermissionMenu() {
  const [open, setOpen] = React.useState(false)
  const [level, setLevel] = React.useState<ComposerPermissionId>("full")

  React.useEffect(() => {
    setLevel(readComposerPermission())
  }, [])

  const active = LEVELS.find((row) => row.id === level) || LEVELS[4]
  const Icon = active.icon

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="composer-permission-chip"
          data-level={active.id}
          aria-label={`Permisos: ${active.label}`}
          title={active.label}
          className={cn("composer-permission-chip", `is-${active.id}`)}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        forceMount
        hidden={!open}
        align="start"
        side="top"
        sideOffset={8}
        className="composer-permission-menu w-[min(calc(100vw-1.5rem),22rem)] p-2"
      >
        <p className="composer-permission-menu-kicker">Permisos</p>
        <ul className="flex flex-col gap-0.5">
          {LEVELS.map((row, index) => {
            const RowIcon = row.icon
            const selected = row.id === level
            return (
              <li key={row.id}>
                <button
                  type="button"
                  data-testid="composer-permission-option"
                  data-permission-level={row.id}
                  className={cn("composer-permission-row", selected && "is-selected")}
                  onClick={() => {
                    setLevel(row.id)
                    writeComposerPermission(row.id)
                    setOpen(false)
                  }}
                >
                  <RowIcon className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.8} />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block text-[13px] font-medium text-foreground">{row.label}</span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">
                      {row.description}
                    </span>
                  </span>
                  <span className="flex w-8 shrink-0 items-center justify-end gap-1 text-[11px] text-muted-foreground">
                    {selected ? <Check className="h-3.5 w-3.5 text-foreground" strokeWidth={2.2} /> : null}
                    {index + 1}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
