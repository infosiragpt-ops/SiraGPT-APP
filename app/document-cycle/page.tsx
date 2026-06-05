"use client"

import * as React from "react"
import { apiClient } from "@/lib/api"
import {
  agentTaskService,
  reduceEvent,
  initialAgentState,
  normalizeAgentTaskErrorMessage,
  type AgentTaskState,
} from "@/lib/agent-task-service"
import { AgenticStepsRenderer } from "@/components/agentic-steps"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Loader2, CheckCircle2, Circle, CircleDot } from "lucide-react"

type Option = { id: string; label: string }
type Stage = { id: string; label: string }

interface Classification {
  documentType: { id: string; label: string; academic: boolean }
  field: { id: string; label: string }
  citationStyle: string
  citationStyleLabel: string
  confidence: { type: string; field: string }
}

interface ClassifyResponse {
  ok: boolean
  classification: Classification
  guide: { sections: string[]; notes: string[]; citationStyleLabel: string }
  stages: Stage[]
  options: {
    documentTypes: Option[]
    fields: Option[]
    citationStyles: Option[]
  }
}

const AUTO = "__auto__"

function freshState(): AgentTaskState {
  return {
    ...initialAgentState,
    steps: [],
    artifacts: [],
    approvals: [],
    checkpoints: [],
    qualityGates: [],
    repairs: [],
  }
}

