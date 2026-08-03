"use client"

import * as React from "react"
import {
  CheckCircle2,
  FolderGit2,
  GitBranch,
  Globe,
  MoreHorizontal,
  Monitor,
  PanelLeft,
  Plus,
  Search,
  Terminal,
  UserPlus,
  X,
} from "lucide-react"

import UpgradeModal from "@/components/UpgradeModal"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAuth } from "@/lib/auth-context-integrated"
import { cn } from "@/lib/utils"
import { ProjectChip } from "./project-chip"

export type WorkspacePanelId = "preview" | "terminal" | "git" | "validation"

type PanelDef = {
  id: WorkspacePanelId
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const PANELS: PanelDef[] = [
  { id: "preview", label: "Preview", icon: Monitor },
  { id: "terminal", label: "Shell", icon: Terminal },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "validation", label: "Validation", icon: CheckCircle2 },
]

const isFreePlan = (plan?: string | null) =>
  String(plan || "FREE").trim().toUpperCase() === "FREE"

export type WorkspaceTopBarProps = {
  openPanels: Set<WorkspacePanelId>
  activePanel: WorkspacePanelId | null
  onTogglePanel: (id: WorkspacePanelId) => void
  onClosePanel: (id: WorkspacePanelId) => void
  /** Tool opened from the picker (Database, Secrets…) shown as its own tab. */
  toolTab?: {
    label: string
    icon: React.ComponentType<{ className?: string }>
  } | null
  toolTabActive?: boolean
  onFocusToolTab?: () => void
  onCloseToolTab?: () => void
  /** Replit-style "Nueva pestaña" picker tab (open while the picker shows). */
  newTabOpen?: boolean
  onCloseNewTab?: () => void
  toolsMenu?: React.ReactNode
  onOpenTools?: () => void
  onOpenSearch: () => void
  onOpenInvite: () => void
  inviteOpen?: boolean
  onOpenCode: () => void
  codeOpen?: boolean
  onOpenPublishing: () => void
  publishingOpen?: boolean
  onToggleChat: () => void
}

/**
 * Replit-style global header, single row: project identity + Upgrade on the
 * left, the workspace panel tabs (+ tool opener) at Publicar's height in the
 * middle, and the search / Código / Invitar / Publicar cluster + chat toggle
 * on the right. No second tab row — the main pane starts right below.
 */
