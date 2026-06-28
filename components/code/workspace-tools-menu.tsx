"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { CODE_OPEN_TOOL_EVENT } from "@/lib/code-workspace-context"
import {
  filterWorkspaceTools,
  groupWorkspaceTools,
  WORKSPACE_ORCHESTRATOR_MODEL,
  WORKSPACE_WORKFLOW_MAX_RUNTIME_MS,
  WORKSPACE_WORKFLOW_RUNTIME_10H_MS,
  type WorkspaceToolAction,
  type WorkspaceToolDef,
} from "@/lib/workspace-tools-registry"
import { startWorkspaceWorkflow } from "@/lib/workspace-workflow-service"
import type { WorkspacePanelId } from "@/components/code/workspace-top-bar"
import type { WorkspaceToolId } from "@/lib/code-workspace-tools"

export type WorkspaceToolsHandlers = {
  onTogglePanel: (id: WorkspacePanelId) => void
  onOpenPalette: (query?: string) => void
  onNewFile: () => void
  onOpenPublishing: () => void
  onFocusChat: () => void
  onOpenComposer: () => void
  onOpenTool?: (id: WorkspaceToolId) => void
}

type Props = {
  children: React.ReactNode
  handlers: WorkspaceToolsHandlers
}

export function WorkspaceToolsMenu({ children, handlers }: Props) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [workflowOpen, setWorkflowOpen] = React.useState(false)
  const [workflowGoal, setWorkflowGoal] = React.useState("")
  const [workflowHours, setWorkflowHours] = React.useState<10 | 20>(20)
  const [workflowBusy, setWorkflowBusy] = React.useState(false)

  const filtered = React.useMemo(() => filterWorkspaceTools(query), [query])
  const groups = React.useMemo(() => groupWorkspaceTools(filtered), [filtered])

  const runAction = React.useCallback(
    (action: WorkspaceToolAction) => {
      setOpen(false)
      setQuery("")
      switch (action.type) {
        case "panel":
          handlers.onTogglePanel(action.panel)
          break
        case "code-tool":
          if (handlers.onOpenTool) {
            handlers.onOpenTool(action.toolId)
          } else if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent(CODE_OPEN_TOOL_EVENT, { detail: { toolId: action.toolId } }),
            )
          }
          break
        case "palette":
          handlers.onOpenPalette(action.query)
          break
        case "new-file":
          handlers.onNewFile()
          break
        case "open-app":
          if (typeof window !== "undefined") {
            window.open(window.location.origin, "_blank", "noopener,noreferrer")
          }
          break
        case "publishing":
          window.setTimeout(() => handlers.onOpenPublishing(), 0)
          break
        case "navigate":
          if (typeof window !== "undefined") window.location.href = action.href
          break
        case "workflow-dialog":
          setWorkflowOpen(true)
          break
        case "focus-chat":
          handlers.onFocusChat()
          break
        case "composer":
          handlers.onOpenComposer()
          break
        case "noop":
          toast.message(action.message)
          break
        default:
          break
      }
    },
    [handlers],
  )

  const startWorkflow = React.useCallback(async () => {
    const goal = workflowGoal.trim()
    if (!goal) {
      toast.error("Describe el objetivo del workflow")
      return
    }
    setWorkflowBusy(true)
    try {
      const maxRuntimeMs =
        workflowHours === 20 ? WORKSPACE_WORKFLOW_MAX_RUNTIME_MS : WORKSPACE_WORKFLOW_RUNTIME_10H_MS
      const result = await startWorkspaceWorkflow({
        goal,
        model: WORKSPACE_ORCHESTRATOR_MODEL,
        maxRuntimeMs,
        maxSteps: 120,
      })
      if (!result.ok || !result.taskId) {
        toast.error(result.error || "No se pudo iniciar el workflow")
        return
      }
      setWorkflowOpen(false)
      setWorkflowGoal("")
      handlers.onFocusChat()
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("siragpt:workspace-workflow-started", {
            detail: {
              taskId: result.taskId,
              goal,
              model: result.model,
              maxRuntimeMs: result.maxRuntimeMs,
            },
          }),
        )
      }
      toast.success(
        `Workflow encadenado iniciado (${workflowHours} h). Tarea ${result.taskId.slice(0, 8)}…`,
      )
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Error al iniciar workflow")
    } finally {
      setWorkflowBusy(false)
    }
  }, [workflowGoal, workflowHours, handlers])

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-[320px] rounded-xl border-border/70 p-0 shadow-xl"
        >
          <div className="border-b border-border/50 p-2.5">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar herramientas y archivos…"
              className="h-8 border-0 bg-muted/30 text-[13px] shadow-none focus-visible:ring-1"
              autoFocus
            />
          </div>
          <div className="max-h-[min(420px,60vh)] overflow-y-auto py-1">
            {groups.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">Sin resultados</p>
            ) : (
              groups.map((group) => (
                <div key={group.section} className="pb-1">
                  <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                    {group.label}
                  </p>
                  <ul>
                    {group.items.map((tool) => (
                      <ToolRow key={tool.id} tool={tool} onSelect={() => runAction(tool.action)} />
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={workflowOpen} onOpenChange={setWorkflowOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Workflow con agente interno</DialogTitle>
            <DialogDescription>
              Un orquestador ({WORKSPACE_ORCHESTRATOR_MODEL}) descompone el objetivo en fases encadenadas
              y ejecuta la tarea de forma durable (hasta {workflowHours} h sin detenerse).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <Label htmlFor="wf-goal" className="text-xs">
                Objetivo
              </Label>
              <Textarea
                id="wf-goal"
                value={workflowGoal}
                onChange={(e) => setWorkflowGoal(e.target.value)}
                placeholder="Ej.: Implementar auth, tests E2E y desplegar staging…"
                className="mt-1 min-h-[100px] text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={workflowHours === 10 ? "default" : "outline"}
                size="sm"
                onClick={() => setWorkflowHours(10)}
              >
                10 horas
              </Button>
              <Button
                type="button"
                variant={workflowHours === 20 ? "default" : "outline"}
                size="sm"
                onClick={() => setWorkflowHours(20)}
              >
                20 horas
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setWorkflowOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={() => void startWorkflow()} disabled={workflowBusy}>
              {workflowBusy ? "Iniciando…" : "Iniciar workflow"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ToolRow({ tool, onSelect }: { tool: WorkspaceToolDef; onSelect: () => void }) {
  const Icon = tool.icon
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
        onClick={onSelect}
      >
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-foreground">{tool.title}</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
            {tool.description}
          </span>
        </span>
        {tool.showChevron ? (
          <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-muted-foreground/60" />
        ) : null}
      </button>
    </li>
  )
}
