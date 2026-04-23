"use client"

/**
 * /marketing — intelligent social-publishing agent.
 *
 * Sections:
 *   Left   · Composer — idea textarea, palette picker (named
 *            palettes, not raw swatches), reference-image drop zone,
 *            orientation / animation / price chips, model badge.
 *   Centre · Programación — mode toggle (un post vs serie), date+
 *            time inputs (for single) / start-date + cadence +
 *            count + time-of-day (for series), social-network
 *            multi-select with green check badge. Unconnected
 *            networks trigger a Connect modal when toggled.
 *   Right  · Preview — live social card (header + image + caption),
 *            aspect changes with orientation.
 *
 * Below: programmed posts list with status pill + per-platform icons
 * + batch badge when applicable.
 */

import * as React from "react"
import { toast } from "sonner"
import {
  Calendar as CalendarIcon, Clock, Sparkles, Send, Image as ImageIcon,
  Facebook, Instagram, Youtube, Linkedin, Music2,
  Check, Loader2, Trash2, Megaphone, UploadCloud, X, Palette as PaletteIcon,
  Layers, Repeat, Wand2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  marketingService, PLATFORMS, DEFAULT_MODEL, PALETTES,
  type Platform, type ScheduledPost, type ReferenceImage, type Cadence,
  type ConnectionsStatus,
} from "@/lib/marketing-service"
import { ConnectSocialModal } from "@/components/marketing/connect-social-modal"

// ─── Filter groups ───────────────────────────────────────────────────────

const ORIENTATIONS = ["cuadrado", "vertical", "horizontal"] as const
const ANIMATIONS = ["estáticos", "animados"] as const
const PRICES = ["gratis", "pro"] as const

function PlatformIcon({ platform, className }: { platform: Platform; className?: string }) {
  const common = cn("h-5 w-5", className)
  switch (platform) {
    case "facebook":  return <Facebook className={common} strokeWidth={1.8} />
    case "instagram": return <Instagram className={common} strokeWidth={1.8} />
    case "youtube":   return <Youtube className={common} strokeWidth={1.8} />
    case "linkedin":  return <Linkedin className={common} strokeWidth={1.8} />
    case "tiktok":    return <Music2 className={common} strokeWidth={1.8} />
  }
}

// ─── Scheduler helpers ───────────────────────────────────────────────────

function pad(n: number) { return String(n).padStart(2, "0") }
const toLocalDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const toLocalTimeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
function nextRoundHour(): Date {
  const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d
}

const MAX_REFS = 6

