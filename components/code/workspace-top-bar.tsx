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
  DropdownMenuLabel,
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
  const auxiliaryTabSelected = Boolean(newTabOpen || (toolTab && toolTabActive))

  const handleTabKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    const tablist = event.currentTarget.closest<HTMLElement>('[role="tablist"]')
    const tabs = Array.from(tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
    const currentIndex = tabs.indexOf(event.currentTarget)
    if (currentIndex < 0 || tabs.length === 0) return

    event.preventDefault()
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
    tabs[nextIndex]?.focus()
    tabs[nextIndex]?.click()
  }, [])

  return (
    <header className="flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-1.5 border-b border-border/60 bg-background px-1.5 pt-[env(safe-area-inset-top)] sm:px-2.5 lg:h-[calc(2.75rem+env(safe-area-inset-top))] lg:gap-2">
      <ProjectChip onOpenCode={onOpenCode} />
      {showUpgrade ? (
        <button
          type="button"
          className="hidden h-7 shrink-0 items-center gap-0.5 rounded-md bg-[#0f87ff] px-2 text-[11px] font-semibold text-white transition-colors hover:bg-[#0c74dd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f87ff]/50 focus-visible:ring-offset-2 lg:flex"
          title="Ver planes y precios"
          aria-label="Ver planes y precios"
          aria-haspopup="dialog"
          onClick={() => setUpgradeOpen(true)}
        >
          <Plus className="h-3 w-3" strokeWidth={2.5} />
          Upgrade
        </button>
      ) : null}

      {/* Panel tabs — sit in the header itself (Publicar height), roughly
          above where the main pane begins. */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 sm:gap-1">
        <div
          className="workspace-tab-strip flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label="Paneles del workspace"
        >
          {visible.map((panel, index) => {
            const Icon = panel.icon
            const selected = activePanel === panel.id && !auxiliaryTabSelected
            const tabbable = selected || (!activePanel && !auxiliaryTabSelected && index === 0)
            return (
              <div
                key={panel.id}
                className={cn(
                  "group flex h-8 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[12px] transition-colors sm:px-2.5 lg:h-7",
                  selected
                    ? "border-border/70 bg-background text-foreground shadow-sm"
                    : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={panel.label}
                  tabIndex={tabbable ? 0 : -1}
                  className="flex min-w-0 items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  onClick={() => onTogglePanel(panel.id)}
                  onKeyDown={handleTabKeyDown}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden truncate min-[390px]:inline">{panel.label}</span>
                </button>
                <button
                  type="button"
                  className={cn(
                    "rounded p-0.5 transition-opacity hover:bg-muted",
                    selected ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
                  )}
                  aria-label={`Cerrar ${panel.label}`}
                  tabIndex={selected ? 0 : -1}
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
                "group flex h-8 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[12px] transition-colors sm:px-2.5 lg:h-7",
                toolTabActive
                  ? "border-border/70 bg-background text-foreground shadow-sm"
                  : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={Boolean(toolTabActive)}
                aria-label={toolTab.label}
                tabIndex={toolTabActive ? 0 : -1}
                className="flex min-w-0 items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                onClick={onFocusToolTab}
                onKeyDown={handleTabKeyDown}
              >
                <ToolTabIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden truncate min-[390px]:inline">{toolTab.label}</span>
              </button>
              <button
                type="button"
                className={cn(
                  "rounded p-0.5 transition-opacity hover:bg-muted",
                  toolTabActive ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
                )}
                aria-label={`Cerrar ${toolTab.label}`}
                tabIndex={toolTabActive ? 0 : -1}
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
            <div className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-border/70 bg-background px-1.5 text-[12px] text-foreground shadow-sm sm:px-2.5 lg:h-7">
              <button
                type="button"
                role="tab"
                aria-selected="true"
                aria-label="Nueva pestaña"
                className="flex min-w-0 items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                onKeyDown={handleTabKeyDown}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden truncate min-[390px]:inline">Nueva pestaña</span>
              </button>
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
        </div>
        <div className="flex shrink-0 items-center">{toolsMenu ?? null}</div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 lg:gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="hidden h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground lg:inline-flex"
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
            "hidden h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground lg:inline-flex",
            codeOpen && "bg-muted/70 text-foreground",
          )}
        >
          <FolderGit2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Invitar miembro al workspace"
          aria-pressed={inviteOpen}
          onClick={onOpenInvite}
          className={cn(
            "hidden h-7 shrink-0 rounded-md px-2.5 text-[11px] font-medium transition-colors lg:inline-flex",
            inviteOpen
              ? "bg-muted/70 text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <UserPlus className="mr-1 h-3 w-3" />
          Invitar
        </Button>
        <button
          type="button"
          aria-label="Publicar el proyecto"
          aria-pressed={publishingOpen}
          onClick={onOpenPublishing}
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center gap-1.5 rounded-md text-[11px] font-semibold transition-colors lg:h-7 lg:w-auto lg:px-3",
            "bg-zinc-900 text-white hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white",
          )}
        >
          <Globe className="h-3.5 w-3.5 lg:h-3 lg:w-3" />
          <span className="hidden lg:inline">Publicar</span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="hidden h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground lg:inline-flex"
          aria-label="Mostrar u ocultar el chat del agente"
          title="Mostrar u ocultar el chat"
          onClick={onToggleChat}
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 shrink-0 rounded-md text-muted-foreground hover:text-foreground lg:hidden"
              aria-label="Más acciones del workspace"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60 rounded-xl border-border/70 p-1.5 lg:hidden">
            <DropdownMenuLabel className="px-2 py-1 text-[11px] font-normal text-muted-foreground">
              Acciones del workspace
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="min-h-11 gap-2.5 rounded-lg" onClick={onOpenSearch}>
              <Search className="h-4 w-4 text-muted-foreground" />
              Buscar
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-11 gap-2.5 rounded-lg" onClick={onOpenCode}>
              <FolderGit2 className="h-4 w-4 text-muted-foreground" />
              Código del proyecto
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-11 gap-2.5 rounded-lg" onClick={onOpenInvite}>
              <UserPlus className="h-4 w-4 text-muted-foreground" />
              Invitar miembro
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-11 gap-2.5 rounded-lg" onClick={onToggleChat}>
              <PanelLeft className="h-4 w-4 text-muted-foreground" />
              Mostrar u ocultar agente
            </DropdownMenuItem>
            {showUpgrade ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="min-h-11 gap-2.5 rounded-lg font-medium text-[#0f87ff]"
                  onClick={() => setUpgradeOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  Mejorar plan
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
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
