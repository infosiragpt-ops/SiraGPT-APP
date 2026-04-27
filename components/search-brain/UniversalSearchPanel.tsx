"use client"

import * as React from "react"
import {
  BookOpen, Briefcase, ShoppingCart, Newspaper, DollarSign, Cloud, Plane,
  Home, UtensilsCrossed, Heart, GraduationCap, Scale, Landmark, Users,
  Globe, Search, Loader2, ExternalLink, Copy,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

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

export function UniversalSearchPanel() {
  const [query, setQuery] = React.useState("")
  const [region, setRegion] = React.useState("global")
  const [categories, setCategories] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(false)
  const [response, setResponse] = React.useState<any | null>(null)

  function toggleCategory(id: string) {
    setCategories((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id])
  }

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault()
    if (!query.trim() || loading) return
    setLoading(true)
    setResponse(null)
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
      const res = await fetch(`${API_ROOT}/search-brain/universal`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          query: query.trim(),
          region,
          categories: categories.length ? categories : undefined,
          maxResults: 18,
          mode: "local",
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
  const synthesis = buildSynthesis(query, results)

  return (
    <div className="mx-auto grid min-h-screen max-w-7xl grid-cols-1 gap-5 px-4 py-6 lg:grid-cols-[1fr_360px] lg:px-8">
      <main className="space-y-4">
        <header className="space-y-2">
          <h1 className="text-3xl font-serif tracking-tight">UniversalSearchBrain</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Búsqueda académica, web y vertical con proveedores gratuitos o de registro libre. En modo local, las consultas salen desde el servidor donde corre siraGPT.
          </p>
        </header>

        <form onSubmit={runSearch} className="rounded-2xl border bg-card p-3 shadow-sm">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Busca papers, empleo, precios, noticias, clima, finanzas..."
              className="h-12 border-0 bg-transparent text-base shadow-none focus-visible:ring-0"
            />
            <Button type="submit" disabled={!query.trim() || loading} className="h-12 gap-2">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Buscar
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {REGIONS.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRegion(r.id)}
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
            <Badge variant="secondary">{response.results?.length || 0} resultados</Badge>
            <Badge variant="outline">Intents: {(response.intents || []).join(", ")}</Badge>
            <Badge variant="outline">{response.cacheHit ? "cache" : "live"}</Badge>
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
            <CardTitle className="text-base">Síntesis</CardTitle>
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
      </aside>
    </div>
  )
}

function ResultCard({ item, index }: { item: Result; index: number }) {
  const price = typeof item.price === "number" ? `${item.currency || "USD"} ${item.price.toLocaleString()}` : null
  const apa = buildApa(item)

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
            {item.metadata?.openAccess && <Badge className="bg-emerald-600">OA</Badge>}
          </div>
          <h2 className="text-base font-semibold leading-snug">{item.title}</h2>
          {item.snippet && <p className="line-clamp-3 text-sm text-muted-foreground">{item.snippet}</p>}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {item.author && <span>{item.author}</span>}
            {item.location && <span>{item.location}</span>}
            {item.datePublished && <span>{new Date(item.datePublished).getFullYear() || item.datePublished}</span>}
          </div>
          <div className="flex gap-2">
            {item.url && (
              <Button size="sm" variant="outline" asChild>
                <a href={item.url} target="_blank" rel="noreferrer"><ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Abrir</a>
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

function buildApa(item: Result) {
  const year = item.metadata?.year || (item.datePublished ? new Date(item.datePublished).getFullYear() : "s. f.")
  const author = item.author || "Autor desconocido"
  const venue = item.metadata?.venue || item.metadata?.journal || item.sourceProvider
  const doi = item.metadata?.doi ? ` https://doi.org/${item.metadata.doi}` : item.url ? ` ${item.url}` : ""
  return `${author} (${year}). ${item.title}. ${venue}.${doi}`
}

function buildSynthesis(query: string, results: Result[]) {
  if (!query.trim()) return "La síntesis aparecerá aquí con citas numeradas cuando ejecutes una búsqueda."
  if (results.length === 0) return "Sin resultados todavía. UniversalSearchBrain consultará proveedores activos y mostrará trazabilidad por fuente."
  const top = results.slice(0, 3).map((r, i) => `[${i + 1}] ${r.title}`).join("; ")
  return `Para “${query}”, las fuentes mejor rankeadas son ${top}. Usa los enlaces numerados para auditar cada resultado.`
}