export function WorkspaceTopBar({
  openPanels,
  activePanel,
  onTogglePanel,
  onClosePanel,
  toolTab,
  toolTabActive,
  onFocusToolTab,
  onCloseToolTab,
  newTabOpen,
  onCloseNewTab,
  toolsMenu,
  onOpenTools,
  onOpenSearch,
  onOpenInvite,
  inviteOpen,
  onOpenCode,
  codeOpen,
  onOpenPublishing,
  publishingOpen,
  onToggleChat,
}: WorkspaceTopBarProps) {
  const { user } = useAuth()
  const [upgradeOpen, setUpgradeOpen] = React.useState(false)
  const visible = PANELS.filter((p) => openPanels.has(p.id))
  const ToolTabIcon = toolTab?.icon
  const showUpgrade = Boolean(user && isFreePlan(user.plan))

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-1.5 sm:gap-2 sm:px-2.5">
      <ProjectChip onOpenCode={onOpenCode} />
      {showUpgrade ? (
        <button
          type="button"
          className="hidden h-6 shrink-0 items-center justify-center gap-0.5 rounded-md bg-[#0f87ff] px-2 text-[11px] font-semibold text-white transition-colors hover:bg-[#0c74dd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f87ff]/50 focus-visible:ring-offset-2 sm:flex"
          title="Ver planes y precios"
          aria-label="Ver planes y precios"
          aria-haspopup="dialog"
          onClick={() => setUpgradeOpen(true)}
        >
          <Plus className="h-3 w-3" strokeWidth={2.5} />
          <span>Upgrade</span>
        </button>
      ) : null}

      {/* Panel tabs — sit in the header itself (Publicar height), roughly
          above where the main pane begins. */}
      <div className="workspace-tab-strip ml-[6%] hidden min-w-0 items-center gap-1 overflow-x-auto sm:flex">
        {visible.map((panel) => {
          const Icon = panel.icon
          const active = activePanel === panel.id
          return (
            <div
              key={panel.id}
              className={cn(
                "group flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors",
                active
                  ? "border-border/70 bg-background text-foreground shadow-sm"
                  : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5"
                onClick={() => onTogglePanel(panel.id)}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{panel.label}</span>
              </button>
              <button
                type="button"
                className={cn(
                  "rounded p-0.5 transition-opacity hover:bg-muted",
                  active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
                )}
                aria-label={`Cerrar ${panel.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onClosePanel(panel.id)
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
        {toolTab && ToolTabIcon ? (
          <div
            className={cn(
              "group flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors",
              toolTabActive
                ? "border-border/70 bg-background text-foreground shadow-sm"
                : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5"
              onClick={onFocusToolTab}
            >
              <ToolTabIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{toolTab.label}</span>
            </button>
            <button
              type="button"
              className={cn(
                "rounded p-0.5 transition-opacity hover:bg-muted",
                toolTabActive ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
              )}
              aria-label={`Cerrar ${toolTab.label}`}
              onClick={(e) => {
                e.stopPropagation()
                onCloseToolTab?.()
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : null}
        {newTabOpen ? (
          <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2.5 text-[12px] text-foreground shadow-sm">
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Nueva pestaña</span>
            <button
              type="button"
              className="rounded p-0.5 opacity-60 transition-opacity hover:bg-muted hover:opacity-100"
              aria-label="Cerrar nueva pestaña"
              onClick={onCloseNewTab}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : null}
        {toolsMenu ?? null}
      </div>

      <span className="min-w-0 flex-1" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 shrink-0 rounded-md text-muted-foreground hover:text-foreground sm:hidden"
            aria-label="Más acciones del workspace"
          >
            <MoreHorizontal className="h-5 w-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60 rounded-lg border-border/70 p-1.5 sm:hidden">
          <DropdownMenuItem className="min-h-11 gap-3 rounded-md px-3" onSelect={onOpenSearch}>
            <Search className="h-4 w-4 text-muted-foreground" />
            Buscar
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11 gap-3 rounded-md px-3" onSelect={onOpenCode}>
            <FolderGit2 className="h-4 w-4 text-muted-foreground" />
            Código del proyecto
          </DropdownMenuItem>
          {onOpenTools ? (
            <DropdownMenuItem className="min-h-11 gap-3 rounded-md px-3" onSelect={onOpenTools}>
              <Plus className="h-4 w-4 text-muted-foreground" />
              Herramientas
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem className="min-h-11 gap-3 rounded-md px-3" onSelect={onOpenInvite}>
            <UserPlus className="h-4 w-4 text-muted-foreground" />
            Invitar
          </DropdownMenuItem>
          {showUpgrade ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="min-h-11 gap-3 rounded-md px-3 font-medium text-[#0878e8] focus:text-[#0878e8]"
                onSelect={() => setUpgradeOpen(true)}
              >
                <Plus className="h-4 w-4" />
                Ver planes y precios
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="hidden h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground sm:inline-flex"
        aria-label="Buscar"
        onClick={onOpenSearch}
      >
        <Search className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Código del proyecto"
        title="Código del proyecto"
        aria-pressed={codeOpen}
        onClick={onOpenCode}
        className={cn(
          "hidden h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground sm:inline-flex",
          codeOpen && "bg-muted/70 text-foreground",
        )}
      >
        <FolderGit2 className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Invitar miembro al workspace"
        aria-pressed={inviteOpen}
        onClick={onOpenInvite}
        className={cn(
          "hidden h-7 shrink-0 rounded-md px-2.5 text-[11px] font-medium transition-colors sm:inline-flex",
          inviteOpen
            ? "bg-muted/70 text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <UserPlus className="mr-1 h-3 w-3" />
        <span>Invitar</span>
      </Button>
      <button
        type="button"
        aria-label="Publicar el proyecto"
        title="Publicar el proyecto"
        aria-pressed={publishingOpen}
        onClick={onOpenPublishing}
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center gap-1.5 rounded-md px-0 text-[11px] font-semibold transition-colors sm:h-7 sm:w-auto sm:px-3",
          "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white",
        )}
      >
        <Globe className="h-4 w-4 sm:h-3 sm:w-3" />
        <span className="hidden sm:inline">Publicar</span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-10 w-10 shrink-0 rounded-md text-muted-foreground hover:text-foreground sm:h-7 sm:w-7"
        aria-label="Mostrar u ocultar el chat del agente"
        title="Mostrar u ocultar el chat"
        onClick={onToggleChat}
      >
        <PanelLeft className="h-5 w-5 sm:h-3.5 sm:w-3.5" />
      </Button>
      {showUpgrade ? (
        <UpgradeModal
          open={upgradeOpen}
          onOpenChange={setUpgradeOpen}
          user={user}
        />
      ) : null}
    </header>
  )
}
