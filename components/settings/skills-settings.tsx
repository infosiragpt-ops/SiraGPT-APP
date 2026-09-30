"use client"

/**
 * Ajustes → Skills (claude.ai style).
 *
 *  «Tuyos»     — «Creado por ti» (own SKILL.md playbooks) and «De SiraGPT»
 *                (built-ins + catalog skills the user installed). Each row:
 *                open, «Probar en un chat», edit (own), download, switch off,
 *                delete / remove.
 *  «Descubrir» — featured skill, «Para ti» (ranked server-side with what
 *                SiraGPT remembers about the user), newest skills and real
 *                category counts. «Probar» opens a chat with the skill in
 *                the composer; «+» installs it.
 *  «Añadir»    — Crear con SiraGPT (skill-creator in a new chat), Escribir
 *                instrucciones (form), Subir una skill (.md, .zip, .skill).
 */

import * as React from "react"
import {
  ArrowLeft, ArrowUpDown, BarChart3, BookOpen, Briefcase, Check, Code2, Download, Eye, FileText,
  Image as ImageIcon, ListChecks, MessageSquare, MoreHorizontal, PenLine, Plus, Power,
  ScrollText, Search, Sparkles, Trash2, Upload, WandSparkles, Wrench,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  apiClient, type ChatSkillSummary, type SkillCatalogItem, type SkillDetail, type SkillLibraryItem,
  type SkillsDiscoverResponse,
} from "@/lib/api"
import { consumeSkillsTab, type SkillsSettingsTab } from "@/lib/chat/open-settings"
import { emitSkillsChanged, skillToMarkdown, startChatWithSkill } from "@/lib/chat/skills-events"
import { cn } from "@/lib/utils"

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_DESCRIPTION = 160
const MAX_BODY = 16000
const SKILL_CREATOR: ChatSkillSummary = {
  name: "skill-creator",
  title: "Creador de skills",
  description: "Crea una skill nueva conversando con SiraGPT.",
  source: "catalog",
}

const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "Datos y análisis": BarChart3,
  "Modelos y agentes de IA": Sparkles,
  "Negocios": Briefcase,
  "Productividad": ListChecks,
  "Escritura": PenLine,
  "Código": Code2,
  "Ingeniería": Wrench,
  "Investigación": BookOpen,
  "Archivos y documentos": FileText,
  "Diseños y medios": ImageIcon,
}

function CategoryIcon({ category, className }: { category?: string; className?: string }) {
  const Icon = (category && CATEGORY_ICONS[category]) || ScrollText
  return <Icon aria-hidden="true" className={className} />
}

/** «hace 13 h», «hace 7 d», «14 sept» — the claude.ai list style. */
export function formatSkillDate(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ""
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ""
  const diff = Math.max(0, now - at)
  const hour = 3_600_000
  if (diff < hour) return "hace un momento"
  if (diff < 24 * hour) return `hace ${Math.floor(diff / hour)} h`
  if (diff < 8 * 24 * hour) return `hace ${Math.floor(diff / (24 * hour))} d`
  return new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(at).replace(".", "")
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message && !/^HTTP \d+/.test(err.message) ? err.message : fallback
}

