"use client"

import * as React from "react"
import {
  FolderGit2,
  Globe,
  Menu,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Square,
  UserPlus,
} from "lucide-react"

import UpgradeModal from "@/components/UpgradeModal"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAuth } from "@/lib/auth-context-integrated"
import { cn } from "@/lib/utils"
import {
  CODE_PREVIEW_STATE_EVENT,
  CODE_RUNNER_ACTIVE_EVENT,
  getActiveHostRunId,
  setActiveHostRunId,
  type CodePreviewState,
} from "@/lib/code-workspace-context"
import { hostRunnerService } from "@/lib/code-runner/host-runner-service"
import { CODE_OPEN_DEPT_DRAWER_EVENT, useDeptChatChrome } from "./dept-chat-bard"
import { DesktopMonitorGlyph } from "./department-computer-pane"

export type WorkspacePanelId = "preview" | "terminal" | "git" | "validation"

export type WorkspaceTopBarProps = {
  openPanels: Set<WorkspacePanelId>
  onTogglePanel: (id: WorkspacePanelId) => void
  toolsMenu?: React.ReactNode
  onOpenSearch: () => void
  onOpenInvite: () => void
  onOpenCode: () => void
  codeOpen?: boolean
  onOpenPublishing: () => void
  publishingOpen?: boolean
  onToggleChat: () => void
  departmentComputer?: { id: string; name: string } | null
  onOpenDepartmentComputer?: () => void
  computerOpen?: boolean
}

const TOOLBAR_ICON =
  "inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground active:bg-muted active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40"

/**
 * Slim professional workspace header. The green Ejecutar / Arrancando play
 * button is intentionally absent from the DOM — run lives in the overflow ⋯.
 */