export default function DocumentCyclePage() {
  const [topic, setTopic] = React.useState("")
  const [code, setCode] = React.useState("")
  const [documentType, setDocumentType] = React.useState(AUTO)
  const [field, setField] = React.useState(AUTO)
  const [citationStyle, setCitationStyle] = React.useState(AUTO)

  const [classifying, setClassifying] = React.useState(false)
  const [classifyError, setClassifyError] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<ClassifyResponse | null>(null)

  const [running, setRunning] = React.useState(false)
  const [state, setState] = React.useState<AgentTaskState>(freshState)
  const [cycleStages, setCycleStages] = React.useState<Stage[]>([])
  const [stageStatus, setStageStatus] = React.useState<Record<string, "start" | "done">>({})
  const abortRef = React.useRef<AbortController | null>(null)

  React.useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const handleClassify = React.useCallback(async () => {
    const t = topic.trim()
    if (!t) {
      setClassifyError("Ingresa el tema aprobado.")
      return
    }
    setClassifying(true)
    setClassifyError(null)
    try {
      const res = (await apiClient.classifyDocumentCycle({
        topic: t,
        documentType: documentType === AUTO ? undefined : documentType,
        field: field === AUTO ? undefined : field,
      })) as ClassifyResponse
      setPreview(res)
    } catch (err: any) {
      setClassifyError(err?.message || "No se pudo clasificar el documento.")
    } finally {
      setClassifying(false)
    }
  }, [topic, documentType, field])

  const handleStart = React.useCallback(async () => {
    const t = topic.trim()
    const c = code.trim()
    if (!t) {
      setClassifyError("Ingresa el tema aprobado.")
      return
    }
    if (!c) {
      setClassifyError("Ingresa el código de carpeta para organizar los archivos.")
      return
    }
    setClassifyError(null)
    setRunning(true)
    setState(freshState())
    setCycleStages(preview?.stages || [])
    setStageStatus({})

    const controller = new AbortController()
    abortRef.current = controller
    let live = freshState()

    try {
      for await (const evt of agentTaskService.runIterator({
        endpoint: "/agent/document-cycle",
        goal: t,
        topic: t,
        code: c,
        documentType: documentType === AUTO ? undefined : documentType,
        field: field === AUTO ? undefined : field,
        citationStyle: citationStyle === AUTO ? undefined : citationStyle,
        maxSteps: 80,
        maxRuntimeMs: 2 * 60 * 60 * 1000,
        signal: controller.signal,
      })) {
        if (evt.type === "cycle_init" && Array.isArray(evt.stages)) {
          setCycleStages(evt.stages)
        } else if (evt.type === "cycle_stage" && evt.stage) {
          const stageId = evt.stage
          setStageStatus((prev) => ({ ...prev, [stageId]: evt.status === "done" ? "done" : "start" }))
        }
        live = reduceEvent(live, evt)
        setState({ ...live })
      }
      if (!live.done) {
        live = { ...live, done: true, error: live.error || "stream_closed_without_done" }
        setState({ ...live })
      }
    } catch (err: any) {
      if (controller.signal.aborted || /abort/i.test(err?.message || "")) {
        setState((s) => ({ ...s, done: true, error: "aborted" }))
      } else {
        setState((s) => ({ ...s, done: true, error: normalizeAgentTaskErrorMessage(err) }))
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }, [topic, code, documentType, field, citationStyle, preview])

  const handleCancel = React.useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const stagesToShow = cycleStages.length ? cycleStages : preview?.stages || []

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Ciclo profesional de documentos</h1>
        <p className="text-muted-foreground">
          Convierte un tema aprobado en un documento profesional completo: revisión de la guía,
          clasificación, investigación, redacción por secciones y exportación a Word y PDF,
          organizados en una carpeta con tu código.
        </p>
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <div className="space-y-2">
          <Label htmlFor="topic">Tema aprobado</Label>
          <Textarea
            id="topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Ej. Impacto de la telemedicina en la adherencia al tratamiento en pacientes crónicos"
            rows={3}
            disabled={running}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="code">Código de carpeta</Label>
            <Input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Ej. TESIS-2026-001"
              disabled={running}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="docType">Tipo de documento</Label>
            <select
              id="docType"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value)}
              disabled={running}
            >
              <option value={AUTO}>Detección automática</option>
              {preview?.options.documentTypes.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="field">Campo / carrera</Label>
            <select
              id="field"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={field}
              onChange={(e) => setField(e.target.value)}
              disabled={running}
            >
              <option value={AUTO}>Detección automática</option>
              {preview?.options.fields.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cite">Estilo de citación</Label>
            <select
              id="cite"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={citationStyle}
              onChange={(e) => setCitationStyle(e.target.value)}
              disabled={running}
            >
              <option value={AUTO}>Según el campo</option>
              {preview?.options.citationStyles.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={handleClassify} disabled={classifying || running}>
            {classifying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Vista previa de clasificación
          </Button>
          <Button onClick={handleStart} disabled={running}>
            {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Iniciar ciclo
          </Button>
          {running && (
            <Button variant="ghost" onClick={handleCancel}>Cancelar</Button>
          )}
        </div>

        {classifyError && <p className="text-sm text-destructive">{classifyError}</p>}
      </div>

      {preview && !running && (
        <div className="mt-4 rounded-lg border p-4 text-sm">
          <h2 className="mb-2 font-semibold">Clasificación detectada</h2>
          <ul className="space-y-1 text-muted-foreground">
            <li><strong>Tipo:</strong> {preview.classification.documentType.label} ({preview.classification.confidence.type})</li>
            <li><strong>Campo:</strong> {preview.classification.field.label} ({preview.classification.confidence.field})</li>
            <li><strong>Citación:</strong> {preview.classification.citationStyleLabel}</li>
          </ul>
          <h3 className="mt-3 mb-1 font-semibold">Esquema de secciones</h3>
          <ol className="list-decimal pl-5 text-muted-foreground">
            {preview.guide.sections.map((s) => <li key={s}>{s}</li>)}
          </ol>
        </div>
      )}

      {stagesToShow.length > 0 && (running || Object.keys(stageStatus).length > 0) && (
        <div className="mt-4 rounded-lg border p-4">
          <h2 className="mb-3 font-semibold">Progreso del ciclo</h2>
          <ol className="space-y-2">
            {stagesToShow.map((s) => {
              const st = stageStatus[s.id]
              return (
                <li key={s.id} className="flex items-center gap-2 text-sm">
                  {st === "done" ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  ) : st === "start" ? (
                    <CircleDot className="h-4 w-4 animate-pulse text-blue-600" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className={st ? "" : "text-muted-foreground"}>{s.label}</span>
                </li>
              )
            })}
          </ol>
        </div>
      )}

      {(running || state.steps.length > 0 || state.artifacts.length > 0 || state.error) && (
        <div className="mt-4">
          <AgenticStepsRenderer state={state} />
        </div>
      )}
    </div>
  )
}
