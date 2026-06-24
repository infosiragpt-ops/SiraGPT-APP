"use client"

import React from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { Brain, Plus, Trash2, Search as SearchIcon, Check, X, Pencil } from "lucide-react"
import { toast } from "sonner"
import { apiClient } from "@/lib/api"

type MemoryEntry = {
  id: string
  text: string
  category: string
  source?: string
  mentions?: number
  updatedAt?: number
}

const CATEGORY_LABELS: Record<string, string> = {
  personal: "Datos personales",
  preference: "Preferencias",
  work: "Trabajo y contexto",
  instruction: "Instrucciones",
  knowledge: "Conocimiento",
}

const CATEGORIES = ["personal", "preference", "work", "instruction", "knowledge"]

export function MemorySettingsCard() {
  const [entries, setEntries] = React.useState<MemoryEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [query, setQuery] = React.useState("")
  const [newText, setNewText] = React.useState("")
  const [newCategory, setNewCategory] = React.useState("personal")
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editText, setEditText] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiClient.getMemory()
      setEntries(Array.isArray(data.entries) ? data.entries : [])
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  const add = async () => {
    const text = newText.trim()
    if (text.length < 2) return
    setBusy(true)
    try {
      await apiClient.addMemoryEntry(text, newCategory)
      setNewText("")
      toast.success("Memoria añadida")
      await load()
    } catch {
      toast.error("No se pudo añadir la memoria")
    } finally {
      setBusy(false)
    }
  }

  const saveEdit = async (id: string) => {
    const text = editText.trim()
    if (text.length < 2) return
    setBusy(true)
    try {
      await apiClient.updateMemoryEntry(id, { text })
      setEditingId(null)
      toast.success("Memoria actualizada")
      await load()
    } catch {
      toast.error("No se pudo actualizar")
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setBusy(true)
    try {
      await apiClient.deleteMemoryEntry(id)
      await load()
    } catch {
      toast.error("No se pudo eliminar")
    } finally {
      setBusy(false)
    }
  }

  const clearAll = async () => {
    if (!window.confirm("¿Borrar toda la memoria que SiraGPT tiene sobre ti? Esta acción no se puede deshacer.")) return
    setBusy(true)
    try {
      await apiClient.clearMemory()
      toast.success("Memoria borrada")
      await load()
    } catch {
      toast.error("No se pudo borrar la memoria")
    } finally {
      setBusy(false)
    }
  }

  const q = query.trim().toLowerCase()
  const visible = q
    ? entries.filter((e) => e.text.toLowerCase().includes(q) || (CATEGORY_LABELS[e.category] || e.category).toLowerCase().includes(q))
    : entries

  return (
    <Card className="border-border/60 shadow-sm">
      <div className="p-5 border-b border-border/60 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Brain className="h-5 w-5 mt-0.5 text-muted-foreground" />
          <div>
            <h2 className="text-base font-semibold tracking-tight">Memoria persistente</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              SiraGPT aprende automáticamente lo que es duradero sobre ti en cada conversación. Aquí puedes ver, editar o borrar lo que recuerda.
            </p>
          </div>
        </div>
        {entries.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clearAll} disabled={busy} className="text-destructive shrink-0">
            <Trash2 className="h-4 w-4 mr-1" /> Borrar todo
          </Button>
        )}
      </div>

      <div className="p-5 space-y-4">
        {/* Search */}
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar en la memoria…"
            className="pl-9"
          />
        </div>

        {/* Add new */}
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add() }}
            placeholder="Añadir algo que SiraGPT deba recordar…"
            className="flex-1"
          />
          <Select value={newCategory} onValueChange={setNewCategory}>
            <SelectTrigger className="sm:w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={add} disabled={busy || newText.trim().length < 2}>
            <Plus className="h-4 w-4 mr-1" /> Añadir
          </Button>
        </div>

        {/* List */}
        {loading ? (
          <p className="text-sm text-muted-foreground py-4">Cargando memoria…</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            {entries.length === 0
              ? "Aún no hay nada en la memoria. A medida que converses, SiraGPT recordará aquí lo importante."
              : "Sin resultados para tu búsqueda."}
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {visible.map((e) => (
              <li key={e.id} className="flex items-center gap-3 p-3">
                {editingId === e.id ? (
                  <>
                    <Input
                      value={editText}
                      onChange={(ev) => setEditText(ev.target.value)}
                      onKeyDown={(ev) => { if (ev.key === "Enter") void saveEdit(e.id) }}
                      className="flex-1"
                      autoFocus
                    />
                    <Button variant="ghost" size="icon" onClick={() => saveEdit(e.id)} disabled={busy}>
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setEditingId(null)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm break-words">{e.text}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="secondary" className="text-[10px]">{CATEGORY_LABELS[e.category] || e.category}</Badge>
                        {e.source === "auto" && <span className="text-[10px] text-muted-foreground">aprendido</span>}
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => { setEditingId(e.id); setEditText(e.text) }}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => remove(e.id)} disabled={busy} className="text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

export default MemorySettingsCard
