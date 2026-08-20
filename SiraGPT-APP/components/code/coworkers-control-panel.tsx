"use client"

import * as React from "react"
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ClipboardCheck,
  Loader2,
  MessageSquareText,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { requestCodeAgentInstruction } from "@/lib/code-autonomous-starters"
import {
  coworkApi,
  type CoworkApproval,
  type CoworkAuditLog,
  type CoworkWorkspace,
} from "@/lib/cowork-api"
import { cn } from "@/lib/utils"

const COWORKER_POLICIES = ["review", "build", "research"] as const
type CoworkerPolicy = (typeof COWORKER_POLICIES)[number]

type Coworker = {
  id: string
  name: string
  role: string
  description: string
  policy: CoworkerPolicy
  custom?: boolean
}

const STORAGE_KEY = "siragpt:code:coworkers:v1"
const CUSTOM_ROLE = "Coworker personalizado"
const CUSTOM_DESCRIPTION =
  "Especialista creado para este navegador. Conserva las mismas políticas seguras."

const DEFAULT_COWORKERS: readonly Coworker[] = [
  {
    id: "architect",
    name: "Arquitecta",
    role: "Planificación y revisión",
    description: "Aclara el alcance, detecta riesgos y propone un plan verificable.",
    policy: "review",
  },
  {
    id: "builder",
    name: "Implementador",
    role: "Desarrollo de producto",
    description: "Construye cambios pequeños, los verifica y deja evidencia.",
    policy: "build",
  },
  {
    id: "researcher",
    name: "Investigador",
    role: "Análisis y fuentes",
    description: "Investiga, contrasta hallazgos y resume decisiones.",
    policy: "research",
  },
]

const POLICY_COPY: Record<Coworker["policy"], string> = {
  review: "Solo análisis y lectura. No aplica cambios.",
  build: "Cambios sujetos a aprobaciones explícitas.",
  research: "Investigación y síntesis; sin credenciales ni publicaciones.",
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return ""
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength)
}

/**
 * localStorage is an untrusted store (same rule as the persisted /code chat
 * sessions): rebuild every profile from scratch with bounded strings and an
 * allowlisted policy, and drop anything that does not conform.
 */
function sanitizeStoredCoworker(value: unknown): Coworker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = cleanText(record.id, 64)
  const name = cleanText(record.name, 48)
  if (!/^custom-[a-z0-9-]{1,48}$/.test(id) || !name) return null
  const policy = COWORKER_POLICIES.includes(record.policy as CoworkerPolicy)
    ? (record.policy as CoworkerPolicy)
    : "review"
  return {
    id,
    name,
    role: cleanText(record.role, 80) || CUSTOM_ROLE,
    description: cleanText(record.description, 220) || CUSTOM_DESCRIPTION,
    policy,
    custom: true,
  }
}

function readCustomCoworkers(): Coworker[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]")
    if (!Array.isArray(value)) return []
    const seen = new Set<string>(DEFAULT_COWORKERS.map((coworker) => coworker.id))
    const result: Coworker[] = []
    for (const item of value) {
      const coworker = sanitizeStoredCoworker(item)
      if (!coworker || seen.has(coworker.id)) continue
      seen.add(coworker.id)
      result.push(coworker)
      if (result.length >= 12) break
    }
    return result
  } catch {
    return []
  }
}

function statusCopy(error: unknown): string {
  const status = Number((error as { status?: number } | null)?.status)
  if (status === 401) return "Inicia sesión para usar coworkers y ver su actividad."
  if (status === 404 || status === 503) return "El servicio de coworkers no está disponible en este entorno."
  return "No se pudo cargar el control de coworkers. No se ejecutó ninguna acción."
}