export function WorkspaceTopBar({
  openPanels,
  onTogglePanel,
  toolsMenu,
  onOpenSearch,
  onOpenInvite,
  onOpenCode,
  codeOpen,
  onOpenPublishing,
  publishingOpen,
  onToggleChat: _onToggleChat,
  departmentComputer,
  onOpenDepartmentComputer,
  computerOpen = false,
}: WorkspaceTopBarProps) {
  const deptChatChrome = useDeptChatChrome()
  const { user } = useAuth()
  const [upgradeOpen, setUpgradeOpen] = React.useState(false)
  const showUpgrade = Boolean(user && String(user.plan || "FREE").trim().toUpperCase() === "FREE")
  const computerLabel = departmentComputer
    ? `Computadora de ${departmentComputer.name}`
    : "Computadora del departamento"
  const [previewPhase, setPreviewPhase] = React.useState<CodePreviewState["phase"]>("idle")
  const [hostRunId, setHostRunId] = React.useState<string | null>(() => getActiveHostRunId())

  React.useEffect(() => {
    const onPreview = (event: Event) => {
      const phase = (event as CustomEvent<CodePreviewState>).detail?.phase
      if (phase) setPreviewPhase(phase)
    }
    const onRun = (event: Event) => {
      setHostRunId((event as CustomEvent<{ runId: string | null }>).detail?.runId ?? null)
    }
    window.addEventListener(CODE_PREVIEW_STATE_EVENT, onPreview)
    window.addEventListener(CODE_RUNNER_ACTIVE_EVENT, onRun)
    return () => {
      window.removeEventListener(CODE_PREVIEW_STATE_EVENT, onPreview)
      window.removeEventListener(CODE_RUNNER_ACTIVE_EVENT, onRun)
    }
  }, [])

  const running = previewPhase === "starting" || previewPhase === "ready" || Boolean(hostRunId)
  const runLabel =
    previewPhase === "starting" ? "Arrancando…" : running ? "Detener la app" : "Ejecutar la app"

  const handleRunStop = React.useCallback(() => {
    if (running) {
      window.dispatchEvent(new CustomEvent("siragpt:code-stop-app"))
      const id = getActiveHostRunId()
      if (id) {
        void hostRunnerService.stop(id)
        setActiveHostRunId(null)
      }
      setPreviewPhase("idle")
      setHostRunId(null)
      return
    }
    onTogglePanel("preview")
    window.dispatchEvent(new CustomEvent("siragpt:code-run-app"))
  }, [onTogglePanel, running])

  return (
    <header
      className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-2.5"
      data-testid="workspace-top-bar"
      data-header-clean="20260815"
      data-drop-dup-header="20260815"
      data-empresas-no-run-button="1"
    >
      {deptChatChrome ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={TOOLBAR_ICON}
          aria-label="Abrir menú de departamentos"
          title="Departamentos"
          data-testid="dept-chat-hamburger"
          onClick={() => window.dispatchEvent(new CustomEvent(CODE_OPEN_DEPT_DRAWER_EVENT))}
        >
          <Menu className="h-3.5 w-3.5" />
        </Button>
      ) : null}

      {showUpgrade ? (
        <button
          type="button"
          className="flex h-7 shrink-0 items-center gap-0.5 rounded-md bg-[#0f87ff] px-2 text-[11px] font-semibold text-white transition-colors hover:bg-[#0c74dd] active:bg-[#0a68c6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f87ff]/50 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40"
          title="Ver planes y precios"
          aria-label="Ver planes y precios"
          aria-haspopup="dialog"
          onClick={() => setUpgradeOpen(true)}
        >
          <Plus className="h-3 w-3" strokeWidth={2.5} />
          Upgrade
        </button>
      ) : null}

      <span className="min-w-0 flex-1" />

      {!openPanels.has("preview") && !computerOpen ? (
        <button
          type="button"
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40"
          aria-label="Abrir Preview"
          title="Abrir Preview"
          data-canvas-toggle="open"
          data-testid="workspace-header-canvas-open"
          onClick={() => onTogglePanel("preview")}
        >
          <DesktopMonitorGlyph className="h-3.5 w-3.5" />
          Preview
        </button>
      ) : null}

      <nav
        className="flex shrink-0 items-center gap-1"
        aria-label="Herramientas de la barra"
        data-testid="workspace-header-icon-cluster"
      >
        {toolsMenu ?? (
          <button
            type="button"
            className={TOOLBAR_ICON}
            aria-label="Nueva pestaña"
            title="Nueva pestaña"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          className={TOOLBAR_ICON}
          aria-label="Invitar al equipo"
          title="Invitar al equipo"
          onClick={onOpenInvite}
        >
          <UserPlus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={TOOLBAR_ICON}
          aria-label="Buscar"
          title="Buscar"
          onClick={onOpenSearch}
        >
          <Search className="h-3.5 w-3.5" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={TOOLBAR_ICON}
              aria-label="Más acciones"
              title="Más acciones"
              data-testid="workspace-header-overflow"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              className="gap-2"
              disabled={previewPhase === "starting"}
              onSelect={() => handleRunStop()}
              data-testid="workspace-header-run-overflow"
            >
              {running ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {runLabel}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="gap-2"
              onSelect={() => onOpenCode()}
              data-testid="workspace-header-code-overflow"
            >
              <FolderGit2 className="h-3.5 w-3.5" />
              {codeOpen ? "Cerrar código" : "Código del proyecto"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label="Publicar el proyecto"
          title="Publicar el proyecto"
          aria-pressed={publishingOpen}
          onClick={onOpenPublishing}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-[11px] font-semibold transition-colors",
            "bg-zinc-900 text-white hover:bg-zinc-700 active:bg-zinc-800",
            "dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:active:bg-zinc-200",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            "disabled:pointer-events-none disabled:opacity-40",
          )}
        >
          <Globe className="h-3.5 w-3.5" />
          Publicar
        </button>
        <button
          type="button"
          aria-label={computerLabel}
          title={computerLabel}
          aria-pressed={computerOpen}
          data-testid="workspace-header-department-computer"
          data-dept-computer-header="1"
          data-dept-real-computer="1"
          onClick={onOpenDepartmentComputer}
          className={cn(TOOLBAR_ICON, computerOpen && "bg-muted/70 text-foreground")}
        >
          <DesktopMonitorGlyph className="h-3.5 w-3.5" />
        </button>
      </nav>
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
