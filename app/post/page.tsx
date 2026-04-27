"use client"

import * as React from "react"
import { CalendarDays, ImagePlus, Instagram, Linkedin, Loader2, Palette, Send, Youtube } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

const NETWORKS = [
  { id: "instagram", label: "Instagram", icon: Instagram },
  { id: "linkedin", label: "LinkedIn", icon: Linkedin },
  { id: "youtube", label: "YouTube", icon: Youtube },
  { id: "tiktok", label: "TikTok", icon: Send },
  { id: "facebook", label: "Facebook", icon: Send },
]

export default function PostPage() {
  const [prompt, setPrompt] = React.useState("")
  const [paletteName, setPaletteName] = React.useState("Profesional azul")
  const [days, setDays] = React.useState(5)
  const [startDate, setStartDate] = React.useState("")
  const [platforms, setPlatforms] = React.useState<string[]>(["instagram"])
  const [referenceImages, setReferenceImages] = React.useState<any[]>([])
  const [saving, setSaving] = React.useState(false)

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
    if (!prompt.trim()) return toast.error("Escribe la idea del post")
    setSaving(true)
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
      const res = await fetch(`${API_ROOT}/social-posts/series`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ prompt, paletteName, days, startDate, platforms, referenceImages }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      toast.success(`Serie creada: ${json.posts?.length || 0} posts`)
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
        <p className="mt-1 text-sm text-muted-foreground">Programa contenido para varios días, usa imágenes de referencia y conecta redes sociales por login.</p>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
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
                  return (
                    <button key={network.id} type="button" onClick={() => togglePlatform(network.id)} className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${active ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>
                      <Icon className="h-4 w-4" /> {network.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <Button onClick={schedule} disabled={saving} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />}
              Programar contenido automático
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Conexiones</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {NETWORKS.map((network) => (
              <Button key={network.id} variant="outline" className="w-full justify-between" asChild>
                <a href={`${API_ROOT}/social-posts/connect/${network.id}`}>{network.label}<Send className="h-3.5 w-3.5" /></a>
              </Button>
            ))}
            <p className="pt-2 text-xs text-muted-foreground">El flujo actual deja preparada la conexión OAuth/stub; las credenciales reales de cada red se configuran por plataforma.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
