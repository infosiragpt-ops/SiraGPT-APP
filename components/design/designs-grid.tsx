"use client"

/**
 * DesignsGrid — right-side panel on /design. Top-level tabs for
 * Designs / Examples / Design systems (latter two stubbed); within
 * Designs, a "Recent" vs "Your designs" selector and a searchable
 * grid of the user's design projects.
 *
 * Recent vs Your designs today both show the same query (the user's
 * own designs, newest first) because we don't have a "seen by others"
 * dimension yet — that would come with the multi-user sharing story.
 * When that lands, Recent keeps the newest-updated semantics and
 * Your designs narrows to owned-by-me.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { Folder, Search, Trash2 } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { es as dfEs, enUS as dfEn } from "date-fns/locale"
import { toast } from "sonner"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { designService, type DesignSummary } from "@/lib/design-service"

type TopTab = "designs" | "examples" | "systems"
type SubTab = "recent" | "your_designs"

export function DesignsGrid() {
  const router = useRouter()
  const [topTab, setTopTab] = React.useState<TopTab>("designs")
  const [subTab, setSubTab] = React.useState<SubTab>("recent")
  const [search, setSearch] = React.useState("")
  const [debounced, setDebounced] = React.useState("")
  const [designs, setDesigns] = React.useState<DesignSummary[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 220)
    return () => clearTimeout(t)
  }, [search])

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setDesigns(await designService.list(debounced))
    } catch (err: any) {
      toast.error(err?.message || "Could not load designs")
    } finally {
      setLoading(false)
    }
  }, [debounced])

  React.useEffect(() => { load() }, [load])

  async function remove(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return
    const prev = designs
    setDesigns(cur => cur.filter(d => d.id !== id))
    try {
      await designService.remove(id)
    } catch (err: any) {
      toast.error(err?.message || "Delete failed")
      setDesigns(prev)
    }
  }

  const dateLocale =
    typeof document !== "undefined" && document.documentElement.lang?.startsWith("es")
      ? dfEs : dfEn

  return (
    <div className="min-w-0 flex-1 flex flex-col">
      {/* Top tabs + search */}
      <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-2 mb-5">
        <nav className="flex gap-6">
          {[
            { key: "designs" as TopTab,  label: "Designs" },
            { key: "examples" as TopTab, label: "Examples" },
            { key: "systems" as TopTab,  label: "Design systems" },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setTopTab(t.key)}
              className={cn(
                "relative pb-2 text-sm transition-colors",
                topTab === t.key
                  ? "text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {topTab === t.key && (
                <span className="absolute inset-x-0 -bottom-2 h-0.5 bg-foreground" />
              )}
            </button>
          ))}
        </nav>
        <div className="relative w-60">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="h-8 pl-9 text-xs rounded-full"
          />
        </div>
      </div>

      {/* Content by top tab */}
      {topTab === "designs" && (
        <div className="space-y-4">
          {/* Recent/Your designs pill group */}
          <div className="inline-flex rounded-full border border-border/60 bg-card p-0.5">
            {[
              { key: "recent" as SubTab,       label: "Recent" },
              { key: "your_designs" as SubTab, label: "Your designs" },
            ].map(t => (
              <button
                key={t.key}
                onClick={() => setSubTab(t.key)}
                className={cn(
                  "px-3.5 py-1 rounded-full text-xs transition-colors",
                  subTab === t.key
                    ? "bg-foreground text-background font-medium"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {loading ? (
            <SkeletonGrid />
          ) : designs.length === 0 ? (
            <EmptyState search={debounced} />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {designs.map(d => (
                <DesignCard
                  key={d.id}
                  design={d}
                  dateLocale={dateLocale}
                  onOpen={() => router.push(`/design/${d.id}`)}
                  onDelete={() => remove(d.id, d.name)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {topTab === "examples" && <StubPane label="Examples · próximamente" />}
      {topTab === "systems"  && <StubPane label="Design systems · próximamente" />}
    </div>
  )
}

// ─── Card ──────────────────────────────────────────────────────────────────

function DesignCard({
  design, dateLocale, onOpen, onDelete,
}: {
  design: DesignSummary
  dateLocale: any
  onOpen: () => void
  onDelete: () => void
}) {
  const rel = React.useMemo(() => {
    try {
      return formatDistanceToNow(new Date(design.updatedAt), { addSuffix: true, locale: dateLocale })
    } catch { return "" }
  }, [design.updatedAt, dateLocale])

  return (
    <div
      onClick={onOpen}
      className="group rounded-xl border border-border/60 bg-card overflow-hidden cursor-pointer hover:border-foreground/30 hover:shadow-sm transition-all"
    >
      <div className="aspect-video bg-muted/30 flex items-center justify-center border-b border-border/60">
        <Folder className="h-8 w-8 text-muted-foreground/40" />
      </div>
      <div className="px-4 py-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{design.name}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Your design · {rel}
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-600 transition-all shrink-0"
          aria-label="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

// ─── Empty / stub / skeleton ───────────────────────────────────────────────

function EmptyState({ search }: { search: string }) {
  return (
    <div className="text-center py-20 text-sm text-muted-foreground">
      {search
        ? `No designs matching "${search}".`
        : "Aún no tienes diseños. Crea uno en el panel de la izquierda."}
    </div>
  )
}

function StubPane({ label }: { label: string }) {
  return (
    <div className="text-center py-20 text-sm text-muted-foreground">
      {label}
    </div>
  )
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border/60 overflow-hidden">
          <div className="aspect-video bg-muted/40 animate-pulse" />
          <div className="px-4 py-3 space-y-2">
            <div className="h-3 w-1/2 bg-muted/50 rounded animate-pulse" />
            <div className="h-2 w-1/3 bg-muted/40 rounded animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  )
}
