"use client"

import * as React from "react"
import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Bot,
  BookOpen,
  Brain,
  Briefcase,
  CheckCircle2,
  Code,
  Copy,
  Database,
  Edit,
  FileText,
  Gamepad2,
  Globe,
  Heart,
  Layers3,
  Loader2,
  Lock,
  MessageSquare,
  Palette,
  Plus,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  TrendingUp,
  Users,
  Wand2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAuth } from "@/lib/auth-context-integrated"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { gptsService, type CustomGPT, type GPTFilters } from "@/lib/gpts-service"
import { useChat } from "@/lib/chat-context-integrated"

type CategoryOption = {
  value: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

type VisibilityFilter = "all" | "mine" | "public"

const categories: CategoryOption[] = [
  { value: "All", label: "Todo", icon: Sparkles },
  { value: "Trending", label: "Tendencia", icon: TrendingUp },
  { value: "Writing", label: "Escritura", icon: BookOpen },
  { value: "Productivity", label: "Productividad", icon: Briefcase },
  { value: "Programming", label: "Programación", icon: Code },
  { value: "Design", label: "Diseño", icon: Palette },
  { value: "Research & Analysis", label: "Investigación", icon: Search },
  { value: "Education", label: "Educación", icon: BookOpen },
  { value: "Data Analysis", label: "Datos", icon: Database },
  { value: "Lifestyle", label: "Lifestyle", icon: Heart },
  { value: "Entertainment", label: "Entretenimiento", icon: Gamepad2 },
  { value: "Marketing", label: "Marketing", icon: TrendingUp },
  { value: "Finance", label: "Finanzas", icon: Users },
  { value: "Health & Fitness", label: "Salud", icon: Heart },
  { value: "Travel", label: "Viajes", icon: Globe },
  { value: "Other", label: "Otros", icon: Star },
]

const visibilityOptions: Array<{ value: VisibilityFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "mine", label: "Mis GPTs" },
  { value: "public", label: "Públicos" },
]

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const handler = window.setTimeout(() => setDebouncedValue(value), delay)
    return () => window.clearTimeout(handler)
  }, [value, delay])

  return debouncedValue
}

function resolveIconSrc(iconUrl?: string) {
  if (!iconUrl) return null
  if (/^(https?:|data:|blob:)/i.test(iconUrl)) return iconUrl
  if (iconUrl.startsWith("/uploads") || iconUrl.startsWith("/upload")) {
    const imageHost = process.env.NEXT_PUBLIC_IMAGE_URL || "http://localhost:5000"
    return `${imageHost}${iconUrl}`
  }
  if (iconUrl.startsWith("/")) return iconUrl
  return null
}

function getKnowledgeCount(gpt: CustomGPT) {
  return gpt._count?.files || (gpt as CustomGPT & { knowledgeFiles?: unknown[] }).knowledgeFiles?.length || 0
}

function getInstructionQuality(gpt: CustomGPT) {
  let score = 20
  const instructionsLength = gpt.instructions?.trim().length || 0
  const starters = Array.isArray(gpt.conversationStarters) ? gpt.conversationStarters.length : 0
  const knowledgeFiles = getKnowledgeCount(gpt)

  if (instructionsLength >= 800) score += 30
  else if (instructionsLength >= 300) score += 18
  else if (instructionsLength >= 120) score += 10

  if (gpt.description?.trim()) score += 12
  if (starters >= 3) score += 12
  else if (starters > 0) score += 6
  if (knowledgeFiles > 0) score += 16
  if (gpt.visibility === "PUBLIC") score += 5
  if (gpt.isFeatured) score += 5

  const clamped = Math.min(100, score)
  if (clamped >= 82) return { score: clamped, label: "Excelente", color: "bg-emerald-500" }
  if (clamped >= 62) return { score: clamped, label: "Sólido", color: "bg-blue-500" }
  if (clamped >= 42) return { score: clamped, label: "Mejorable", color: "bg-amber-500" }
  return { score: clamped, label: "Básico", color: "bg-rose-500" }
}

