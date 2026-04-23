"use client"

/**
 * /marketing — intelligent social-publishing agent.
 *
 * Three-column layout:
 *   Left   · Composer — prompt textarea + chip filters (color,
 *            orientation, animation, price).
 *   Centre · Scheduler — date / hour / minute picker + platform
 *            multi-select with green check on each selected logo.
 *   Right  · Live preview — social-card mock with the generated
 *            image slot + caption.
 *
 * The Generate button calls the image model
 * (`openai/gpt-5.4-image-2` by default) through /api/marketing/
 * generate-image; Schedule persists everything as a ScheduledPost
 * row in status `scheduled`, ready for the worker to pick up.
 */

import * as React from "react"
import { toast } from "sonner"
import {
  Calendar as CalendarIcon, Clock, Sparkles, Send, Image as ImageIcon,
  Facebook, Instagram, Youtube, Linkedin, Music2,
  Check, Loader2, Trash2, Megaphone,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  marketingService, PLATFORMS, DEFAULT_MODEL,
  type Platform, type ScheduledPost,
} from "@/lib/marketing-service"

// ─── Filter chip definitions ─────────────────────────────────────────────

const COLORS = [
  { id: "indigo",   class: "bg-indigo-500",  hex: "#6366F1" },
  { id: "slate",    class: "bg-slate-700",   hex: "#334155" },
  { id: "sky",      class: "bg-sky-500",     hex: "#0EA5E9" },
  { id: "cyan",     class: "bg-cyan-500",    hex: "#06B6D4" },
  { id: "emerald",  class: "bg-emerald-500", hex: "#10B981" },
  { id: "lime",     class: "bg-lime-500",    hex: "#84CC16" },
  { id: "amber",    class: "bg-amber-500",   hex: "#F59E0B" },
  { id: "orange",   class: "bg-orange-500",  hex: "#F97316" },
  { id: "rose",     class: "bg-rose-500",    hex: "#F43F5E" },
  { id: "pink",     class: "bg-pink-500",    hex: "#EC4899" },
  { id: "violet",   class: "bg-violet-600",  hex: "#7C3AED" },
  { id: "neutral",  class: "bg-neutral-900", hex: "#111111" },
]

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
function toLocalDateInput(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function toLocalTimeInput(d: Date) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function nextRoundHour(): Date {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d
}

// ─── Page ────────────────────────────────────────────────────────────────

export default function MarketingPage() {
  const [prompt, setPrompt] = React.useState("")
  const [caption, setCaption] = React.useState("")
  const [color, setColor] = React.useState<string>("indigo")
  const [orientation, setOrientation] = React.useState<(typeof ORIENTATIONS)[number]>("cuadrado")
  const [animation, setAnimation] = React.useState<(typeof ANIMATIONS)[number]>("estáticos")
  const [price, setPrice] = React.useState<(typeof PRICES)[number]>("gratis")

  const initialSched = React.useMemo(() => nextRoundHour(), [])
  const [date, setDate] = React.useState<string>(toLocalDateInput(initialSched))
  const [time, setTime] = React.useState<string>(toLocalTimeInput(initialSched))
  const [platforms, setPlatforms] = React.useState<Platform[]>(["facebook", "instagram"])

  const [imageUrl, setImageUrl] = React.useState<string | null>(null)
  const [imageModel, setImageModel] = React.useState<string>(DEFAULT_MODEL)
  const [generating, setGenerating] = React.useState(false)
  const [scheduling, setScheduling] = React.useState(false)

  const [posts, setPosts] = React.useState<ScheduledPost[]>([])
  const [loadingPosts, setLoadingPosts] = React.useState(true)

  const refreshPosts = React.useCallback(async () => {
    try {
      const list = await marketingService.listPosts()
      setPosts(list)
    } catch (err: any) {
      console.error("[marketing] list error:", err?.message)
    } finally {
      setLoadingPosts(false)
    }
  }, [])
  React.useEffect(() => { refreshPosts() }, [refreshPosts])

  const scheduledAtISO = React.useMemo(() => {
    if (!date || !time) return null
    const d = new Date(`${date}T${time}:00`)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }, [date, time])

  function togglePlatform(p: Platform) {
    setPlatforms(prev =>
      prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]
    )
  }

  async function handleGenerate() {
    if (!prompt.trim()) {
      toast.error("Escribe una idea para generar la imagen")
      return
    }
    setGenerating(true)
    try {
      const res = await marketingService.generateImage({
        prompt, model: imageModel, orientation, color, animation, price, platforms,
      })
      setImageUrl(res.imageUrl)
      setImageModel(res.model)
      toast.success("Imagen generada")
    } catch (err: any) {
      toast.error(err?.message || "Error generando imagen")
    } finally {
      setGenerating(false)
    }
  }

  async function handleSchedule() {
    if (!prompt.trim()) { toast.error("Escribe una idea primero"); return }
    if (platforms.length === 0) { toast.error("Selecciona al menos una red"); return }
    if (!scheduledAtISO) { toast.error("Elige fecha y hora"); return }
    setScheduling(true)
    try {
      const saved = await marketingService.savePost({
        prompt, caption: caption || null, imageUrl: imageUrl || undefined,
        imageModel, platforms, scheduledAt: scheduledAtISO, status: "scheduled",
        config: { color, orientation, animation, price },
      })
      toast.success("Post programado")
      setPosts(prev => [saved, ...prev.filter(p => p.id !== saved.id)])
    } catch (err: any) {
      toast.error(err?.message || "No se pudo programar")
    } finally {
      setScheduling(false)
    }
  }

  async function handleDelete(id: string) {
    try {
      await marketingService.deletePost(id)
      setPosts(prev => prev.filter(p => p.id !== id))
    } catch (err: any) {
      toast.error(err?.message || "No se pudo eliminar")
    }
  }

  const aspect = orientation === "vertical" ? "aspect-[9/16]"
               : orientation === "horizontal" ? "aspect-video"
               : "aspect-square"

  return (
    <div className="flex h-[calc(100vh-0px)] w-full flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border/60 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 border border-blue-200 text-blue-600">
            <Megaphone className="h-4.5 w-4.5" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Marketing · Agente de publicación</div>
            <div className="text-base font-semibold tracking-tight">Programa tu contenido en todas las redes</div>
          </div>
        </div>
        <Badge variant="outline" className="font-mono text-[11px]">
          {imageModel}
        </Badge>
      </header>

      <div className="grid flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[360px_1fr_420px]">
        {/* ── Composer ────────────────────────────────────────────── */}
        <aside className="overflow-y-auto border-r border-border/60 bg-card px-4 py-4 space-y-5">
          <section>
            <label className="text-xs font-medium text-foreground/80">Idea del post</label>
            <Textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="Describe qué quieres publicar: tema, tono, detalles de marca…"
              rows={5}
              className="mt-1.5 resize-none text-[13px]"
            />
          </section>

          <section>
            <label className="text-xs font-medium text-foreground/80">Caption (opcional)</label>
            <Textarea
              value={caption}
              onChange={e => setCaption(e.target.value)}
              placeholder="Texto que acompañará al post. Se muestra bajo la imagen."
              rows={2}
              className="mt-1.5 resize-none text-[13px]"
            />
          </section>

          <section>
            <div className="mb-1.5 text-xs font-medium text-foreground/80">Color</div>
            <div className="grid grid-cols-6 gap-1.5">
              {COLORS.map(c => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setColor(c.id)}
                  aria-label={c.id}
                  className={cn(
                    "relative h-7 rounded-md border transition",
                    c.class,
                    color === c.id
                      ? "ring-2 ring-offset-2 ring-offset-background ring-foreground/60 border-transparent"
                      : "border-border/50 hover:scale-105"
                  )}
                />
              ))}
            </div>
          </section>

          <FilterGroup
            label="Orientación"
            options={ORIENTATIONS as unknown as string[]}
            value={orientation}
            onChange={v => setOrientation(v as any)}
          />
          <FilterGroup
            label="Animación"
            options={ANIMATIONS as unknown as string[]}
            value={animation}
            onChange={v => setAnimation(v as any)}
          />
          <FilterGroup
            label="Precio"
            options={PRICES as unknown as string[]}
            value={price}
            onChange={v => setPrice(v as any)}
          />

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

        {/* ── Scheduler + platforms ────────────────────────────────── */}
        <main className="overflow-y-auto px-6 py-5 space-y-6">
          <section>
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-foreground/85">
              <CalendarIcon className="h-4 w-4" />
              Programación
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="flex-1 min-w-[180px]">
                <label className="text-[11px] text-muted-foreground">Fecha</label>
                <Input
                  type="date"
                  value={date}
                  onChange={e => setDate(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div className="flex-1 min-w-[140px]">
                <label className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Hora
                </label>
                <Input
                  type="time"
                  value={time}
                  onChange={e => setTime(e.target.value)}
                  className="mt-1"
                />
              </div>
            </div>
            {scheduledAtISO && (
              <p className="mt-2 text-[11.5px] text-muted-foreground">
                Se publicará el {new Date(scheduledAtISO).toLocaleString("es", { dateStyle: "long", timeStyle: "short" })}.
              </p>
            )}
          </section>

          <section>
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-foreground/85">
              <Send className="h-4 w-4" />
              Redes sociales
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {PLATFORMS.map(p => {
                const active = platforms.includes(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
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
                    <span className="text-[10.5px] text-muted-foreground">{p.hint}</span>
                    {active && (
                      <span
                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white shadow"
                        aria-hidden
                      >
                        <Check className="h-3 w-3" strokeWidth={3} />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </section>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              onClick={handleSchedule}
              disabled={scheduling || !prompt.trim() || platforms.length === 0 || !scheduledAtISO}
              className="flex-1"
            >
              {scheduling
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Programando…</>
                : <><CalendarIcon className="mr-2 h-4 w-4" />Programar publicación</>}
            </Button>
            {imageUrl && (
              <Button
                variant="outline"
                onClick={() => { setImageUrl(null) }}
                className="sm:w-40"
              >
                Nueva imagen
              </Button>
            )}
          </div>

          {/* Scheduled list */}
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
                  <li
                    key={p.id}
                    className="flex items-center gap-3 rounded-lg border border-border/60 bg-card p-2.5"
                  >
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-muted">
                      {p.imageUrl
                        ? <img src={p.imageUrl} alt="" className="h-full w-full object-cover" />
                        : <div className="flex h-full w-full items-center justify-center text-muted-foreground"><ImageIcon className="h-4 w-4" /></div>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{p.prompt}</div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className={cn(
                          "inline-flex items-center rounded-full px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wider",
                          statusStyle(p.status),
                        )}>
                          {p.status}
                        </span>
                        {p.scheduledAt && (
                          <span>
                            {new Date(p.scheduledAt).toLocaleString("es", { dateStyle: "short", timeStyle: "short" })}
                          </span>
                        )}
                        <span>·</span>
                        <span className="flex items-center gap-0.5">
                          {p.platforms.map(pl => (
                            <PlatformIcon key={pl} platform={pl} className="h-3.5 w-3.5" />
                          ))}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => handleDelete(p.id)}
                      className="h-8 px-2"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>

        {/* ── Preview ─────────────────────────────────────────────── */}
        <aside className="overflow-y-auto border-l border-border/60 bg-muted/10 px-4 py-5">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Vista previa</div>
          <div className="rounded-xl border border-border/60 bg-background shadow-sm overflow-hidden">
            {/* Instagram-style card header */}
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
            {(caption || prompt) && (
              <div className="px-3 py-2 text-[12px]">
                <span className="font-semibold mr-1">tu_marca</span>
                <span className="text-foreground/85">{caption || prompt}</span>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
              <span>{scheduledAtISO
                ? new Date(scheduledAtISO).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" })
                : "Sin fecha"}</span>
              <span className="flex items-center gap-1">
                {platforms.length === 0
                  ? "Sin red"
                  : `→ ${platforms.length} red${platforms.length === 1 ? "" : "es"}`}
              </span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

function FilterGroup({
  label, options, value, onChange,
}: {
  label: string
  options: string[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <section>
      <div className="mb-1.5 text-xs font-medium text-foreground/80">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map(o => (
          <button
            key={o}
            type="button"
            onClick={() => onChange(o)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[11.5px] capitalize transition-all",
              value === o
                ? "border-foreground bg-foreground text-background"
                : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground"
            )}
          >
            {o}
          </button>
        ))}
      </div>
    </section>
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