export default function MarketingPage() {
  // ── Composer state ───────────────────────────────────────────────
  const [prompt, setPrompt] = React.useState("")
  const [paletteId, setPaletteId] = React.useState<string>(PALETTES[0].id)
  const [orientation, setOrientation] = React.useState<(typeof ORIENTATIONS)[number]>("cuadrado")
  const [animation, setAnimation] = React.useState<(typeof ANIMATIONS)[number]>("estáticos")
  const [price, setPrice] = React.useState<(typeof PRICES)[number]>("gratis")
  const [references, setReferences] = React.useState<ReferenceImage[]>([])

  // ── Scheduler state ──────────────────────────────────────────────
  const [mode, setMode] = React.useState<"single" | "series">("single")
  const initialSched = React.useMemo(() => nextRoundHour(), [])
  const [date, setDate] = React.useState<string>(toLocalDateInput(initialSched))
  const [time, setTime] = React.useState<string>(toLocalTimeInput(initialSched))
  // Series controls
  const [count, setCount] = React.useState<number>(7)
  const [cadence, setCadence] = React.useState<Cadence>("daily")
  const [platforms, setPlatforms] = React.useState<Platform[]>(["facebook", "instagram"])

  // ── Generation state ─────────────────────────────────────────────
  const [imageUrl, setImageUrl] = React.useState<string | null>(null)
  const [imageModel, setImageModel] = React.useState<string>(DEFAULT_MODEL)
  const [generating, setGenerating] = React.useState(false)
  const [scheduling, setScheduling] = React.useState(false)

  // ── Posts + connections ──────────────────────────────────────────
  const [posts, setPosts] = React.useState<ScheduledPost[]>([])
  const [loadingPosts, setLoadingPosts] = React.useState(true)
  const [connStatus, setConnStatus] = React.useState<ConnectionsStatus | null>(null)
  const [connectModal, setConnectModal] = React.useState<Platform | null>(null)

  const refreshPosts = React.useCallback(async () => {
    try { setPosts(await marketingService.listPosts()) }
    finally { setLoadingPosts(false) }
  }, [])
  const refreshConnections = React.useCallback(async () => {
    try { const d = await marketingService.listConnections(); setConnStatus(d.status) }
    catch { /* non-fatal */ }
  }, [])
  React.useEffect(() => { refreshPosts(); refreshConnections() }, [refreshPosts, refreshConnections])

  // React to the OAuth callback redirect query string.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const q = new URLSearchParams(window.location.search)
    if (q.get("connected")) {
      toast.success(`Conectado a ${q.get("connected")}`)
      refreshConnections()
      // Clean URL
      window.history.replaceState({}, "", window.location.pathname)
    } else if (q.get("connect_error")) {
      toast.error(`Error conectando: ${q.get("connect_error")}`)
      window.history.replaceState({}, "", window.location.pathname)
    }
  }, [refreshConnections])

  const scheduledAtISO = React.useMemo(() => {
    if (!date || !time) return null
    const d = new Date(`${date}T${time}:00`)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }, [date, time])
  const palette = React.useMemo(() => PALETTES.find(p => p.id === paletteId) || PALETTES[0], [paletteId])

  function togglePlatform(p: Platform) {
    const currentlyConnected = connStatus?.[p]?.connected
    const currentlySelected = platforms.includes(p)
    // Selecting an unconnected network opens the Connect modal
    // instead of toggling — once the user connects, the caller can
    // tap again to select.
    if (!currentlySelected && !currentlyConnected) {
      setConnectModal(p)
      return
    }
    setPlatforms(prev =>
      prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]
    )
  }

  // ── Reference image handling ─────────────────────────────────────

  function addFiles(files: FileList | File[]) {
    const list = Array.from(files).slice(0, MAX_REFS - references.length)
    Promise.all(list.map(f => new Promise<ReferenceImage>((resolve, reject) => {
      if (!f.type.startsWith("image/")) {
        reject(new Error(`${f.name} no es una imagen`)); return
      }
      if (f.size > 5 * 1024 * 1024) {
        reject(new Error(`${f.name} supera 5 MB`)); return
      }
      const r = new FileReader()
      r.onload = () => resolve({ name: f.name, dataUrl: String(r.result), size: f.size, type: f.type })
      r.onerror = () => reject(new Error("no pude leer el archivo"))
      r.readAsDataURL(f)
    })))
      .then(imgs => setReferences(prev => [...prev, ...imgs].slice(0, MAX_REFS)))
      .catch((err: any) => toast.error(err?.message || "Error leyendo imagen"))
  }

  function removeRef(i: number) {
    setReferences(prev => prev.filter((_, idx) => idx !== i))
  }

  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = React.useState(false)

  // ── Actions ──────────────────────────────────────────────────────

  async function handleGenerate() {
    if (!prompt.trim()) { toast.error("Escribe una idea para generar la imagen"); return }
    setGenerating(true)
    try {
      const res = await marketingService.generateImage({
        prompt, model: imageModel, orientation,
        color: palette.vibe,                // we pass the vibe, not the id
        animation, price, platforms,
      })
      setImageUrl(res.imageUrl)
      setImageModel(res.model)
      toast.success("Imagen generada")
    } catch (err: any) {
      toast.error(err?.message || "Error generando imagen")
    } finally { setGenerating(false) }
  }

  async function handleScheduleSingle() {
    if (!prompt.trim()) { toast.error("Escribe una idea primero"); return }
    if (platforms.length === 0) { toast.error("Selecciona al menos una red"); return }
    if (!scheduledAtISO) { toast.error("Elige fecha y hora"); return }
    setScheduling(true)
    try {
      const saved = await marketingService.savePost({
        prompt, imageUrl: imageUrl || undefined, imageModel,
        platforms, scheduledAt: scheduledAtISO, status: "scheduled",
        config: { palette: palette.id, orientation, animation, price },
        referenceImages: references.length ? references : null,
      } as any)
      toast.success("Post programado")
      setPosts(prev => [saved, ...prev.filter(p => p.id !== saved.id)])
    } catch (err: any) {
      toast.error(err?.message || "No se pudo programar")
    } finally { setScheduling(false) }
  }

  async function handleScheduleSeries() {
    if (!prompt.trim()) { toast.error("Escribe el tema / idea del negocio primero"); return }
    if (platforms.length === 0) { toast.error("Selecciona al menos una red"); return }
    if (!scheduledAtISO) { toast.error("Elige fecha y hora de inicio"); return }
    if (count < 2 || count > 30) { toast.error("La serie debe tener entre 2 y 30 posts"); return }
    setScheduling(true)
    try {
      const result = await marketingService.batchSchedule({
        prompt, count, cadence,
        startDate: new Date(`${date}T00:00:00`).toISOString(),
        timeOfDay: time,
        platforms,
        model: imageModel,
        orientation,
        palette: palette.vibe,
        animation,
        price,
        referenceImages: references.length ? references : undefined,
        generateImages: true,
      })
      toast.success(`${result.count} posts programados`)
      setPosts(prev => [...result.posts, ...prev])
    } catch (err: any) {
      toast.error(err?.message || "No se pudo programar la serie")
    } finally { setScheduling(false) }
  }

  async function handleDelete(id: string) {
    try {
      await marketingService.deletePost(id)
      setPosts(prev => prev.filter(p => p.id !== id))
    } catch (err: any) { toast.error(err?.message || "No se pudo eliminar") }
  }

  const aspect = orientation === "vertical" ? "aspect-[9/16]"
               : orientation === "horizontal" ? "aspect-video"
               : "aspect-square"

  return (
    <div className="flex h-[calc(100vh-0px)] w-full flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border/60 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 border border-blue-200 text-blue-600">
            <Megaphone className="h-[18px] w-[18px]" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Marketing · Agente de publicación</div>
            <div className="text-base font-semibold tracking-tight">Programa contenido automático en todas tus redes</div>
          </div>
        </div>
        <Badge variant="outline" className="font-mono text-[11px]">{imageModel}</Badge>
      </header>

      <div className="grid flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[380px_1fr_420px]">
        {/* ─── Composer ──────────────────────────────────────────── */}
        <aside className="overflow-y-auto border-r border-border/60 bg-card px-4 py-4 space-y-5">
          <section>
            <label className="text-xs font-medium text-foreground/80">Idea del post</label>
            <Textarea
              value={prompt} onChange={e => setPrompt(e.target.value)}
              placeholder="Describe qué quieres publicar: tema, tono, detalles de marca…"
              rows={5}
              className="mt-1.5 resize-none text-[13px]"
            />
          </section>

          {/* Reference images — replaces the old "caption" textarea. */}
          <section>
            <label className="text-xs font-medium text-foreground/80 flex items-center gap-1.5">
              <UploadCloud className="h-3.5 w-3.5" />
              Subir imágenes de referencia
              <span className="ml-auto text-[10.5px] font-normal text-muted-foreground">
                {references.length}/{MAX_REFS}
              </span>
            </label>
            <div
              onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setDragActive(true) }}
              onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragActive(true) }}
              onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setDragActive(false) }}
              onDrop={e => {
                e.preventDefault(); e.stopPropagation(); setDragActive(false)
                if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
              }}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "mt-1.5 flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed py-5 text-center text-[12px] transition",
                dragActive
                  ? "border-foreground/60 bg-muted/40"
                  : "border-border/60 text-muted-foreground hover:border-border hover:bg-muted/20"
              )}
            >
              <UploadCloud className="h-5 w-5" />
              <div>
                <span className="font-medium text-foreground">Suelta imágenes aquí</span>{" "}
                o haz click
              </div>
              <div className="text-[10.5px]">JPG / PNG · hasta 5 MB · {MAX_REFS} como máximo</div>
              <input
                ref={fileInputRef}
                type="file" accept="image/*" multiple
                onChange={e => { if (e.target.files) addFiles(e.target.files); e.currentTarget.value = "" }}
                className="hidden"
              />
            </div>
            {references.length > 0 && (
              <div className="mt-2 grid grid-cols-4 gap-1.5">
                {references.map((r, i) => (
                  <div key={i} className="group relative aspect-square overflow-hidden rounded-md border border-border/60 bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.dataUrl} alt={r.name} className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); removeRef(i) }}
                      className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition group-hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Paleta de colores — replaces the raw color swatches. */}
          <section>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground/80">
              <PaletteIcon className="h-3.5 w-3.5" />
              Paleta de colores
            </div>
            <div className="space-y-1.5">
              {PALETTES.map(p => {
                const active = paletteId === p.id
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPaletteId(p.id)}
                    className={cn(
                      "group/pal w-full rounded-lg border p-2 text-left transition",
                      active
                        ? "border-foreground/40 bg-foreground/5"
                        : "border-border/50 hover:border-border hover:bg-muted/20"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex h-6 overflow-hidden rounded-md shadow-sm">
                        {p.swatches.map((hex, i) => (
                          <span key={i} className="block w-5" style={{ backgroundColor: hex }} />
                        ))}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-[12.5px] font-medium">{p.name}</div>
                        <div className="truncate text-[10.5px] text-muted-foreground">{p.vibe}</div>
                      </div>
                      {active && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-foreground/70" strokeWidth={3} />
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </section>

          <FilterGroup label="Orientación" options={ORIENTATIONS as unknown as string[]}
            value={orientation} onChange={v => setOrientation(v as any)} />
          <FilterGroup label="Animación" options={ANIMATIONS as unknown as string[]}
            value={animation} onChange={v => setAnimation(v as any)} />
          <FilterGroup label="Precio" options={PRICES as unknown as string[]}
            value={price} onChange={v => setPrice(v as any)} />

          <Button
            onClick={handleGenerate}
            disabled={generating || !prompt.trim()}
            className="w-full"
          >
            {generating
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generando imagen…</>
              : <><Sparkles className="mr-2 h-4 w-4" />Generar imagen</>}
          </Button>
        </aside>

        {/* ─── Scheduler + platforms ─────────────────────────────── */}
        <main className="overflow-y-auto px-6 py-5 space-y-6">
          {/* Mode toggle — single vs series */}
          <section>
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-foreground/85">
              <Layers className="h-4 w-4" />
              Programación
            </div>
            <div className="grid grid-cols-2 gap-2">
              <ModeCard
                active={mode === "single"}
                onClick={() => setMode("single")}
                title="Un post"
                subtitle="Programa una única publicación"
                Icon={Sparkles}
              />
              <ModeCard
                active={mode === "series"}
                onClick={() => setMode("series")}
                title="Serie automática"
                subtitle="La IA genera N posts distintos y los distribuye"
                Icon={Wand2}
              />
            </div>
          </section>

          {mode === "single" ? (
            <section>
              <div className="flex flex-wrap gap-3">
                <div className="flex-1 min-w-[180px]">
                  <label className="text-[11px] text-muted-foreground">Fecha</label>
                  <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1" />
                </div>
                <div className="flex-1 min-w-[140px]">
                  <label className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" /> Hora
                  </label>
                  <Input type="time" value={time} onChange={e => setTime(e.target.value)} className="mt-1" />
                </div>
              </div>
              {scheduledAtISO && (
                <p className="mt-2 text-[11.5px] text-muted-foreground">
                  Se publicará el {new Date(scheduledAtISO).toLocaleString("es", { dateStyle: "long", timeStyle: "short" })}.
                </p>
              )}
            </section>
          ) : (
            <section className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="text-[11px] text-muted-foreground">Cantidad</label>
                  <Input
                    type="number" min={2} max={30}
                    value={count}
                    onChange={e => setCount(Math.max(2, Math.min(30, Number(e.target.value) || 2)))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <Repeat className="h-3 w-3" /> Cadencia
                  </label>
                  <select
                    value={cadence}
                    onChange={e => setCadence(e.target.value as Cadence)}
                    className="mt-1 h-9 w-full rounded-md border border-border/60 bg-background px-2 text-[13px]"
                  >
                    <option value="daily">Un post por día</option>
                    <option value="every-2-days">Uno cada 2 días</option>
                    <option value="weekly">Uno por semana</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" /> Hora del día
                  </label>
                  <Input type="time" value={time} onChange={e => setTime(e.target.value)} className="mt-1" />
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <div className="flex-1 min-w-[180px]">
                  <label className="text-[11px] text-muted-foreground">Primer post</label>
                  <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1" />
                </div>
              </div>
              <p className="text-[11.5px] text-muted-foreground">
                La IA generará {count} ideas distintas y las publicará a las {time} cada {cadence === "daily" ? "día" : cadence === "every-2-days" ? "2 días" : "semana"}.
              </p>
            </section>
          )}

          <section>
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-foreground/85">
              <Send className="h-4 w-4" />
              Redes sociales
              <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                Conecta tu cuenta para publicar y para que la IA entienda tu negocio
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {PLATFORMS.map(p => {
                const active = platforms.includes(p.id)
                const connected = !!connStatus?.[p.id]?.connected
                return (
                  <button
                    key={p.id} type="button"
                    onClick={() => togglePlatform(p.id)}
                    className={cn(
                      "group relative flex flex-col items-center justify-center rounded-xl border p-3 transition-all",
                      active
                        ? "border-foreground/40 bg-foreground/5 shadow-sm"
                        : "border-border/60 hover:border-border hover:bg-muted/30"
                    )}
                    style={active ? { boxShadow: `0 0 0 1px ${p.color}20` } : undefined}
                  >
                    <PlatformIcon
                      platform={p.id}
                      className={cn("mb-1.5 h-6 w-6 transition", active ? "" : "opacity-60 group-hover:opacity-100")}
                    />
                    <span className="text-[12px] font-medium">{p.label}</span>
                    <span className="text-[10.5px] text-muted-foreground">
                      {connected
                        ? (connStatus?.[p.id]?.accountName || "Conectado")
                        : p.hint}
                    </span>
                    {active && (
                      <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white shadow">
                        <Check className="h-3 w-3" strokeWidth={3} />
                      </span>
                    )}
                    {!connected && (
                      <span className="mt-1 inline-flex items-center rounded-full border border-border/60 bg-background px-1.5 text-[9.5px] uppercase tracking-wider text-muted-foreground">
                        Conectar
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </section>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              onClick={mode === "single" ? handleScheduleSingle : handleScheduleSeries}
              disabled={
                scheduling || !prompt.trim() || platforms.length === 0 || !scheduledAtISO
                || (mode === "series" && (count < 2 || count > 30))
              }
              className="flex-1"
            >
              {scheduling
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Programando…</>
                : mode === "single"
                  ? <><CalendarIcon className="mr-2 h-4 w-4" />Programar publicación</>
                  : <><Wand2 className="mr-2 h-4 w-4" />Generar y programar {count} posts</>}
            </Button>
            {imageUrl && (
              <Button variant="outline" onClick={() => setImageUrl(null)} className="sm:w-40">
                Nueva imagen
              </Button>
            )}
          </div>

          {/* Programmed posts list */}
          <section className="pt-2">
            <div className="mb-2 text-[12.5px] font-semibold text-foreground/85">Programados</div>
            {loadingPosts ? (
              <div className="text-[12px] text-muted-foreground">Cargando…</div>
            ) : posts.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-4 text-center text-[12px] text-muted-foreground">
                Aún no tienes publicaciones programadas. Crea la primera arriba.
              </div>
            ) : (
              <ul className="space-y-2">
                {posts.map(p => (
                  <li key={p.id} className="flex items-center gap-3 rounded-lg border border-border/60 bg-card p-2.5">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-muted">
                      {p.imageUrl
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={p.imageUrl} alt="" className="h-full w-full object-cover" />
                        : <div className="flex h-full w-full items-center justify-center text-muted-foreground"><ImageIcon className="h-4 w-4" /></div>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{p.prompt}</div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className={cn(
                          "inline-flex items-center rounded-full px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wider",
                          statusStyle(p.status),
                        )}>{p.status}</span>
                        {p.scheduledAt && (
                          <span>{new Date(p.scheduledAt).toLocaleString("es", { dateStyle: "short", timeStyle: "short" })}</span>
                        )}
                        <span>·</span>
                        <span className="flex items-center gap-0.5">
                          {p.platforms.map(pl => <PlatformIcon key={pl} platform={pl} className="h-3.5 w-3.5" />)}
                        </span>
                        {p.batchId && (
                          <span className="ml-auto rounded-full border border-border/60 px-1.5 text-[9.5px] uppercase tracking-wider">Serie</span>
                        )}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(p.id)} className="h-8 px-2">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>

        {/* ─── Preview ───────────────────────────────────────────── */}
        <aside className="overflow-y-auto border-l border-border/60 bg-muted/10 px-4 py-5">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Vista previa</div>
          <div className="rounded-xl border border-border/60 bg-background shadow-sm overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
              <div className="h-7 w-7 rounded-full bg-gradient-to-br from-rose-500 via-amber-500 to-indigo-500" />
              <div className="flex-1">
                <div className="text-[12px] font-semibold">tu_marca</div>
                <div className="text-[10px] text-muted-foreground">Publicación programada</div>
              </div>
              {platforms.map(p => (
                <PlatformIcon key={p} platform={p} className="h-3.5 w-3.5 text-muted-foreground" />
              ))}
            </div>
            <div className={cn("relative w-full bg-muted flex items-center justify-center", aspect)}>
              {imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageUrl} alt="preview" className="h-full w-full object-cover" />
              ) : (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <ImageIcon className="h-8 w-8 opacity-50" />
                  <span className="text-[11px]">La imagen aparecerá aquí</span>
                </div>
              )}
            </div>
            {prompt && (
              <div className="px-3 py-2 text-[12px]">
                <span className="font-semibold mr-1">tu_marca</span>
                <span className="text-foreground/85 line-clamp-3">{prompt}</span>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
              <span>
                {mode === "series"
                  ? `Serie · ${count} posts · ${cadence === "daily" ? "diario" : cadence === "every-2-days" ? "cada 2 días" : "semanal"}`
                  : scheduledAtISO
                    ? new Date(scheduledAtISO).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" })
                    : "Sin fecha"}
              </span>
              <span>{platforms.length === 0 ? "Sin red" : `→ ${platforms.length} red${platforms.length === 1 ? "" : "es"}`}</span>
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-border/50 bg-background p-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-foreground/80">
              <div className="flex h-4 overflow-hidden rounded-sm">
                {palette.swatches.map((h, i) => <span key={i} className="block w-2.5" style={{ backgroundColor: h }} />)}
              </div>
              {palette.name}
            </div>
            <div className="text-[11px] leading-snug text-muted-foreground">{palette.vibe}</div>
          </div>
        </aside>
      </div>

      <ConnectSocialModal
        platform={connectModal}
        status={connStatus}
        onClose={() => setConnectModal(null)}
        onConnected={() => { refreshConnections(); toast.success("Cuenta conectada") }}
      />
    </div>
  )
}

function FilterGroup({ label, options, value, onChange }: {
  label: string; options: string[]; value: string; onChange: (v: string) => void
}) {
  return (
    <section>
      <div className="mb-1.5 text-xs font-medium text-foreground/80">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map(o => (
          <button key={o} type="button" onClick={() => onChange(o)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[11.5px] capitalize transition-all",
              value === o
                ? "border-foreground bg-foreground text-background"
                : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground"
            )}
          >{o}</button>
        ))}
      </div>
    </section>
  )
}

function ModeCard({ active, onClick, title, subtitle, Icon }: {
  active: boolean; onClick: () => void; title: string; subtitle: string; Icon: any
}) {
  return (
    <button
      type="button" onClick={onClick}
      className={cn(
        "rounded-xl border p-3 text-left transition",
        active
          ? "border-foreground/60 bg-foreground/5 shadow-sm"
          : "border-border/60 hover:border-border hover:bg-muted/20"
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <Icon className="h-4 w-4" />
        <span className="text-[13px] font-semibold">{title}</span>
      </div>
      <div className="text-[11.5px] leading-snug text-muted-foreground">{subtitle}</div>
    </button>
  )
}

function statusStyle(status: string): string {
  switch (status) {
    case "scheduled":  return "bg-sky-100 text-sky-700"
    case "publishing": return "bg-amber-100 text-amber-700"
    case "published":  return "bg-emerald-100 text-emerald-700"
    case "failed":     return "bg-rose-100 text-rose-700"
    case "cancelled":  return "bg-neutral-200 text-neutral-700"
    default:           return "bg-neutral-100 text-neutral-700"
  }
}