function downloadMarkdown(skill: { name: string; description?: string; body?: string }) {
  const blob = new Blob([skillToMarkdown(skill)], { type: "text/markdown;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${skill.name}-SKILL.md`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Read an uploaded skill: plain SKILL.md, or the SKILL.md inside a .zip / .skill package. */
async function readSkillUpload(file: File): Promise<string> {
  const lower = file.name.toLowerCase()
  if (lower.endsWith(".zip") || lower.endsWith(".skill")) {
    const { default: JSZip } = await import("jszip")
    const zip = await JSZip.loadAsync(file)
    const entry = Object.values(zip.files)
      .filter((f) => !f.dir && /(^|\/)SKILL\.md$/i.test(f.name))
      .sort((a, b) => a.name.split("/").length - b.name.split("/").length)[0]
    if (!entry) throw new Error("El paquete no contiene un SKILL.md.")
    return entry.async("string")
  }
  if (file.size > 64 * 1024) throw new Error("El archivo supera los 64 KB.")
  return file.text()
}

// ─────────────────────────────────────────────────────────────
// Editor («Escribir instrucciones» / «Editar»)
// ─────────────────────────────────────────────────────────────

type EditorState = { mode: "create" } | { mode: "edit"; skill: SkillDetail }

function SkillEditorDialog({
  state,
  onClose,
  onSaved,
}: {
  state: EditorState | null
  onClose: () => void
  onSaved: (name: string) => void
}) {
  const editing = state?.mode === "edit" ? state.skill : null
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [body, setBody] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!state) return
    setName(editing?.name || "")
    setDescription(editing?.description || "")
    setBody(editing?.body || "")
    setError(null)
  }, [state, editing])

  const nameOk = SKILL_NAME_RE.test(name)
  const canSave = nameOk && description.trim().length > 0 && description.length <= MAX_DESCRIPTION && body.trim().length > 0 && !saving

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      if (editing) await apiClient.updateSkill(editing.name, { description: description.trim(), body })
      else await apiClient.createSkill({ name, description: description.trim(), body })
      toast.success(editing ? "Skill actualizada" : "Skill creada")
      emitSkillsChanged()
      onSaved(name)
    } catch (err) {
      setError(errorMessage(err, "No se pudo guardar la skill."))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-2xl" data-testid="skill-editor-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? `Editar ${editing.name}` : "Escribir instrucciones"}</DialogTitle>
          <DialogDescription>
            Una skill es un procedimiento que SiraGPT sigue cuando la activas con «+ → Skills» o con «/», o cuando la tarea lo pide.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="skill-name">Nombre</Label>
            <Input
              id="skill-name"
              value={name}
              disabled={Boolean(editing)}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-").slice(0, 64))}
              placeholder="informe-semanal"
              autoComplete="off"
              aria-invalid={Boolean(name) && !nameOk}
            />
            <p className={cn("text-xs", name && !nameOk ? "text-destructive" : "text-muted-foreground")}>
              Minúsculas, números, «-» o «_». Es lo que escribes después de «/».
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="skill-description">Descripción</Label>
            <Input
              id="skill-description"
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION))}
              placeholder="Qué hace y cuándo usarla"
            />
            <p className="text-right text-xs tabular-nums text-muted-foreground">{description.length}/{MAX_DESCRIPTION}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="skill-body">Instrucciones</Label>
            <Textarea
              id="skill-body"
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, MAX_BODY))}
              rows={12}
              className="min-h-[220px] font-mono text-[13px] leading-relaxed"
              placeholder={"# Informe semanal\n\n## Cuándo usar\n…\n\n## Procedimiento\n1. …\n\n## Formato de salida\n…"}
            />
            <p className="text-right text-xs tabular-nums text-muted-foreground">{body.length.toLocaleString("es")}/{MAX_BODY.toLocaleString("es")}</p>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} disabled={!canSave} data-testid="skill-editor-save">
            {saving ? "Guardando…" : editing ? "Guardar cambios" : "Crear skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────
// Detail
// ─────────────────────────────────────────────────────────────

function SkillDetailDialog({
  name,
  onClose,
  onTry,
  onEdit,
}: {
  name: string | null
  onClose: () => void
  onTry: (skill: ChatSkillSummary) => void
  onEdit: (skill: SkillDetail) => void
}) {
  const [skill, setSkill] = React.useState<SkillDetail | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!name) return
    let cancelled = false
    setSkill(null)
    setError(null)
    apiClient.getSkill(name)
      .then((res) => { if (!cancelled) setSkill(res.skill) })
      .catch((err) => { if (!cancelled) setError(errorMessage(err, "No se pudo abrir la skill.")) })
    return () => { cancelled = true }
  }, [name])

  return (
    <Dialog open={Boolean(name)} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-2xl" data-testid="skill-detail-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText aria-hidden="true" className="h-4 w-4" />
            {name}
          </DialogTitle>
          <DialogDescription>{skill?.description || (error ? "" : "Cargando…")}</DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {skill ? (
          <pre className="max-h-[46vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/40 p-4 font-mono text-[12.5px] leading-relaxed text-foreground/90">
            {skill.body}
          </pre>
        ) : null}
        <DialogFooter className="gap-2 sm:gap-0">
          {skill ? (
            <Button variant="ghost" onClick={() => downloadMarkdown(skill)}>
              <Download className="mr-2 h-4 w-4" aria-hidden="true" />Descargar
            </Button>
          ) : null}
          {skill && skill.source === "biblioteca" ? (
            <Button variant="outline" onClick={() => onEdit(skill)}>
              <PenLine className="mr-2 h-4 w-4" aria-hidden="true" />Editar
            </Button>
          ) : null}
          {skill ? (
            <Button onClick={() => onTry(skill)}>
              <MessageSquare className="mr-2 h-4 w-4" aria-hidden="true" />Probar en un chat
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────
// «Tuyos»
// ─────────────────────────────────────────────────────────────

function SkillRow({
  skill,
  onOpen,
  onTry,
  onEdit,
  onToggle,
  onRemove,
}: {
  skill: SkillLibraryItem
  onOpen: () => void
  onTry: () => void
  onEdit: () => void
  onToggle: () => void
  onRemove: () => void
}) {
  const date = formatSkillDate(skill.updatedAt)
  return (
    <div
      className={cn(
        "group flex items-center gap-3 border-b border-border/60 py-3 last:border-b-0",
        !skill.enabled && "opacity-60",
      )}
      data-testid={`skill-row-${skill.name}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-border/70 bg-background">
          <ScrollText aria-hidden="true" className="h-[18px] w-[18px] text-foreground/80" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[15px] font-medium text-foreground">{skill.name}</span>
            {!skill.enabled ? (
              <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10.5px] font-medium text-muted-foreground">Desactivada</span>
            ) : null}
          </span>
          <span className="block truncate text-[13px] text-muted-foreground">
            {skill.source === "biblioteca" ? "por ti" : `de ${skill.author}`} · {skill.description}
          </span>
        </span>
      </button>
      {date ? <span className="hidden shrink-0 text-[13px] tabular-nums text-muted-foreground sm:block">{date}</span> : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground"
            aria-label={`Acciones de ${skill.name}`}
            data-testid={`skill-row-menu-${skill.name}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={onTry}>
            <MessageSquare className="mr-2 h-4 w-4" aria-hidden="true" />Probar en un chat
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpen}>
            <Eye className="mr-2 h-4 w-4" aria-hidden="true" />Ver instrucciones
          </DropdownMenuItem>
          {skill.editable ? (
            <DropdownMenuItem onSelect={onEdit}>
              <PenLine className="mr-2 h-4 w-4" aria-hidden="true" />Editar
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={onToggle} data-testid={`skill-toggle-${skill.name}`}>
            <Power className="mr-2 h-4 w-4" aria-hidden="true" />{skill.enabled ? "Desactivar" : "Activar"}
          </DropdownMenuItem>
          {skill.removable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onRemove} className="text-destructive focus:text-destructive">
                <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />{skill.source === "biblioteca" ? "Eliminar" : "Quitar de Tuyos"}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function SectionHeading({ title, count }: { title: string; count: number }) {
  return (
    <div className="mb-1 mt-2 flex items-center gap-2">
      <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
      <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground">{count}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// «Descubrir»
// ─────────────────────────────────────────────────────────────

function CatalogCard({
  skill,
  onTry,
  onInstall,
  onOpen,
  busy,
}: {
  skill: SkillCatalogItem
  onTry: () => void
  onInstall: () => void
  onOpen: () => void
  busy: boolean
}) {
  return (
    <div className="flex gap-3 rounded-xl border border-border/70 bg-background p-4 transition-colors hover:border-foreground/20" data-testid={`skill-card-${skill.name}`}>
      <button type="button" onClick={onOpen} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-border/70 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Ver ${skill.title}`}>
        <CategoryIcon category={skill.category} className="h-[18px] w-[18px] text-foreground/80" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
            <span className="block truncate text-[15px] font-medium text-foreground">{skill.title}</span>
          </button>
          <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5 px-2.5" onClick={onTry}>
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />Probar
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={onInstall}
            disabled={skill.installed || busy}
            aria-label={skill.installed ? `${skill.title} ya está en Tuyos` : `Añadir ${skill.title}`}
            data-testid={`skill-install-${skill.name}`}
          >
            {skill.installed ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          </Button>
        </div>
        <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted-foreground">{skill.description}</p>
        <p className="mt-1 text-xs text-muted-foreground/80">{skill.author} · {skill.category}</p>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Section
// ─────────────────────────────────────────────────────────────

export function SkillsSettings() {
  const [tab, setTab] = React.useState<SkillsSettingsTab>(() => consumeSkillsTab() || "mine")
  const [query, setQuery] = React.useState("")
  const [sortByName, setSortByName] = React.useState(false)
  const [library, setLibrary] = React.useState<{ mine: SkillLibraryItem[]; partners: SkillLibraryItem[] } | null>(null)
  const [libraryError, setLibraryError] = React.useState<string | null>(null)
  const [discover, setDiscover] = React.useState<SkillsDiscoverResponse | null>(null)
  const [discoverError, setDiscoverError] = React.useState<string | null>(null)
  const [category, setCategory] = React.useState<string | null>(null)
  const [showAllCategories, setShowAllCategories] = React.useState(false)
  const [editor, setEditor] = React.useState<EditorState | null>(null)
  const [detailName, setDetailName] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const uploadRef = React.useRef<HTMLInputElement>(null)

  const loadLibrary = React.useCallback(async () => {
    setLibraryError(null)
    try {
      const res = await apiClient.getSkillLibrary()
      setLibrary({ mine: res.mine || [], partners: res.partners || [] })
    } catch (err) {
      setLibraryError(errorMessage(err, "No se pudieron cargar tus skills."))
    }
  }, [])

  const loadDiscover = React.useCallback(async () => {
    setDiscoverError(null)
    try {
      setDiscover(await apiClient.discoverSkills())
    } catch (err) {
      setDiscoverError(errorMessage(err, "No se pudo cargar el catálogo."))
    }
  }, [])

  React.useEffect(() => { void loadLibrary() }, [loadLibrary])
  React.useEffect(() => { if (tab === "discover" && !discover) void loadDiscover() }, [tab, discover, loadDiscover])

  const refreshAll = React.useCallback(async () => {
    emitSkillsChanged()
    await Promise.all([loadLibrary(), discover ? loadDiscover() : Promise.resolve()])
  }, [discover, loadDiscover, loadLibrary])

  const tryInChat = React.useCallback((skill: ChatSkillSummary) => {
    startChatWithSkill({ name: skill.name, title: skill.title, description: skill.description, source: skill.source, category: skill.category })
  }, [])

  const install = async (skill: SkillCatalogItem) => {
    setBusy(skill.name)
    try {
      await apiClient.installSkill(skill.name)
      toast.success(`«${skill.title}» se añadió a Tuyos`)
      await refreshAll()
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo añadir la skill."))
    } finally {
      setBusy(null)
    }
  }

  const toggle = async (skill: SkillLibraryItem) => {
    try {
      await apiClient.setSkillEnabled(skill.name, !skill.enabled)
      toast.success(skill.enabled ? `«${skill.name}» desactivada` : `«${skill.name}» activada`)
      await refreshAll()
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo actualizar la skill."))
    }
  }

  const remove = async (skill: SkillLibraryItem) => {
    const own = skill.source === "biblioteca"
    if (own && typeof window !== "undefined" && !window.confirm(`¿Eliminar la skill «${skill.name}»? No se puede deshacer.`)) return
    try {
      await apiClient.removeSkill(skill.name)
      toast.success(own ? `«${skill.name}» eliminada` : `«${skill.name}» se quitó de Tuyos`)
      await refreshAll()
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo eliminar la skill."))
    }
  }

  const edit = async (name: string) => {
    try {
      const res = await apiClient.getSkill(name)
      setDetailName(null)
      setEditor({ mode: "edit", skill: res.skill })
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo abrir la skill."))
    }
  }

  const onUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    try {
      const content = await readSkillUpload(file)
      const res = await apiClient.createSkill({ content, filename: file.name })
      toast.success(`Skill «${res.skill?.name || file.name}» añadida`)
      setTab("mine")
      await refreshAll()
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo subir la skill."))
    }
  }

  const q = query.trim().toLowerCase()
  const matches = (s: { name: string; title?: string; description?: string }) =>
    !q || `${s.name} ${s.title || ""} ${s.description || ""}`.toLowerCase().includes(q)
  const sortRows = (rows: SkillLibraryItem[]) => [...rows].sort((a, b) => (sortByName
    ? a.name.localeCompare(b.name, "es")
    : String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || a.name.localeCompare(b.name, "es")))
  const mine = sortRows((library?.mine || []).filter(matches))
  const partners = sortRows((library?.partners || []).filter(matches))

  const catalogItems = discover?.items || []
  const filteredCatalog = catalogItems.filter((s) => (!category || s.category === category) && matches(s))
  const categories = discover?.categories || []
  const visibleCategories = showAllCategories ? categories : categories.slice(0, 8)

  const rowProps = (skill: SkillLibraryItem) => ({
    skill,
    onOpen: () => setDetailName(skill.name),
    onTry: () => tryInChat(skill),
    onEdit: () => { void edit(skill.name) },
    onToggle: () => { void toggle(skill) },
    onRemove: () => { void remove(skill) },
  })

  const cardProps = (skill: SkillCatalogItem) => ({
    skill,
    busy: busy === skill.name,
    onTry: () => tryInChat({ ...skill, source: "catalog" as const }),
    onInstall: () => { void install(skill) },
    onOpen: () => setDetailName(skill.name),
  })

  return (
    <div className="space-y-5" data-testid="skills-settings">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">Skills</h2>
        <div role="tablist" aria-label="Vista de skills" className="inline-flex rounded-lg border border-border/70 bg-muted/50 p-0.5">
          {([["mine", "Tuyos"], ["discover", "Descubrir"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              data-testid={`skills-tab-${key}`}
              onClick={() => { setTab(key); setCategory(null) }}
              className={cn(
                "rounded-md px-3 py-1 text-sm transition-colors",
                tab === key ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
          <label className="relative min-w-0 flex-1 sm:w-60 sm:flex-none">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar habilidades"
              aria-label="Buscar habilidades"
              className="h-9 pl-9"
            />
          </label>
          {tab === "mine" ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              aria-label={sortByName ? "Ordenar por fecha" : "Ordenar por nombre"}
              title={sortByName ? "Ordenar por fecha" : "Ordenar por nombre"}
              onClick={() => setSortByName((v) => !v)}
            >
              <ArrowUpDown className="h-4 w-4" />
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="h-9 shrink-0 gap-1.5" data-testid="skills-add">
                <Plus className="h-4 w-4" aria-hidden="true" />Añadir
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={() => tryInChat(SKILL_CREATOR)} data-testid="skills-add-create-chat">
                <WandSparkles className="mr-2 h-4 w-4" aria-hidden="true" />
                <span className="flex flex-col">
                  <span>Crear con SiraGPT</span>
                  <span className="text-xs text-muted-foreground">Descríbela en un chat y la guarda por ti</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditor({ mode: "create" })} data-testid="skills-add-write">
                <PenLine className="mr-2 h-4 w-4" aria-hidden="true" />
                <span className="flex flex-col">
                  <span>Escribir instrucciones</span>
                  <span className="text-xs text-muted-foreground">Nombre, descripción e instrucciones</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => uploadRef.current?.click()} data-testid="skills-add-upload">
                <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
                <span className="flex flex-col">
                  <span>Subir una skill</span>
                  <span className="text-xs text-muted-foreground">SKILL.md, .zip o .skill</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input ref={uploadRef} type="file" accept=".md,.markdown,.zip,.skill,text/markdown" className="hidden" onChange={onUpload} data-testid="skills-upload-input" />
        </div>
      </div>

      {tab === "mine" ? (
        <div className="space-y-6" role="tabpanel" aria-label="Tuyos">
          {libraryError ? (
            <div className="flex items-center justify-between rounded-lg border border-destructive/30 px-4 py-3 text-sm text-destructive" role="alert">
              {libraryError}
              <Button variant="outline" size="sm" onClick={() => { void loadLibrary() }}>Reintentar</Button>
            </div>
          ) : null}
          {!library && !libraryError ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/60" />)}
            </div>
          ) : null}
          {library ? (
            <>
              <section>
                <SectionHeading title="Creado por ti" count={mine.length} />
                {mine.length ? mine.map((s) => <SkillRow key={s.name} {...rowProps(s)} />) : (
                  <p className="py-4 text-sm text-muted-foreground">
                    {q ? "Ninguna skill tuya coincide con la búsqueda." : "Aún no creaste skills. Usa «Añadir» para crear una con SiraGPT, escribirla o subirla."}
                  </p>
                )}
              </section>
              <section>
                <SectionHeading title="De SiraGPT" count={partners.length} />
                {partners.length ? partners.map((s) => <SkillRow key={s.name} {...rowProps(s)} />) : (
                  <p className="py-4 text-sm text-muted-foreground">Ninguna skill coincide con la búsqueda.</p>
                )}
              </section>
            </>
          ) : null}
        </div>
      ) : (
        <div className="space-y-7" role="tabpanel" aria-label="Descubrir">
          {discoverError ? (
            <div className="flex items-center justify-between rounded-lg border border-destructive/30 px-4 py-3 text-sm text-destructive" role="alert">
              {discoverError}
              <Button variant="outline" size="sm" onClick={() => { void loadDiscover() }}>Reintentar</Button>
            </div>
          ) : null}
          {!discover && !discoverError ? (
            <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
              {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl bg-muted/60" />)}
            </div>
          ) : null}
          {discover && (q || category) ? (
            <section>
              <div className="mb-3 flex items-center gap-2">
                {category ? (
                  <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2" onClick={() => setCategory(null)}>
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />Volver
                  </Button>
                ) : null}
                <h3 className="text-[15px] font-semibold">{category || "Resultados"}</h3>
                <span className="text-sm tabular-nums text-muted-foreground">{filteredCatalog.length}</span>
              </div>
              {filteredCatalog.length ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {filteredCatalog.map((s) => <CatalogCard key={s.name} {...cardProps(s)} />)}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Ninguna skill del catálogo coincide con «{query.trim()}».</p>
              )}
            </section>
          ) : null}
          {discover && !q && !category ? (
            <>
              {discover.featured ? (
                <section className="flex items-center gap-6 rounded-2xl border border-border/70 bg-muted/50 p-6" data-testid="skills-featured">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-muted-foreground">De SiraGPT</p>
                    <h3 className="mt-1 font-serif text-2xl font-semibold tracking-tight text-foreground">{discover.featured.title}</h3>
                    <p className="mt-2 max-w-xl text-sm leading-relaxed text-foreground/80">{discover.featured.description}</p>
                    <div className="mt-4 flex gap-2">
                      <Button
                        onClick={() => { void install(discover.featured!) }}
                        disabled={discover.featured.installed || busy === discover.featured.name}
                      >
                        {discover.featured.installed ? "Añadida" : "Añadir"}
                      </Button>
                      <Button variant="outline" onClick={() => tryInChat({ ...discover.featured!, source: "catalog" })}>Probar</Button>
                    </div>
                  </div>
                  <CategoryIcon category={discover.featured.category} className="hidden h-20 w-20 shrink-0 text-foreground/70 sm:block" />
                </section>
              ) : null}

              <section>
                <div className="mb-3">
                  <h3 className="text-[15px] font-semibold">Para ti</h3>
                  {discover.memoryUsed ? (
                    <p className="text-xs text-muted-foreground">Según lo que SiraGPT recuerda de ti (Ajustes → Memoria).</p>
                  ) : null}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {discover.forYou.map((s) => <CatalogCard key={s.name} {...cardProps(s)} />)}
                </div>
              </section>

              <section>
                <h3 className="mb-3 text-[15px] font-semibold">Nuevas habilidades</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {discover.latest.map((s) => <CatalogCard key={s.name} {...cardProps(s)} />)}
                </div>
              </section>

              <section>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-[15px] font-semibold">Categorías</h3>
                  {categories.length > 8 ? (
                    <Button variant="ghost" size="sm" onClick={() => setShowAllCategories((v) => !v)}>
                      {showAllCategories ? "Mostrar menos" : `Mostrar todas (${categories.length})`}
                    </Button>
                  ) : null}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {visibleCategories.map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => setCategory(c.name)}
                      className="flex items-center gap-4 rounded-xl border border-border/70 bg-background p-4 text-left outline-none transition-colors hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid={`skills-category-${c.name}`}
                    >
                      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-border/70 bg-muted/40">
                        <CategoryIcon category={c.name} className="h-5 w-5 text-foreground/80" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-foreground">{c.name}</span>
                      <span className="text-sm tabular-nums text-muted-foreground">{c.count}</span>
                    </button>
                  ))}
                </div>
              </section>
            </>
          ) : null}
        </div>
      )}

      <SkillEditorDialog
        state={editor}
        onClose={() => setEditor(null)}
        onSaved={() => { setEditor(null); setTab("mine"); void refreshAll() }}
      />
      <SkillDetailDialog
        name={detailName}
        onClose={() => setDetailName(null)}
        onTry={(skill) => { setDetailName(null); tryInChat(skill) }}
        onEdit={(skill) => { setDetailName(null); setEditor({ mode: "edit", skill }) }}
      />
    </div>
  )
}

export default SkillsSettings
