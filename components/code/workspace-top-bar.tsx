"use client"

import * as React from "react"
import {
  FolderGit2,
  Globe,
  Menu,
  Monitor,
  Play,
  Plus,
  Search,
  Square,
  UserPlus,
} from "lucide-react"

import UpgradeModal from "@/components/UpgradeModal"
import { Button } from "@/components/ui/button"
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

/**
 * Slim professional workspace header: Preview reopen + Run/Stop + utilities.
 * Company/department labels live in the left sidebar — not duplicated here.
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
    >
      {deptChatChrome ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-md md:hidden"
          aria-label="Abrir menú de departamentos"
          title="Departamentos"
          data-testid="dept-chat-hamburger"
          onClick={() => window.dispatchEvent(new CustomEvent(CODE_OPEN_DEPT_DRAWER_EVENT))}
        >
          <Menu className="h-4 w-4" />
        </Button>
      ) : null}

      {showUpgrade ? (
        <button
          type="button"
          className="flex h-6 shrink-0 items-center gap-0.5 rounded-md bg-[#0f87ff] px-2 text-[11px] font-semibold text-white transition-colors hover:bg-[#0c74dd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f87ff]/50 focus-visible:ring-offset-2"
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

      <button
        type="button"
        onClick={handleRunStop}
        aria-label={running ? "Detener la app" : "Ejecutar la app"}
        title={running ? "Detener" : "Ejecutar"}
        data-testid="workspace-header-run-stop"
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold text-white transition-colors",
          running ? "bg-red-600/90 hover:bg-red-600" : "bg-emerald-600 hover:bg-emerald-500",
        )}
      >
        {running ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        <span>{previewPhase === "starting" ? "Arrancando…" : running ? "Detener" : "Ejecutar"}</span>
      </button>

      {!openPanels.has("preview") && !computerOpen ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 rounded-md px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          aria-label="Abrir Preview"
          title="Abrir Preview"
          data-canvas-toggle="open"
          data-testid="workspace-header-canvas-open"
          onClick={() => onTogglePanel("preview")}
        >
          <Monitor className="mr-1 h-3.5 w-3.5" />
          Preview
        </Button>
      ) : null}
      {toolsMenu ?? null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
        aria-label="Invitar al equipo"
        title="Invitar al equipo"
        onClick={onOpenInvite}
      >
        <UserPlus className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
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
          "h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground",
          codeOpen && "bg-muted/70 text-foreground",
        )}
      >
        <FolderGit2 className="h-3.5 w-3.5" />
      </Button>
      <button
        type="button"
        aria-label="Publicar el proyecto"
        aria-pressed={publishingOpen}
        onClick={onOpenPublishing}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-[11px] font-semibold transition-colors",
          "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white",
        )}
      >
        <Globe className="h-3 w-3" />
        Publicar
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={computerLabel}
        title={computerLabel}
        aria-pressed={computerOpen}
        data-testid="workspace-header-department-computer"
        data-dept-computer-header="1"
        data-dept-real-computer="1"
        onClick={onOpenDepartmentComputer}
        className={cn(
          "h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground",
          computerOpen && "bg-muted/70 text-foreground",
        )}
      >
        <DesktopMonitorGlyph className="h-3.5 w-3.5" />
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
