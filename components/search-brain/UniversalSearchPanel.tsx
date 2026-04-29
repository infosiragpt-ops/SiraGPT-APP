"use client"

import * as React from "react"
import {
  BookOpen, Briefcase, ShoppingCart, Newspaper, DollarSign, Cloud, Plane,
  Home, UtensilsCrossed, Heart, GraduationCap, Scale, Landmark, Users,
  Globe, Search, ExternalLink, Copy, AlertTriangle, Settings2,
  CheckCircle2, XCircle} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { buildApa, buildSynthesis, categoryActionLabel, formatYear } from "@/lib/search-brain-ui"
import { cn } from "@/lib/utils"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

const REGIONS = [
  { id: "global", label: "Global" },
  { id: "latam", label: "Latam" },
  { id: "spain", label: "España/UE" },
  { id: "usa", label: "USA" },
  { id: "china", label: "China" },
]

const CATEGORIES = [
  { id: "academic", label: "Académico", icon: BookOpen },
  { id: "jobs", label: "Empleo", icon: Briefcase },
  { id: "shopping", label: "Precios", icon: ShoppingCart },
  { id: "news", label: "Noticias", icon: Newspaper },
  { id: "finance", label: "Finanzas", icon: DollarSign },
  { id: "weather", label: "Clima", icon: Cloud },
  { id: "travel", label: "Viajes", icon: Plane },
  { id: "realestate", label: "Inmobiliario", icon: Home },
  { id: "food", label: "Comida", icon: UtensilsCrossed },
  { id: "health", label: "Salud", icon: Heart },
  { id: "education", label: "Educación", icon: GraduationCap },
  { id: "legal", label: "Legal", icon: Scale },
  { id: "government", label: "Gobierno", icon: Landmark },
  { id: "social", label: "Social", icon: Users },
  { id: "web", label: "Web", icon: Globe },
]

type Result = {
  id: string
  sourceProvider: string
  category: string
  title: string
  snippet?: string
  url?: string
  imageUrl?: string
  price?: number
  currency?: string
  location?: string
  datePublished?: string
  author?: string
  metadata?: Record<string, any>
}

type ProviderTrace = {
  providerId: string
  category: string
  ok: boolean
  count: number
  durationMs: number
  error?: string
}

type ProviderMeta = {
  id: string
  category: string
  region: string
  requiresKey: boolean
  configured: boolean
  active: boolean
  disabledReason?: string
}

type PublicSettings = {
  region: string
  mode: "local" | "cloud"
  userEmail: string | null
  keysConfigured: string[]
}

