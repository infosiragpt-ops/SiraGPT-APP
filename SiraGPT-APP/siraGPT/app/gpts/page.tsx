"use client"

import * as React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Code,
  Copy,
  Edit,
  GraduationCap,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Video,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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

type VisibilityFilter = "all" | "mine" | "public"

type StoreCategory = {
  value: string
  label: string
}

type StoreCard = {
  id: string
  title: string
  description: string
  author: string
  category: string
  rating?: string
  icon: React.ReactNode
  source?: CustomGPT
}

const storeCategories: StoreCategory[] = [
  { value: "All", label: "Principales selecciones" },
  { value: "Education", label: "Educación" },
  { value: "Productivity", label: "Productividad" },
  { value: "Research & Analysis", label: "Investigación y análisis" },
  { value: "Writing", label: "Escritura" },
  { value: "Lifestyle", label: "Estilo de vida" },
  { value: "DALL·E", label: "DALL·E" },
  { value: "Programming", label: "Programación" },
  { value: "Design", label: "Diseño" },
  { value: "Marketing", label: "Marketing" },
]

const curatedStoreCards: StoreCard[] = [
  {
    id: "curated-video-ai",
    title: "Video AI by invideo",
    description: "AI video maker GPT (Supercharged with Sora 2) - generate engaging videos with scripts, scenes and assets.",
    author: "Por invideo.io",
    category: "DALL·E",
    rating: "4.0 ★",
    icon: <Video className="h-9 w-9 text-black dark:text-white" />,
  },
  {
    id: "curated-expedia",
    title: "Expedia",
    description: "Bring your trip plans to life — get there, stay there, find things to see and do.",
    author: "Por expedia.com",
    category: "Lifestyle",
    icon: <ArrowRight className="h-12 w-12 text-[#171a3f]" />,
  },
  {
    id: "curated-canva",
    title: "Canva",
    description: "Effortlessly design anything: presentations, logos, social media posts and more.",
    author: "Por community builder",
    category: "Design",
    icon: <span className="font-serif text-6xl italic leading-none text-white">C</span>,
  },
  {
    id: "curated-scholar",
    title: "Scholar GPT",
    description: "Enhance research with 200M+ resources and built-in critical reading skills. Access Google Scholar, PubMed, bioRxiv, arXiv...",
    author: "Por awesomegpts.ai",
    category: "Research & Analysis",
    icon: <GraduationCap className="h-9 w-9 text-white" />,
  },
  {
    id: "curated-fitness",
    title: "Fitness, Workout & Diet - PhD Coach",
    description: "IMPROVE QUICKLY. Receive turn-key fitness and workout support plus advanced diet advice.",
    author: "Por Newgen PhD",
    category: "Health & Fitness",
    icon: <span className="text-4xl font-bold text-white">P</span>,
  },
  {
    id: "curated-code",
    title: "Code Copilot Studio",
    description: "Plan, generate, test and refactor production code with structured prompts and QA gates.",
    author: "Por siraGPT Labs",
    category: "Programming",
    icon: <Code className="h-9 w-9 text-white" />,
  },
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

function GPTIcon({ gpt }: { gpt: CustomGPT }) {
  const iconSrc = resolveIconSrc(gpt.iconUrl)

  if (iconSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={iconSrc} alt={`${gpt.name} icon`} loading="lazy" decoding="async" className="h-full w-full rounded-full object-cover" />
    )
  }

  return <Bot className="h-9 w-9 text-zinc-950" />
}

function gptToStoreCard(gpt: CustomGPT): StoreCard {
  return {
    id: gpt.id,
    title: gpt.name,
    description: gpt.description || "Asistente personalizado con instrucciones persistentes, conocimiento RAG y conversación especializada.",
    author: `Por ${gpt.creator?.name || "siraGPT"}`,
    category: gpt.category || "All",
    rating: `${Math.max(4, Math.min(5, 4 + ((gpt._count?.conversations || 0) % 10) / 10)).toFixed(1)} ★`,
    icon: <GPTIcon gpt={gpt} />,
    source: gpt,
  }
}