function getVisibilityMeta(visibility: CustomGPT["visibility"]) {
  if (visibility === "PUBLIC") {
    return { label: "Público", icon: Globe, className: "border-emerald-200 bg-emerald-50 text-emerald-700" }
  }
  if (visibility === "UNLISTED") {
    return { label: "Enlace", icon: Share2, className: "border-blue-200 bg-blue-50 text-blue-700" }
  }
  return { label: "Privado", icon: Lock, className: "border-zinc-200 bg-zinc-50 text-zinc-600" }
}

function formatCount(value?: number) {
  const n = Number(value || 0)
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return n.toString()
}

function GPTAvatar({ gpt, large = false }: { gpt: CustomGPT; large?: boolean }) {
  const iconSrc = resolveIconSrc(gpt.iconUrl)
  const sizeClass = large ? "h-14 w-14 text-2xl" : "h-12 w-12 text-xl"

  if (iconSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={iconSrc}
        alt={`${gpt.name} icon`}
        className={cn(sizeClass, "rounded-2xl object-cover ring-1 ring-black/5")}
      />
    )
  }

  return (
    <div className={cn(
      sizeClass,
      "grid shrink-0 place-items-center rounded-2xl bg-[radial-gradient(circle_at_30%_20%,#ffffff_0,#dbeafe_28%,#2563eb_100%)] font-semibold text-white shadow-sm"
    )}>
      {gpt.iconUrl || gpt.name?.[0]?.toUpperCase() || <Bot className="h-5 w-5" />}
    </div>
  )
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string | number
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="rounded-3xl border border-black/5 bg-white/80 p-4 shadow-sm backdrop-blur-xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">{label}</p>
          <p className="mt-2 text-2xl font-semibold text-zinc-950">{value}</p>
        </div>
        <div className="grid h-10 w-10 place-items-center rounded-2xl bg-zinc-950 text-white">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  )
}

function CapabilityCard({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
}) {
  return (
    <div className="rounded-3xl border border-zinc-200/80 bg-white p-5 shadow-[0_18px_55px_rgba(15,23,42,0.06)]">
      <div className="grid h-11 w-11 place-items-center rounded-2xl bg-zinc-100 text-zinc-900">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mt-4 text-sm font-semibold text-zinc-950">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-zinc-600">{description}</p>
    </div>
  )
}

function CategoryNav({
  selectedCategory,
  onSelectCategory,
  pending,
}: {
  selectedCategory: string
  onSelectCategory: (category: string) => void
  pending?: boolean
}) {
  return (
    <nav className="flex flex-wrap gap-2">
      {categories.map((category) => {
        const Icon = category.icon
        const active = selectedCategory === category.value
        return (
          <button
            key={category.value}
            type="button"
            onClick={() => onSelectCategory(category.value)}
            className={cn(
              "inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-all",
              active
                ? "border-zinc-950 bg-zinc-950 text-white shadow-sm"
                : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50",
              pending && "opacity-80"
            )}
          >
            <Icon className="h-4 w-4" />
            {category.label}
          </button>
        )
      })}
    </nav>
  )
}

