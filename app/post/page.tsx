"use client"

import * as React from "react"
import { AlertTriangle, CalendarDays, CheckCircle2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { normalizeChatInput, shouldWarnUser } from "@/lib/chat-input-normalize"
import {
  CODE_ACTIVE_CODEX_PROJECT_EVENT,
  getActiveCodexProject,
} from "@/lib/code-workspace-context"
import { codexApi } from "@/lib/codex/codex-api"
import {
  companySocialResourceKeyForConnection,
} from "@/lib/company-resource-keys"
import {
  companySocialApi,
  type CompanySocialLegacySummary,
} from "@/lib/company-social-api"
const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

const NETWORKS = [
  { id: "facebook", label: "Facebook" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "x", label: "X" },
]

type ScheduledPost = {
  id: string
  prompt: string
  platforms: string[]
  scheduledAt: string | null
  status: string
  batchId: string | null
  referenceImages?: any[]
  config?: Record<string, any>
}

type SocialConnection = {
  id: string
  platform: string
  accountId: string | null
  accountName: string | null
  connected: boolean
  profile?: Record<string, any> | null
  updatedAt: string
}

function authHeaders(json = true): HeadersInit {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export default function PostPage() {
  const [prompt, setPrompt] = React.useState("")
  const [paletteName, setPaletteName] = React.useState("Profesional azul")
  const [days, setDays] = React.useState(5)
  const [startDate, setStartDate] = React.useState("")
  const [platforms, setPlatforms] = React.useState<string[]>([])
  const [referenceImages, setReferenceImages] = React.useState<any[]>([])
  const [posts, setPosts] = React.useState<ScheduledPost[]>([])
  const [connections, setConnections] = React.useState<SocialConnection[]>([])
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(() => getActiveCodexProject())
  const [allowedPlatforms, setAllowedPlatforms] = React.useState<Set<string>>(() => new Set())
  const [legacySummary, setLegacySummary] = React.useState<CompanySocialLegacySummary | null>(null)
  const [legacyBusy, setLegacyBusy] = React.useState(false)
  const [legacyLoadError, setLegacyLoadError] = React.useState(false)
  const loadGenerationRef = React.useRef(0)
  const loadAbortRef = React.useRef<AbortController | null>(null)

  const connectedPlatforms = React.useMemo(
    () => new Set(connections.filter((connection) => connection.connected).map((connection) => connection.platform)),
    [connections],
  )
  const batches = React.useMemo(() => groupPosts(posts), [posts])

  React.useEffect(() => {
    const syncWorkspace = (event?: Event) => {
      const eventProjectId = (event as CustomEvent<{ projectId?: string | null }> | undefined)
        ?.detail?.projectId
      setWorkspaceId(eventProjectId === undefined ? getActiveCodexProject() : eventProjectId)
    }
    syncWorkspace()
    window.addEventListener(CODE_ACTIVE_CODEX_PROJECT_EVENT, syncWorkspace)
    return () => window.removeEventListener(CODE_ACTIVE_CODEX_PROJECT_EVENT, syncWorkspace)
  }, [])

  const loadDashboard = React.useCallback(async (activeWorkspaceId: string | null) => {
    const generation = loadGenerationRef.current + 1
    loadGenerationRef.current = generation
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    setLoading(true)
    try {
      const [postsRes, connectionsRes, resources, legacy] = await Promise.all([
        activeWorkspaceId
          ? authenticatedFetch(
            `${API_ROOT}/social-posts?workspaceId=${encodeURIComponent(activeWorkspaceId)}`,
            { credentials: "include", headers: authHeaders(false), signal: controller.signal },
          )
          : Promise.resolve(null),
        authenticatedFetch(`${API_ROOT}/social-posts/connections`, {
          credentials: "include",
          headers: authHeaders(false),
          signal: controller.signal,
        }),
        activeWorkspaceId
          ? codexApi.getCompanyResources(activeWorkspaceId)
          : Promise.resolve(null),
        activeWorkspaceId
          ? companySocialApi.legacySummary(activeWorkspaceId)
            .then((summary) => ({ summary, failed: false }))
            .catch(() => ({ summary: null, failed: true }))
          : Promise.resolve({ summary: null, failed: false }),
      ])
      const postsJson = postsRes?.ok ? await postsRes.json() : null
      const connectionsJson = connectionsRes.ok ? await connectionsRes.json() : null
      if (generation !== loadGenerationRef.current || controller.signal.aborted) return
      const nextConnections: SocialConnection[] = Array.isArray(connectionsJson?.connections)
        ? connectionsJson.connections
        : []
      setPosts(Array.isArray(postsJson?.posts) ? postsJson.posts : [])
      setConnections(nextConnections)
      setLegacySummary(legacy.summary)
      setLegacyLoadError(legacy.failed)
      const nextAllowed = new Set(
        nextConnections.flatMap((connection) => {
          const platform = NETWORKS.find((network) => network.id === connection.platform)?.id
          if (!platform) return []
          const resourceKey = companySocialResourceKeyForConnection(
            platform as "facebook" | "linkedin" | "x",
            connection,
          )
          return resourceKey && resources?.assignments?.[resourceKey] === "marketing"
            ? [platform]
            : []
        }),
      )
      setAllowedPlatforms(nextAllowed)
      setPlatforms((current) => {
        const retained = current.filter((platform) => nextAllowed.has(platform))
        if (retained.length > 0) return retained
        const first = NETWORKS.find((network) => nextAllowed.has(network.id))
        return first ? [first.id] : []
      })
    } catch {
      if (generation !== loadGenerationRef.current || controller.signal.aborted) return
      setPosts([])
      setAllowedPlatforms(new Set())
      setPlatforms([])
      setLegacySummary(null)
      setLegacyLoadError(Boolean(activeWorkspaceId))
      toast.error("No se pudo cargar POST")
    } finally {
      if (generation === loadGenerationRef.current && !controller.signal.aborted) {
        setLoading(false)
      }
    }
  }, [])

  React.useEffect(() => {
    void loadDashboard(workspaceId)
    return () => loadAbortRef.current?.abort()
  }, [loadDashboard, workspaceId])

  function togglePlatform(id: string) {
    setPlatforms((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id])
  }

  async function handleImages(files: FileList | null) {
    if (!files) return
    const next = await Promise.all(Array.from(files).slice(0, 8).map((file) => new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve({ name: file.name, size: file.size, type: file.type, dataUrl: reader.result })
      reader.readAsDataURL(file)
    })))
    setReferenceImages(next)
  }

  async function schedule() {
    const normalized = normalizeChatInput(prompt)
    if (shouldWarnUser(normalized)) {
      toast.error(
        `La idea supera el límite (${normalized.originalLength.toLocaleString()} caracteres). Se recortó.`,
        { duration: 4500 },
      )
    }
    const cleanPrompt = normalized.value.trim()
    if (!cleanPrompt) return toast.error("Escribe la idea del post")
    if (!workspaceId) return toast.error("Abre primero una empresa activa desde Agentes")
    if (platforms.length === 0) return toast.error("Selecciona al menos una red social")
    if (platforms.some((platform) => !allowedPlatforms.has(platform))) {
      return toast.error("Marketing solo puede usar recursos asignados a esta empresa")
    }
    setSaving(true)
    try {
      const res = await authenticatedFetch(`${API_ROOT}/social-posts/series`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: cleanPrompt,
          paletteName,
          days,
          startDate,
          platforms,
          referenceImages,
          workspaceId,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      toast.success(`Serie creada: ${json.posts?.length || 0} posts`)
      setPrompt("")
      setReferenceImages([])
      await loadDashboard(workspaceId)
    } catch (err: any) {
      toast.error(err?.message || "No se pudo programar")
    } finally {
      setSaving(false)
    }
  }

  async function assignLegacyPosts() {
    if (!workspaceId || legacyBusy || !legacySummary?.assignable) return
    const confirmed = window.confirm(
      `Se vincularán ${legacySummary.assignable} publicaciones antiguas compatibles a la empresa activa. Las pendientes quedarán como borradores, ninguna se publicará automáticamente y las no autorizadas permanecerán sin empresa. ¿Continuar?`,
    )
    if (!confirmed) return
    setLegacyBusy(true)
    try {
      const result = await companySocialApi.assignLegacyPosts(workspaceId)
      toast.success(
        `${result.assigned} publicaciones asignadas; las pendientes quedaron como borradores y ${result.skipped} se omitieron de forma segura.`,
      )
      await loadDashboard(workspaceId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudieron asignar las publicaciones antiguas")
    } finally {
      setLegacyBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-serif tracking-tight">POST automático</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Programa series con los canales asignados a Marketing en la empresa activa.
        </p>
        {!workspaceId ? (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            Abre una empresa desde Agentes antes de programar contenido.
          </p>
        ) : null}
      </header>

      {workspaceId && legacyLoadError ? (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <p className="text-sm">
              No se pudo comprobar si existen publicaciones antiguas sin empresa. No se realizará ninguna asignación.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => void loadDashboard(workspaceId)}>
            Reintentar
          </Button>
        </div>
      ) : null}

      {workspaceId && legacySummary && legacySummary.total > 0 ? (
        <div className="mb-5 flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300" />
            <div>
              <p className="text-sm font-semibold">Publicaciones anteriores sin empresa</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {legacySummary.total} en total · {legacySummary.assignable} compatibles con los recursos actuales de Marketing
                {legacySummary.skipped > 0 ? ` · ${legacySummary.skipped} permanecerán sin asignar` : ""}.
                La asignación solo ocurre cuando la confirmas aquí y no publica contenido automáticamente.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            className="shrink-0 gap-2 bg-background"
            disabled={legacyBusy || legacySummary.assignable === 0}
            onClick={() => void assignLegacyPosts()}
          >
            {legacyBusy ? <ThinkingIndicator size="sm" /> : <CheckCircle2 className="h-4 w-4" />}
            Asignar compatibles
          </Button>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <main className="space-y-5">
          <Card>
            <CardHeader><CardTitle>Crear serie</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} placeholder="Idea del post, negocio, oferta, tono y objetivo..." />
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-sm font-medium">
                  <span>Paleta de colores</span>
                  <Input value={paletteName} onChange={(e) => setPaletteName(e.target.value)} placeholder="Ej. lujo negro y dorado" />
                </label>
                <label className="space-y-1 text-sm font-medium">
                  <span>Días</span>
                  <Input type="number" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} />
                </label>
                <label className="space-y-1 text-sm font-medium">
                  <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4" /> Inicio</span>
                  <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </label>
              </div>

              <label className="block rounded-xl border border-dashed p-4 text-sm">
                <span className="mb-2 block font-medium">Subir imágenes de referencia</span>
                <Input type="file" accept="image/*" multiple onChange={(e) => handleImages(e.target.files)} />
                {referenceImages.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{referenceImages.length} imagen(es) cargada(s)</p>}
              </label>

              <div className="space-y-2">
                <div className="text-sm font-medium">Redes sociales</div>
                <div className="flex flex-wrap gap-2">
                  {NETWORKS.filter((network) => allowedPlatforms.has(network.id)).map((network) => {
                    const active = platforms.includes(network.id)
                    const connected = connectedPlatforms.has(network.id)
                    return (
                      <button key={network.id} type="button" onClick={() => togglePlatform(network.id)} className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${active ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>
                        {network.label}
                        {connected && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
                      </button>
                    )
                  })}
                  {workspaceId && allowedPlatforms.size === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Asigna al departamento Marketing al menos un canal social desde Recursos.
                    </p>
                  ) : null}
                </div>
              </div>

              <Button
                onClick={schedule}
                disabled={saving || !workspaceId || platforms.length === 0}
                className="gap-2"
              >
                {saving ? <ThinkingIndicator size="sm" /> : <CalendarDays className="h-4 w-4" />}
                Programar contenido automático
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Series programadas</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {loading && <div className="h-24 animate-pulse rounded-lg bg-muted/40" />}
              {!loading && batches.length === 0 && <p className="text-sm text-muted-foreground">Aún no hay series programadas.</p>}
              {batches.map((batch) => (
                <div key={batch.id} className="rounded-xl border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold">{batch.title}</div>
                      <div className="text-xs text-muted-foreground">{batch.posts.length} post(s) · {batch.dateRange}</div>
                    </div>
                    <Badge variant="secondary">{batch.statuses.join(", ")}</Badge>
                  </div>
                  <div className="mt-3 grid gap-2">
                    {batch.posts.slice(0, 4).map((post) => (
                      <div key={post.id} className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-3 py-2 text-xs">
                        <span className="line-clamp-1">{post.prompt.split("\n")[0]}</span>
                        <span className="shrink-0 text-muted-foreground">{post.scheduledAt ? new Date(post.scheduledAt).toLocaleDateString() : "draft"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </main>

        <Card className="h-fit">
          <CardHeader><CardTitle>Conexiones</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {NETWORKS.filter((network) => allowedPlatforms.has(network.id)).map((network) => {
              const connected = connectedPlatforms.has(network.id)
              return (
                <Button key={network.id} variant="outline" className="w-full justify-between" asChild>
                  <a href={`${API_ROOT}/social-posts/connect/${network.id}?redirect=1`}>
                    <span className="inline-flex items-center gap-2">
                      {network.label}
                      {connected && <Badge variant="secondary">Conectado</Badge>}
                    </span>
                    <span aria-hidden>→</span>
                  </a>
                </Button>
              )
            })}
            <p className="pt-2 text-xs text-muted-foreground">
              La autorización de la empresa, la política y la conexión se validan otra vez justo antes de publicar.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function groupPosts(posts: ScheduledPost[]) {
  const map = new Map<string, ScheduledPost[]>()
  for (const post of posts) {
    const id = post.batchId || post.id
    map.set(id, [...(map.get(id) || []), post])
  }
  return [...map.entries()].map(([id, rows]) => {
    const sorted = [...rows].sort((a, b) => Date.parse(a.scheduledAt || "") - Date.parse(b.scheduledAt || ""))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const statuses = [...new Set(sorted.map((p) => p.status))]
    const range = [first?.scheduledAt, last?.scheduledAt]
      .filter(Boolean)
      .map((d) => new Date(String(d)).toLocaleDateString())
      .join(" - ")
    return {
      id,
      posts: sorted,
      statuses,
      title: first?.config?.paletteName ? `Serie ${first.config.paletteName}` : "Serie automática",
      dateRange: range || "sin fecha",
    }
  })
}