function CuratedIconShell({ card }: { card: StoreCard }) {
  const palette = card.id.includes("expedia")
    ? "bg-[#ffe45c] text-[#171a3f]"
    : card.id.includes("canva")
      ? "bg-[radial-gradient(circle_at_25%_20%,#65e0dc,#5145f6_74%)]"
      : card.id.includes("scholar")
        ? "bg-[#6c2df4]"
        : card.id.includes("fitness")
          ? "bg-black ring-4 ring-sky-300/60"
          : card.id.includes("code")
            ? "bg-zinc-950"
            : "bg-white dark:bg-zinc-800 text-black dark:text-white ring-1 ring-zinc-200 dark:ring-zinc-700"

  return (
    <div className={cn("grid h-16 w-16 shrink-0 place-items-center rounded-full", palette)}>
      {card.icon}
    </div>
  )
}

function StoreCardView({
  card,
  onOpen,
  onEdit,
  onDelete,
  isOwner,
}: {
  card: StoreCard
  onOpen: (card: StoreCard) => void
  onEdit?: (gpt: CustomGPT) => void
  onDelete?: (gpt: CustomGPT) => void
  isOwner?: boolean
}) {
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => onOpen(card)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onOpen(card)
      }}
      className="group relative flex min-h-[104px] cursor-pointer items-center gap-4 rounded-2xl bg-[#f8f8f8] p-4 transition duration-200 hover:bg-[#f1f1f1] focus:outline-none focus:ring-2 focus:ring-zinc-950/20"
    >
      {card.source ? (
        <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-full bg-white dark:bg-zinc-800 ring-1 ring-zinc-200 dark:ring-zinc-700">
          {card.icon}
        </div>
      ) : (
        <CuratedIconShell card={card} />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-4">
          <h3 className="line-clamp-1 text-[1rem] font-semibold leading-tight tracking-[-0.025em] text-zinc-950">
            {card.title}
          </h3>
          {card.source && isOwner && (onEdit || onDelete) && (
            <div className="flex shrink-0 items-center gap-1 opacity-100 md:opacity-0 transition md:group-hover:opacity-100">
              {onEdit && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    onEdit(card.source!)
                  }}
                  className="grid h-8 w-8 place-items-center rounded-full bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 shadow-sm hover:text-zinc-950 dark:hover:text-white"
                  aria-label="Editar GPT"
                >
                  <Edit className="h-4 w-4" />
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    onDelete(card.source!)
                  }}
                  className="grid h-8 w-8 place-items-center rounded-full bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 shadow-sm hover:text-rose-600 dark:hover:text-rose-500"
                  aria-label="Eliminar GPT"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
        <p className="mt-1 line-clamp-2 max-w-[20rem] text-[0.82rem] leading-[1.22rem] text-zinc-800">
          {card.rating ? `${card.rating} - ` : ""}
          {card.description}
        </p>
        <p className="mt-1.5 text-[0.78rem] text-zinc-400">{card.author}</p>
      </div>
    </article>
  )
}

function TrendingRow({ index, card, onOpen }: { index: number; card: StoreCard; onOpen: (card: StoreCard) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      className="grid w-full grid-cols-[28px_46px_1fr] items-center gap-3 rounded-xl px-1.5 py-2 text-left transition hover:bg-zinc-50"
    >
      <span className="text-center text-[1rem] font-semibold text-zinc-950">{index}</span>
      {card.source ? (
        <span className="grid h-11 w-11 place-items-center overflow-hidden rounded-full bg-[#f5f5f5] ring-1 ring-zinc-200">
          {card.icon}
        </span>
      ) : (
        <span className="scale-[0.43]">
          <CuratedIconShell card={card} />
        </span>
      )}
      <span className="min-w-0">
        <span className="line-clamp-1 text-[0.88rem] font-semibold leading-tight tracking-[-0.02em] text-zinc-950">{card.title}</span>
        <span className="mt-0.5 line-clamp-2 text-[0.78rem] leading-4 text-zinc-700">{card.description}</span>
        <span className="mt-0.5 block text-[0.74rem] text-zinc-400">{card.author}</span>
      </span>
    </button>
  )
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-[1.35rem] font-semibold tracking-[-0.04em] text-zinc-950 md:text-[1.55rem]">{title}</h2>
      <p className="mt-0.5 text-[0.88rem] text-zinc-400">{subtitle}</p>
    </div>
  )
}