function GPTCard({
  gpt,
  onStartChat,
  onEdit,
  onDelete,
  onShare,
  isOwner = false,
}: {
  gpt: CustomGPT
  onStartChat: (gpt: CustomGPT) => Promise<void>
  onEdit?: (gpt: CustomGPT) => void
  onDelete?: (gpt: CustomGPT) => void
  onShare?: (gpt: CustomGPT) => void
  isOwner?: boolean
}) {
  const [isLoadingChat, setIsLoadingChat] = useState(false)
  const quality = getInstructionQuality(gpt)
  const visibility = getVisibilityMeta(gpt.visibility)
  const VisibilityIcon = visibility.icon
  const knowledgeCount = getKnowledgeCount(gpt)

  const handleStartChat = async () => {
    setIsLoadingChat(true)
    try {
      await onStartChat(gpt)
    } catch (error) {
      console.error("Error starting GPT chat:", error)
    } finally {
      setIsLoadingChat(false)
    }
  }

  return (
    <article className="group relative overflow-hidden rounded-[2rem] border border-zinc-200 bg-white p-5 shadow-[0_18px_60px_rgba(15,23,42,0.07)] transition-all duration-300 hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-[0_28px_80px_rgba(15,23,42,0.12)]">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-zinc-950 via-blue-500 to-emerald-400 opacity-0 transition-opacity group-hover:opacity-100" />

      <div className="flex items-start gap-4">
        <GPTAvatar gpt={gpt} large />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-lg font-semibold tracking-[-0.02em] text-zinc-950">{gpt.name}</h3>
            {gpt.isFeatured && (
              <Badge className="rounded-full bg-amber-100 text-amber-700 hover:bg-amber-100">
                Destacado
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-zinc-600">
            {gpt.description || "Asistente personalizado con instrucciones persistentes y memoria contextual."}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <span className={cn("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium", visibility.className)}>
          <VisibilityIcon className="h-3.5 w-3.5" />
          {visibility.label}
        </span>
        {gpt.category && (
          <span className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600">
            <Layers3 className="h-3.5 w-3.5" />
            {gpt.category}
          </span>
        )}
        <span className="inline-flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
          <Database className="h-3.5 w-3.5" />
          {knowledgeCount} archivo{knowledgeCount === 1 ? "" : "s"} RAG
        </span>
        {knowledgeCount > 0 && (
          <span
            title="Self-RAG: reflexión ISREL/ISSUP/ISUSE por segmento antes de responder"
            className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700"
          >
            <Brain className="h-3.5 w-3.5" />
            Self-RAG
          </span>
        )}
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3">
        <div className="rounded-2xl bg-zinc-50 p-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-400">Chats</p>
          <p className="mt-1 text-lg font-semibold text-zinc-950">{formatCount(gpt._count?.conversations)}</p>
        </div>
        <div className="rounded-2xl bg-zinc-50 p-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-400">Modelo</p>
          <p className="mt-1 truncate text-sm font-semibold text-zinc-950">{gpt.modelName || "default"}</p>
        </div>
        <div className="rounded-2xl bg-zinc-50 p-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-400">Temp.</p>
          <p className="mt-1 text-lg font-semibold text-zinc-950">{Number(gpt.temperature ?? 0.7).toFixed(1)}</p>
        </div>
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between text-xs font-medium text-zinc-500">
          <span>Seguimiento de instrucciones</span>
          <span>{quality.label} · {quality.score}%</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100">
          <div className={cn("h-full rounded-full transition-all", quality.color)} style={{ width: `${quality.score}%` }} />
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          Por <span className="font-medium text-zinc-700">{gpt.creator?.name || "Equipo"}</span>
        </p>
        <div className="flex items-center gap-2">
          {onShare && gpt.visibility !== "PRIVATE" && (
            <Button variant="outline" size="icon" onClick={() => onShare(gpt)} className="h-9 w-9 rounded-full">
              <Share2 className="h-4 w-4" />
              <span className="sr-only">Compartir</span>
            </Button>
          )}
          {isOwner && onEdit && (
            <Button variant="outline" size="icon" onClick={() => onEdit(gpt)} className="h-9 w-9 rounded-full">
              <Edit className="h-4 w-4" />
              <span className="sr-only">Editar</span>
            </Button>
          )}
          {isOwner && onDelete && (
            <Button variant="outline" size="icon" onClick={() => onDelete(gpt)} className="h-9 w-9 rounded-full text-rose-600 hover:text-rose-700">
              <Trash2 className="h-4 w-4" />
              <span className="sr-only">Eliminar</span>
            </Button>
          )}
          <Button onClick={handleStartChat} disabled={isLoadingChat} className="h-9 rounded-full bg-zinc-950 px-4 text-white hover:bg-zinc-800">
            {isLoadingChat ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
            <span className="ml-2">Usar GPT</span>
          </Button>
        </div>
      </div>
    </article>
  )
}

export default function GPTsPage() {
  const { user } = useAuth()
  const { selectChat } = useChat()
  const router = useRouter()
  const [isPending, startTransition] = React.useTransition()

  const [gpts, setGpts] = useState<CustomGPT[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedCategory, setSelectedCategory] = useState("All")
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("all")
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [selectedGPT, setSelectedGPT] = useState<CustomGPT | null>(null)

  const debouncedSearchQuery = useDebounce(searchQuery, 350)

  const fetchGPTs = useCallback(async () => {
    setLoading(true)
    try {
      const filters: GPTFilters = {
        search: debouncedSearchQuery || undefined,
        category: selectedCategory !== "All" && selectedCategory !== "Trending" ? selectedCategory : undefined,
        visibility: visibilityFilter,
      }

      let fetchedGPTs = await gptsService.getGPTs(filters)
      if (selectedCategory === "Trending") {
        fetchedGPTs = [...fetchedGPTs]
          .sort((a, b) => (b._count?.conversations || 0) - (a._count?.conversations || 0))
          .slice(0, 12)
      }

      setGpts(fetchedGPTs)
    } catch (error) {
      console.error("Error fetching GPTs:", error)
      toast.error("No se pudieron cargar los GPTs")
    } finally {
      setLoading(false)
    }
  }, [debouncedSearchQuery, selectedCategory, visibilityFilter])

  useEffect(() => {
    fetchGPTs()
  }, [fetchGPTs])

  const handleStartChat = async (gpt: CustomGPT) => {
    try {
      const chat = await gptsService.startChatWithGPT(gpt.id)
      localStorage.setItem("currentChatId", chat.id)
      selectChat(chat.id)
      router.push(`/chat?id=${chat.id}`)
      toast.success(`Chat iniciado con ${gpt.name}`)
    } catch (error: any) {
      toast.error(error?.message || "No se pudo iniciar el chat")
      throw error
    }
  }

  const handleEdit = (gpt: CustomGPT) => {
    router.push(`/gpts/create?edit=${gpt.id}`)
  }

  const handleDelete = async (gpt: CustomGPT) => {
    const confirmed = window.confirm(`Eliminar "${gpt.name}"? Esta acción no se puede deshacer.`)
    if (!confirmed) return

    try {
      await gptsService.deleteGPT(gpt.id)
      setGpts(current => current.filter(item => item.id !== gpt.id))
      toast.success("GPT eliminado")
    } catch (error: any) {
      toast.error(error?.message || "No se pudo eliminar el GPT")
    }
  }

  const handleShare = (gpt: CustomGPT) => {
    setSelectedGPT(gpt)
    setShareDialogOpen(true)
  }

  const copyShareLink = async () => {
    if (!selectedGPT) return
    await navigator.clipboard.writeText(gptsService.getShareUrl(selectedGPT.shareId))
    toast.success("Enlace copiado")
  }

  const handleCreateNew = () => {
    router.push("/gpts/create")
  }

  const handleCategoryChange = (category: string) => {
    startTransition(() => setSelectedCategory(category))
  }

  const handleVisibilityChange = (visibility: VisibilityFilter) => {
    startTransition(() => setVisibilityFilter(visibility))
  }

  const allDisplayGPTs = [...gpts].sort((a, b) => {
    if (a.isFeatured && !b.isFeatured) return -1
    if (!a.isFeatured && b.isFeatured) return 1
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })

  const userOwnedGPTs = allDisplayGPTs.filter(gpt => gpt.creator?.id === user?.id)
  const publicGPTs = allDisplayGPTs.filter(gpt => gpt.visibility === "PUBLIC")
  const ragGPTs = allDisplayGPTs.filter(gpt => getKnowledgeCount(gpt) > 0)
  const activeCategory = categories.find(category => category.value === selectedCategory)?.label || selectedCategory

  return (
    <main data-testid="gpts-store-page" className="min-h-full bg-[#f7f7f4] text-zinc-950">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
        <section className="relative overflow-hidden rounded-[2.25rem] border border-zinc-200 bg-white shadow-[0_30px_90px_rgba(15,23,42,0.08)]">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(37,99,235,0.12),transparent_28%),radial-gradient(circle_at_80%_10%,rgba(16,185,129,0.12),transparent_25%),linear-gradient(135deg,rgba(255,255,255,0.96),rgba(250,250,247,0.94))]" />
          <div className="relative grid gap-8 p-6 sm:p-8 lg:grid-cols-[1.35fr_0.65fr] lg:p-10">
            <div>
              <div className="flex items-center gap-3">
                <SidebarTrigger className="md:hidden" />
                <Badge className="rounded-full bg-zinc-950 px-3 py-1 text-white hover:bg-zinc-950">
                  <Bot className="mr-1.5 h-3.5 w-3.5" />
                  GPTs Store
                </Badge>
              </div>
              <h1 className="mt-6 max-w-3xl text-4xl font-semibold tracking-[-0.055em] text-zinc-950 sm:text-5xl lg:text-6xl">
                Asistentes personalizados con RAG, instrucciones y flujo profesional.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-8 text-zinc-600 sm:text-lg">
                Crea, encuentra y ejecuta GPTs con conocimiento persistente, instrucciones reforzadas y controles de calidad para chats especializados.
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                <Button onClick={handleCreateNew} className="h-12 rounded-full bg-zinc-950 px-6 text-white hover:bg-zinc-800">
                  <Plus className="mr-2 h-4 w-4" />
                  Crear GPT profesional
                </Button>
                <Button variant="outline" onClick={() => handleVisibilityChange("mine")} className="h-12 rounded-full border-zinc-300 bg-white/80 px-6">
                  <Wand2 className="mr-2 h-4 w-4" />
                  Ver mis GPTs
                </Button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <StatCard label="Disponibles" value={allDisplayGPTs.length} icon={Bot} />
              <StatCard label="Con RAG" value={ragGPTs.length} icon={Database} />
              <StatCard label="Mis GPTs" value={userOwnedGPTs.length} icon={ShieldCheck} />
              <StatCard label="Públicos" value={publicGPTs.length} icon={Globe} />
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <CapabilityCard
            icon={Brain}
            title="RAG por GPT"
            description="Los archivos del GPT se recuperan como evidencia privada y no se mezclan como texto crudo en el prompt."
          />
          <CapabilityCard
            icon={CheckCircle2}
            title="Instrucciones resistentes"
            description="El contrato interno separa persona, reglas del usuario y conocimiento para evitar fuga o sobreescritura."
          />
          <CapabilityCard
            icon={FileText}
            title="Trazabilidad lista para QA"
            description="Cada GPT muestra señales de calidad: instrucciones, starters, conocimiento y uso real en conversaciones."
          />
        </section>

        <section className="rounded-[2rem] border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-col gap-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-400" />
              <Input
                data-testid="gpts-search"
                placeholder="Buscar GPTs por nombre, propósito o especialidad..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="h-12 rounded-full border-zinc-200 bg-zinc-50 pl-12 text-base shadow-none focus-visible:ring-zinc-300"
              />
            </div>
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <CategoryNav selectedCategory={selectedCategory} onSelectCategory={handleCategoryChange} pending={isPending} />
              <div className="flex shrink-0 rounded-full border border-zinc-200 bg-zinc-50 p-1">
                {visibilityOptions.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleVisibilityChange(option.value)}
                    className={cn(
                      "h-9 rounded-full px-4 text-sm font-medium transition",
                      visibilityFilter === option.value
                        ? "bg-white text-zinc-950 shadow-sm"
                        : "text-zinc-500 hover:text-zinc-800"
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {userOwnedGPTs.length > 0 && visibilityFilter !== "public" && (
          <section>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium uppercase tracking-[0.18em] text-zinc-500">Workspace</p>
                <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">Tus GPTs activos</h2>
              </div>
              <Button variant="outline" onClick={handleCreateNew} className="rounded-full">
                <Plus className="mr-2 h-4 w-4" />
                Nuevo
              </Button>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {userOwnedGPTs.slice(0, 4).map((gpt) => (
                <GPTCard
                  key={`owned-${gpt.id}`}
                  gpt={gpt}
                  onStartChat={handleStartChat}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onShare={handleShare}
                  isOwner
                />
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.18em] text-zinc-500">Catálogo</p>
              <h2 className="mt-1 text-3xl font-semibold tracking-[-0.045em]">
                {selectedCategory === "All" ? "Descubrir GPTs" : `${activeCategory}`}
              </h2>
            </div>
            <p className="text-sm text-zinc-500">
              {loading ? "Cargando..." : `${allDisplayGPTs.length} resultado${allDisplayGPTs.length === 1 ? "" : "s"}`}
            </p>
          </div>

          {loading ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="rounded-[2rem] border border-zinc-200 bg-white p-5">
                  <div className="animate-pulse">
                    <div className="flex gap-4">
                      <div className="h-14 w-14 rounded-2xl bg-zinc-100" />
                      <div className="flex-1">
                        <div className="h-5 w-2/5 rounded bg-zinc-100" />
                        <div className="mt-3 h-4 w-4/5 rounded bg-zinc-100" />
                      </div>
                    </div>
                    <div className="mt-6 grid grid-cols-3 gap-3">
                      <div className="h-16 rounded-2xl bg-zinc-100" />
                      <div className="h-16 rounded-2xl bg-zinc-100" />
                      <div className="h-16 rounded-2xl bg-zinc-100" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : allDisplayGPTs.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {allDisplayGPTs.map((gpt) => (
                <GPTCard
                  key={gpt.id}
                  gpt={gpt}
                  onStartChat={handleStartChat}
                  onEdit={gpt.creator?.id === user?.id ? handleEdit : undefined}
                  onDelete={gpt.creator?.id === user?.id ? handleDelete : undefined}
                  onShare={handleShare}
                  isOwner={gpt.creator?.id === user?.id}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-[2rem] border border-dashed border-zinc-300 bg-white px-6 py-16 text-center">
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-zinc-100 text-zinc-500">
                <Bot className="h-8 w-8" />
              </div>
              <h3 className="mt-6 text-2xl font-semibold tracking-[-0.035em]">
                {debouncedSearchQuery ? "No hay GPTs con esa búsqueda" : `No hay GPTs en "${activeCategory}"`}
              </h3>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-600">
                Crea un asistente con instrucciones claras, archivos de conocimiento y starters para que el chat responda con precisión desde el primer mensaje.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {["Tesis APA 7", "Investigación de mercado", "Diseño web", "Análisis Excel"].map(template => (
                  <button
                    key={template}
                    type="button"
                    onClick={handleCreateNew}
                    className="rounded-full border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-white"
                  >
                    {template}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <Dialog open={shareDialogOpen} onOpenChange={setShareDialogOpen}>
          <DialogContent className="rounded-3xl border-zinc-200 bg-white sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Compartir GPT</DialogTitle>
              <DialogDescription>
                Comparte "{selectedGPT?.name}" con otros usuarios cuando su visibilidad sea pública o por enlace.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <label htmlFor="share-link" className="text-sm font-medium text-zinc-800">Enlace</label>
              <div className="flex gap-2">
                <Input
                  id="share-link"
                  value={selectedGPT ? gptsService.getShareUrl(selectedGPT.shareId) : ""}
                  readOnly
                  className="h-11 rounded-2xl bg-zinc-50"
                />
                <Button onClick={copyShareLink} size="icon" className="h-11 w-11 rounded-2xl bg-zinc-950 text-white hover:bg-zinc-800">
                  <Copy className="h-4 w-4" />
                  <span className="sr-only">Copiar enlace</span>
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShareDialogOpen(false)} className="rounded-full">
                Cerrar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </main>
  )
}
