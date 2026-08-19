"use client"

import * as React from "react"
import { CalendarDays, CheckCircle2, ImagePlus, Instagram, Linkedin, Palette, Send, Youtube } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { normalizeChatInput, shouldWarnUser } from "@/lib/chat-input-normalize"
const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

const NETWORKS = [
  { id: "instagram", label: "Instagram", icon: Instagram },
  { id: "linkedin", label: "LinkedIn", icon: Linkedin },
  { id: "youtube", label: "YouTube", icon: Youtube },
  { id: "tiktok", label: "TikTok", icon: Send },
  { id: "facebook", label: "Facebook", icon: Send },
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
  accountName: string | null
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
  const [platforms, setPlatforms] = React.useState<string[]>(["instagram"])
  const [referenceImages, setReferenceImages] = React.useState<any[]>([])
  const [posts, setPosts] = React.useState<ScheduledPost[]>([])
  const [connections, setConnections] = React.useState<SocialConnection[]>([])
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)

  const connectedPlatforms = React.useMemo(() => new Set(connections.map((c) => c.platform)), [connections])
  const batches = React.useMemo(() => groupPosts(posts), [posts])

  React.useEffect(() => {
    loadDashboard()
  }, [])

  async function loadDashboard() {
    setLoading(true)
    try {
      const [postsRes, connectionsRes] = await Promise.all([
        fetch(`${API_ROOT}/social-posts`, { credentials: "include", headers: authHeaders(false) }),
        fetch(`${API_ROOT}/social-posts/connections`, { credentials: "include", headers: authHeaders(false) }),
      ])
      if (postsRes.ok) {
        const json = await postsRes.json()
        setPosts(Array.isArray(json.posts) ? json.posts : [])
      }
      if (connectionsRes.ok) {
        const json = await connectionsRes.json()
        setConnections(Array.isArray(json.connections) ? json.connections : [])
      }
    } catch {
      toast.error("No se pudo cargar POST")
    } finally {
      setLoading(false)
    }
  }

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
    if (platforms.length === 0) return toast.error("Selecciona al menos una red social")
    setSaving(true)
    try {
      const res = await fetch(`${API_ROOT}/social-posts/series`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: JSON.stringify({ prompt: cleanPrompt, paletteName, days, startDate, platforms, referenceImages }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      toast.success(`Serie creada: ${json.posts?.length || 0} posts`)
      setPrompt("")
      setReferenceImages([])
      await loadDashboard()
    } catch (err: any) {
      toast.error(err?.message || "No se pudo programar")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-serif tracking-tight">POST automático</h1>
        <p className="mt-1 text-sm text-muted-foreground">Programa series por varios días, usa imágenes de referencia y deja listas las conexiones sociales.</p>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <main className="space-y-5">
          <Card>
            <CardHeader><CardTitle>Crear serie</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} placeholder="Idea del post, negocio, oferta, tono y objetivo..." />
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-sm font-medium">
                  <span className="inline-flex items-center gap-1.5"><Palette className="h-4 w-4" /> Paleta de colores</span>
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
                <span className="mb-2 flex items-center gap-2 font-medium"><ImagePlus className="h-4 w-4" /> Subir imágenes de referencia</span>
                <Input type="file" accept="image/*" multiple onChange={(e) => handleImages(e.target.files)} />
                {referenceImages.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{referenceImages.length} imagen(es) cargada(s)</p>}
              </label>

              <div className="space-y-2">
                <div className="text-sm font-medium">Redes sociales</div>
                <div className="flex flex-wrap gap-2">
                  {NETWORKS.map((network) => {
                    const Icon = network.icon
                    const active = platforms.includes(network.id)
                    const connected = connectedPlatforms.has(network.id)
                    return (
                      <button key={network.id} type="button" onClick={() => togglePlatform(network.id)} className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${active ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>
                        <Icon className="h-4 w-4" /> {network.label}
                        {connected && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
                      </button>
                    )
                  })}
                </div>
              </div>

              <Button onClick={schedule} disabled={saving} className="gap-2">
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
            {NETWORKS.map((network) => {
              const connected = connectedPlatforms.has(network.id)
              return (
                <Button key={network.id} variant="outline" className="w-full justify-between" asChild>
                  <a href={`${API_ROOT}/social-posts/connect/${network.id}`}>
                    <span className="inline-flex items-center gap-2">
                      {network.label}
                      {connected && <Badge variant="secondary">stub</Badge>}
                    </span>
                    <Send className="h-3.5 w-3.5" />
                  </a>
                </Button>
              )
            })}
            <p className="pt-2 text-xs text-muted-foreground">El flujo actual guarda un stub OAuth auditable. La publicación real queda bloqueada hasta configurar credenciales oficiales por plataforma.</p>
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