export default function GPTsPage() {
  const { user } = useAuth()
  const { selectChat } = useChat()
  const router = useRouter()
  const categoryNavRef = useRef<HTMLDivElement | null>(null)

  const [gpts, setGpts] = useState<CustomGPT[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedCategory, setSelectedCategory] = useState("All")
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("all")
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [selectedGPT, setSelectedGPT] = useState<CustomGPT | null>(null)

  const debouncedSearchQuery = useDebounce(searchQuery, 300)

  const fetchGPTs = useCallback(async () => {
    setLoading(true)
    try {
      const filters: GPTFilters = {
        search: debouncedSearchQuery || undefined,
        category: selectedCategory !== "All" ? selectedCategory : undefined,
        visibility: visibilityFilter,
      }

      const fetchedGPTs = await gptsService.getGPTs(filters)
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

  const createdCards = useMemo(() => {
    return [...gpts]
      .sort((a, b) => {
        if (a.isFeatured && !b.isFeatured) return -1
        if (!a.isFeatured && b.isFeatured) return 1
        return (b._count?.conversations || 0) - (a._count?.conversations || 0)
      })
      .map(gptToStoreCard)
  }, [gpts])

  const visibleCuratedCards = useMemo(() => {
    if (visibilityFilter === "mine") return []
    const normalizedQuery = debouncedSearchQuery.trim().toLowerCase()
    return curatedStoreCards.filter(card => {
      const matchesCategory = selectedCategory === "All" || card.category === selectedCategory
      const matchesSearch = !normalizedQuery
        || card.title.toLowerCase().includes(normalizedQuery)
        || card.description.toLowerCase().includes(normalizedQuery)
      return matchesCategory && matchesSearch
    })
  }, [debouncedSearchQuery, selectedCategory, visibilityFilter])

  const featuredCards = useMemo(() => {
    const merged = [...createdCards.filter(card => card.source?.isFeatured), ...createdCards.filter(card => !card.source?.isFeatured), ...visibleCuratedCards]
    const unique = new Map<string, StoreCard>()
    for (const card of merged) unique.set(card.id, card)
    return Array.from(unique.values()).slice(0, 4)
  }, [createdCards, visibleCuratedCards])

  const trendingCards = useMemo(() => {
    const merged = visibilityFilter === "mine" ? createdCards : [...createdCards, ...curatedStoreCards]
    const unique = new Map<string, StoreCard>()
    for (const card of merged) {
      if (selectedCategory === "All" || card.category === selectedCategory || card.source?.category === selectedCategory) {
        unique.set(card.id, card)
      }
    }
    return Array.from(unique.values()).slice(0, 8)
  }, [createdCards, selectedCategory, visibilityFilter])

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

  const handleOpenCard = async (card: StoreCard) => {
    if (card.source) {
      await handleStartChat(card.source)
      return
    }
    router.push(`/gpts/create?category=${encodeURIComponent(card.category)}`)
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

  const handleCreateNew = () => {
    const category = selectedCategory !== "All" ? `?category=${encodeURIComponent(selectedCategory)}` : ""
    router.push(`/gpts/create${category}`)
  }

  const handleMine = () => {
    setVisibilityFilter("mine")
    setSelectedCategory("All")
  }

  const copyShareLink = async () => {
    if (!selectedGPT) return
    await navigator.clipboard.writeText(gptsService.getShareUrl(selectedGPT.shareId))
    toast.success("Enlace copiado")
  }

  const scrollCategories = (direction: "left" | "right") => {
    categoryNavRef.current?.scrollBy({ left: direction === "left" ? -260 : 260, behavior: "smooth" })
  }

  return (
    <main data-testid="gpts-store-page" className="min-h-full bg-white dark:bg-background text-zinc-950 dark:text-foreground">
      <div className="mx-auto flex min-h-full w-full max-w-[1220px] flex-col px-6 py-4 sm:px-8 lg:px-12">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-[1.25rem] font-medium tracking-[-0.04em] text-zinc-950">Explorar GPT</h1>
          <div className="flex items-center gap-4">
            <button
              type="button"
              data-testid="gpts-mine-button"
              onClick={handleMine}
              className={cn(
                "text-[0.88rem] font-semibold tracking-[-0.02em] transition hover:text-zinc-600",
                visibilityFilter === "mine" ? "text-zinc-950 dark:text-zinc-100" : "text-zinc-900 dark:text-zinc-300"
              )}
            >
              Mis GPT
            </button>
            <Button data-testid="gpts-create-button" onClick={handleCreateNew} className="h-10 rounded-full bg-black dark:bg-white px-4 text-[0.88rem] font-semibold text-white dark:text-black hover:bg-zinc-800 dark:hover:bg-zinc-200">
              <Plus className="mr-2 h-4 w-4" />
              Crear
            </Button>
          </div>
        </header>

        <section className="mx-auto mt-5 w-full max-w-[640px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <Input
              data-testid="gpts-search"
              placeholder="Buscar GPT"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="h-10 rounded-xl border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 pl-11 text-[0.94rem] text-zinc-900 dark:text-zinc-100 shadow-none placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus-visible:ring-1 focus-visible:ring-zinc-300 dark:focus-visible:ring-zinc-600"
            />
          </div>
        </section>

        <section className="mx-auto mt-8 w-full max-w-[640px]">
          <div className="relative flex items-center">
            <button
              type="button"
              onClick={() => scrollCategories("left")}
              className="mr-2 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 transition hover:bg-zinc-200 dark:hover:bg-zinc-700"
              aria-label="Categorías anteriores"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div ref={categoryNavRef} className="flex flex-1 items-center gap-6 overflow-x-auto scroll-smooth [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {storeCategories.map(category => {
                const active = selectedCategory === category.value
                return (
                  <button
                    key={category.value}
                    type="button"
                    onClick={() => {
                      setSelectedCategory(category.value)
                      setVisibilityFilter("all")
                    }}
                    className={cn(
                      "relative shrink-0 pb-2.5 text-[0.88rem] font-medium tracking-[-0.025em] transition",
                      active ? "text-zinc-950 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                    )}
                  >
                    {category.label}
                    {active && <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-zinc-950" />}
                  </button>
                )
              })}
            </div>
            <button
              type="button"
              onClick={() => scrollCategories("right")}
              className="ml-2 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 transition hover:bg-zinc-200 dark:hover:bg-zinc-700"
              aria-label="Siguientes categorías"
            >
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </section>

        <section className="mx-auto mt-7 w-full max-w-[640px]">
          <SectionHeader title={visibilityFilter === "mine" ? "Mis GPT" : "Featured"} subtitle={visibilityFilter === "mine" ? "Tus asistentes creados por área" : "Curated top picks from this week"} />

          {loading ? (
            <div className="mt-4 grid gap-2.5 md:grid-cols-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="min-h-[104px] animate-pulse rounded-2xl bg-[#f8f8f8] p-4">
                  <div className="flex gap-4">
                    <div className="h-16 w-16 rounded-full bg-zinc-200" />
                    <div className="flex-1 pt-2">
                      <div className="h-6 w-3/5 rounded bg-zinc-200" />
                      <div className="mt-4 h-4 w-full rounded bg-zinc-200" />
                      <div className="mt-2 h-4 w-4/5 rounded bg-zinc-200" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : featuredCards.length > 0 ? (
            <div className="mt-4 grid gap-2.5 md:grid-cols-2">
              {featuredCards.map(card => (
                <StoreCardView
                  key={card.id}
                  card={card}
                  onOpen={handleOpenCard}
                  onEdit={card.source?.creator?.id === user?.id ? handleEdit : undefined}
                  onDelete={card.source?.creator?.id === user?.id ? handleDelete : undefined}
                  isOwner={card.source?.creator?.id === user?.id}
                />
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-2xl bg-[#f8f8f8] p-7 text-center">
              <Sparkles className="mx-auto h-10 w-10 text-zinc-400" />
              <h3 className="mt-4 text-2xl font-semibold tracking-[-0.04em]">Aún no tienes GPTs en esta área</h3>
              <p className="mx-auto mt-2 max-w-xl text-zinc-500">Crea uno desde esta categoría para que aparezca automáticamente en la tienda.</p>
              <Button onClick={handleCreateNew} className="mt-6 rounded-full bg-black px-6 text-white hover:bg-zinc-800">Crear GPT</Button>
            </div>
          )}
        </section>

        <section className="mx-auto mt-8 w-full max-w-[640px] pb-10">
          <SectionHeader title="Trending" subtitle="Most popular GPTs by our community" />
          <div className="mt-4 grid gap-x-6 gap-y-1 md:grid-cols-2">
            {trendingCards.map((card, index) => (
              <TrendingRow key={`trending-${card.id}`} index={index + 1} card={card} onOpen={handleOpenCard} />
            ))}
          </div>
        </section>

        <Dialog open={shareDialogOpen} onOpenChange={setShareDialogOpen}>
          <DialogContent className="rounded-3xl border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 sm:max-w-lg">
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