function authHeaders(json = true): HeadersInit {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export function UniversalSearchPanel() {
  const [query, setQuery] = React.useState("")
  const [region, setRegion] = React.useState("global")
  const [mode, setMode] = React.useState<"local" | "cloud">("local")
  const [categories, setCategories] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(false)
  const [response, setResponse] = React.useState<any | null>(null)
  const [settings, setSettings] = React.useState<PublicSettings | null>(null)
  const [providers, setProviders] = React.useState<ProviderMeta[]>([])

  const providerStats = React.useMemo(() => {
    const active = providers.filter((p) => p.active).length
    const configured = providers.filter((p) => p.configured).length
    const keyGated = providers.filter((p) => p.requiresKey && !p.configured).length
    return { active, configured, keyGated, total: providers.length }
  }, [providers])

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [settingsRes, providersRes] = await Promise.all([
          fetch(`${API_ROOT}/search-brain/settings`, { credentials: "include", headers: authHeaders(false) }),
          fetch(`${API_ROOT}/search-brain/universal/providers`, { credentials: "include", headers: authHeaders(false) }),
        ])
        const settingsJson = await settingsRes.json().catch(() => null)
        const providersJson = await providersRes.json().catch(() => null)
        if (cancelled) return
        if (settingsRes.ok && settingsJson) {
          setSettings(settingsJson)
          setRegion(settingsJson.region || "global")
          setMode(settingsJson.mode === "cloud" ? "cloud" : "local")
        }
        if (providersRes.ok && Array.isArray(providersJson?.providers)) setProviders(providersJson.providers)
      } catch {
        if (!cancelled) toast.error("No se pudo cargar configuración de SearchBrain")
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  function toggleCategory(id: string) {
    setCategories((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id])
  }

  async function updateSetting(kind: "region" | "mode", value: string) {
    if (kind === "region") setRegion(value)
    if (kind === "mode") setMode(value === "cloud" ? "cloud" : "local")
    try {
      const res = await fetch(`${API_ROOT}/search-brain/settings/${kind}`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: JSON.stringify({ [kind]: value }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const settingsRes = await fetch(`${API_ROOT}/search-brain/settings`, { credentials: "include", headers: authHeaders(false) })
      if (settingsRes.ok) setSettings(await settingsRes.json())
    } catch {
      toast.error("No se pudo guardar la configuración")
    }
  }

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault()
    if (!query.trim() || loading) return
    setLoading(true)
    setResponse(null)
    try {
      const res = await fetch(`${API_ROOT}/search-brain/universal`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: JSON.stringify({
          query: query.trim(),
          region,
          categories: categories.length ? categories : undefined,
          maxResults: 18,
          mode,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      setResponse(json)
    } catch (err: any) {
      toast.error(err?.message || "No se pudo buscar")
    } finally {
      setLoading(false)
    }
  }

  const results: Result[] = Array.isArray(response?.results) ? response.results : []
  const traces: ProviderTrace[] = Array.isArray(response?.providers) ? response.providers : []
  const failed: ProviderTrace[] = Array.isArray(response?.failedProviders) ? response.failedProviders : traces.filter((p) => !p.ok)
  const synthesis = buildSynthesis(query, results, Boolean(response?.reranked))

  return (
    <div className="mx-auto grid min-h-screen max-w-7xl grid-cols-1 gap-5 px-4 py-6 lg:grid-cols-[1fr_380px] lg:px-8">
      <main className="space-y-4">
        <header className="space-y-2">
          <h1 className="text-3xl font-serif tracking-tight">UniversalSearchBrain</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Búsqueda académica, web y vertical con trazabilidad por proveedor, cache y ranking auditado.
          </p>
        </header>

        <form onSubmit={runSearch} className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Busca papers, empleo, precios, noticias, clima, finanzas..."
              className="h-12 border-0 bg-transparent text-base shadow-none focus-visible:ring-0"
            />
            <Button type="submit" disabled={!query.trim() || loading} className="h-12 gap-2">
              {loading ? <ThinkingIndicator size="sm" /> : <Search className="h-4 w-4" />}
              Buscar
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {REGIONS.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => updateSetting("region", r.id)}
                className={cn("rounded-full border px-3 py-1 text-xs font-medium", region === r.id ? "bg-foreground text-background" : "bg-background hover:bg-muted")}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon
              const active = categories.includes(cat.id)
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => toggleCategory(cat.id)}
                  className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium", active ? "border-primary bg-primary/10 text-primary" : "bg-background hover:bg-muted")}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {cat.label}
                </button>
              )
            })}
          </div>
        </form>

        {response && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{results.length} resultados</Badge>
            <Badge variant="outline">Intents: {(response.intents || []).join(", ")}</Badge>
            <Badge variant="outline">{response.cacheHit ? "cache" : "live"}</Badge>
            <Badge variant="outline">{response.dedupedCandidates ?? results.length}/{response.totalCandidates ?? results.length} candidatos</Badge>
            <span>{response.timings?.totalMs || 0} ms</span>
          </div>
        )}

        <div className="grid gap-3">
          {loading && Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-28 animate-pulse rounded-xl border bg-muted/30" />)}
          {!loading && results.map((item, index) => <ResultCard key={`${item.id}-${index}`} item={item} index={index} />)}
          {!loading && response && results.length === 0 && (
            <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No hubo resultados con los proveedores activos. Prueba otra categoría o configura claves gratuitas.</CardContent></Card>
          )}
        </div>
      </main>

      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Settings2 className="h-4 w-4" /> Configuración</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex rounded-lg border p-1">
              {(["local", "cloud"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => updateSetting("mode", m)}
                  className={cn("flex-1 rounded-md px-3 py-1.5 text-xs font-medium", mode === m ? "bg-foreground text-background" : "hover:bg-muted")}
                >
                  {m === "local" ? "Modo local" : "Modo cloud"}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Metric label="Activos" value={providerStats.active} />
              <Metric label="Configurados" value={providerStats.configured} />
              <Metric label="Con key" value={providerStats.keyGated} />
            </div>
            <div className="rounded-lg border p-3 text-xs text-muted-foreground">
              {mode === "local" ? "Las consultas salen desde el servidor donde corre siraGPT." : "En cloud, la IP saliente es la del servidor desplegado."}
              {settings?.keysConfigured?.length ? <div className="mt-2">Keys: {settings.keysConfigured.join(", ")}</div> : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Síntesis auditada</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">{synthesis}</p>
            <div className="space-y-2">
              {results.slice(0, 8).map((r, i) => (
                <a key={r.id} href={r.url || "#"} target="_blank" rel="noreferrer" className="block rounded-lg border p-2 hover:bg-muted">
                  <span className="font-medium">[{i + 1}]</span> {r.title}
                </a>
              ))}
            </div>
          </CardContent>
        </Card>

        {response && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Trazas</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {traces.slice(0, 12).map((trace) => (
                <div key={trace.providerId} className="flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5">
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    {trace.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <XCircle className="h-3.5 w-3.5 text-red-600" />}
                    <span className="truncate">{trace.providerId}</span>
                  </span>
                  <span className="text-muted-foreground">{trace.count} · {trace.durationMs}ms</span>
                </div>
              ))}
              {failed.length > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-amber-900">
                  <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                  {failed.length} proveedor(es) fallaron sin detener la búsqueda.
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </aside>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-2">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

function ResultCard({ item, index }: { item: Result; index: number }) {
  const price = typeof item.price === "number" ? `${item.currency || "USD"} ${item.price.toLocaleString()}` : null
  const apa = buildApa(item)
  const label = categoryActionLabel(item.category)

  async function copyApa() {
    try {
      await navigator.clipboard.writeText(apa)
      toast.success("Cita copiada")
    } catch {
      toast.error("No se pudo copiar")
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardContent className="flex gap-4 p-4">
        {item.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.imageUrl} alt="" className="h-20 w-20 shrink-0 rounded-md object-cover" />
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">[{index + 1}] {item.category}</Badge>
            <Badge variant="outline">{item.sourceProvider}</Badge>
            {price && <Badge>{price}</Badge>}
            {item.metadata?.openAccess || item.metadata?.isOa ? <Badge className="bg-emerald-600">OA</Badge> : null}
            {item.metadata?.searchBrainScore ? <Badge variant="outline">score {item.metadata.searchBrainScore}</Badge> : null}
          </div>
          <h2 className="text-base font-semibold leading-snug">{item.title}</h2>
          {item.snippet && <p className="line-clamp-3 text-sm text-muted-foreground">{item.snippet}</p>}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {item.author && <span>{item.author}</span>}
            {item.location && <span>{item.location}</span>}
            {item.datePublished && <span>{formatYear(item.datePublished)}</span>}
            {item.metadata?.citationCount ? <span>{item.metadata.citationCount} citas</span> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {item.url && (
              <Button size="sm" variant="outline" asChild>
                <a href={item.url} target="_blank" rel="noreferrer"><ExternalLink className="mr-1.5 h-3.5 w-3.5" /> {label}</a>
              </Button>
            )}
            {item.category === "academic" && (
              <Button size="sm" variant="ghost" onClick={copyApa}><Copy className="mr-1.5 h-3.5 w-3.5" /> APA 7</Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