export function CoworkersControlPanel({ onOpenChat }: { onOpenChat: () => void }) {
  const [coworkers, setCoworkers] = React.useState<Coworker[]>([...DEFAULT_COWORKERS])
  const [selectedId, setSelectedId] = React.useState(DEFAULT_COWORKERS[0].id)
  const [workspaces, setWorkspaces] = React.useState<CoworkWorkspace[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = React.useState<string>("")
  const [approvals, setApprovals] = React.useState<CoworkApproval[]>([])
  const [audit, setAudit] = React.useState<CoworkAuditLog[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [newName, setNewName] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const [actingApproval, setActingApproval] = React.useState<string | null>(null)

  const selected = coworkers.find((coworker) => coworker.id === selectedId) || coworkers[0]

  const refresh = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [workspaceResult, approvalResult, auditResult] = await Promise.all([
        coworkApi.listWorkspaces(20),
        coworkApi.listApprovals(),
        coworkApi.listAudit(undefined, 8),
      ])
      const workspaceList = workspaceResult.workspaces || []
      setWorkspaces(workspaceList)
      setApprovals((approvalResult.approvals || []).slice(0, 12))
      setAudit(auditResult.logs || [])
      setSelectedWorkspaceId((current) =>
        current && workspaceList.some((workspace) => workspace.id === current)
          ? current
          : workspaceList[0]?.id || "",
      )
    } catch (reason) {
      // Fail closed: never leave stale approvals/workspaces actionable after
      // a failed refresh — the server state may have changed underneath.
      setWorkspaces([])
      setApprovals([])
      setAudit([])
      setSelectedWorkspaceId("")
      setError(statusCopy(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    setCoworkers([...DEFAULT_COWORKERS, ...readCustomCoworkers()])
    void refresh()
  }, [refresh])

  const addCoworker = React.useCallback(() => {
    const name = newName.trim().slice(0, 48)
    if (!name) return
    const coworker: Coworker = {
      id: `custom-${Date.now().toString(36)}`,
      name,
      role: CUSTOM_ROLE,
      description: CUSTOM_DESCRIPTION,
      policy: "review",
      custom: true,
    }
    setCoworkers((current) => {
      const next = [...current, coworker]
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next.filter((item) => item.custom)))
      } catch {
        // The active session still works if browser storage is unavailable.
      }
      return next
    })
    setSelectedId(coworker.id)
    setNewName("")
    setCreating(false)
  }, [newName])

  const startConversation = React.useCallback(() => {
    if (!selected) return
    const workspace = workspaces.find((item) => item.id === selectedWorkspaceId)
    const prompt = [
      `Actúa como ${selected.name}, coworker de ${selected.role}.`,
      selected.description,
      `Política: ${POLICY_COPY[selected.policy]}`,
      workspace ? `Contexto de cowork workspace: ${workspace.name}.` : "No hay workspace persistente seleccionado.",
      "Explica el plan antes de cualquier cambio relevante. No pidas ni expongas secretos, credenciales o tokens.",
      "Responde en español y termina con el siguiente paso concreto.",
    ].join("\n")
    onOpenChat()
    // Fail closed with the displayed policy: only the build policy may enter
    // the write-enabled agent mode; review/research stay in read-only "ask".
    requestCodeAgentInstruction(prompt, { mode: selected.policy === "build" ? "app" : "ask" })
  }, [onOpenChat, selected, selectedWorkspaceId, workspaces])

  const decideApproval = React.useCallback(async (approvalId: string, decision: "allow" | "deny") => {
    setActingApproval(approvalId)
    try {
      await coworkApi.decideApproval(approvalId, decision)
      await refresh()
    } catch (reason) {
      // Re-sync first (the approval may have expired or been resolved
      // elsewhere), then surface the more specific decision error.
      await refresh()
      setError(statusCopy(reason))
    } finally {
      setActingApproval(null)
    }
  }, [refresh])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-sky-600 dark:text-sky-400" />
            <h2 className="text-sm font-semibold">Coworkers</h2>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Roles especializados con permisos visibles, aprobaciones y registro de actividad.
          </p>
        </div>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => void refresh()} disabled={loading} aria-label="Actualizar coworkers">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {error ? (
        <div className="mt-4 flex gap-2 rounded-lg border border-amber-400/45 bg-amber-50 p-3 text-xs text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <section className="mt-5">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold">Equipo</h3>
          <button type="button" className="text-xs font-medium text-sky-700 hover:underline dark:text-sky-300" onClick={() => setCreating((value) => !value)}>
            <Plus className="mr-1 inline h-3.5 w-3.5" /> Crear
          </button>
        </div>
        {creating ? (
          <div className="mt-2 flex gap-2">
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Nombre del coworker" maxLength={48} />
            <Button size="sm" onClick={addCoworker}>Guardar</Button>
          </div>
        ) : null}
        <div className="mt-2 space-y-2">
          {coworkers.map((coworker) => (
            <button
              type="button"
              key={coworker.id}
              onClick={() => setSelectedId(coworker.id)}
              className={cn(
                "w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/45",
                selectedId === coworker.id ? "border-sky-400/60 bg-sky-50/70 dark:bg-sky-950/25" : "border-border/60",
              )}
            >
              <span className="flex items-center justify-between gap-3">
                <span className="font-medium text-sm">{coworker.name}</span>
                {selectedId === coworker.id ? <Check className="h-4 w-4 text-sky-600" /> : null}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{coworker.role}</span>
            </button>
          ))}
        </div>
      </section>

      {selected ? (
        <section className="mt-5 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="flex gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div>
              <h3 className="text-xs font-semibold">Política de herramientas</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{POLICY_COPY[selected.policy]}</p>
            </div>
          </div>
          <label className="mt-3 block text-xs font-medium">
            Workspace persistente
            <span className="relative mt-1.5 block">
              <select
                className="h-9 w-full appearance-none rounded-md border border-input bg-background px-2 pr-8 text-xs"
                value={selectedWorkspaceId}
                onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                disabled={loading || Boolean(error)}
              >
                <option value="">Sin workspace seleccionado</option>
                {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 text-muted-foreground" />
            </span>
          </label>
          <Button className="mt-3 w-full" onClick={startConversation} disabled={Boolean(error)}>
            <MessageSquareText className="mr-2 h-4 w-4" /> Conversar con {selected.name}
          </Button>
        </section>
      ) : null}

      <section className="mt-5">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold">Aprobaciones pendientes</h3>
          <span className="text-xs text-muted-foreground">{approvals.length}</span>
        </div>
        {approvals.length ? (
          <div className="mt-2 space-y-2">
            {approvals.map((approval) => (
              <div key={approval.id} className="rounded-lg border border-amber-400/40 bg-amber-50/65 p-3 text-xs dark:bg-amber-950/20">
                <p className="font-medium">{approval.humanDescription || approval.tool}</p>
                <p className="mt-1 text-muted-foreground">Herramienta: {approval.tool}</p>
                <div className="mt-2 flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => void decideApproval(approval.id, "deny")} disabled={actingApproval !== null || loading}>Denegar</Button>
                  <Button size="sm" onClick={() => void decideApproval(approval.id, "allow")} disabled={actingApproval !== null || loading}>
                    {actingApproval === approval.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Aprobar"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : <p className="mt-2 text-xs text-muted-foreground">No hay acciones esperando aprobación.</p>}
      </section>

      <section className="mt-5">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-xs font-semibold">Actividad auditable</h3>
        </div>
        {audit.length ? (
          <ol className="mt-2 divide-y divide-border/50 rounded-lg border border-border/60">
            {audit.map((entry) => (
              <li key={entry.id} className="p-3 text-xs">
                <p className="font-medium">{entry.action}</p>
                {entry.resultSummary ? <p className="mt-0.5 truncate text-muted-foreground">{entry.resultSummary}</p> : null}
              </li>
            ))}
          </ol>
        ) : <p className="mt-2 text-xs text-muted-foreground">Aún no hay eventos para este usuario.</p>}
      </section>
    </div>
  )
}