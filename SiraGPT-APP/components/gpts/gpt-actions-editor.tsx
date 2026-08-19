"use client"

import { useState } from "react"
import { Plus, Trash2, Pencil, Globe, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export type GptActionMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
export type GptActionParamIn = "query" | "path" | "body"
export type GptActionParamType = "string" | "number" | "boolean"
export type GptActionAuthType = "none" | "api_key" | "bearer"

export interface GptActionParam {
  name: string
  in: GptActionParamIn
  type: GptActionParamType
  required: boolean
  description?: string
}

export interface GptActionAuth {
  type: GptActionAuthType
  in?: "header" | "query"
  name?: string
  secret?: string
  hasSecret?: boolean
}

export interface GptAction {
  id?: string
  name: string
  description: string
  method: GptActionMethod
  url: string
  params: GptActionParam[]
  auth: GptActionAuth
}

const EMPTY_ACTION: GptAction = {
  name: "",
  description: "",
  method: "GET",
  url: "",
  params: [],
  auth: { type: "none" },
}

const METHODS: GptActionMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"]

interface Props {
  actions: GptAction[]
  onChange: (actions: GptAction[]) => void
}

// ChatGPT-style external API "Actions" editor. The auth secret is write-only:
// the server returns `auth.hasSecret` (never the value), and an unchanged secret
// is preserved server-side on save, so we only ever send a NEW secret.
export function GptActionsEditor({ actions, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState<GptAction>(EMPTY_ACTION)

  const openNew = () => {
    setEditIndex(null)
    setDraft({ ...EMPTY_ACTION, params: [] })
    setOpen(true)
  }

  const openEdit = (index: number) => {
    setEditIndex(index)
    const a = actions[index]
    setDraft({
      ...EMPTY_ACTION,
      ...a,
      params: Array.isArray(a.params) ? a.params.map((p) => ({ ...p })) : [],
      auth: { ...(a.auth || { type: "none" }), secret: "" },
    })
    setOpen(true)
  }

  const removeAction = (index: number) => {
    onChange(actions.filter((_, i) => i !== index))
  }

  const canSave = draft.name.trim().length > 0 && draft.description.trim().length > 0 && /^https:\/\//i.test(draft.url.trim())

  const saveDraft = () => {
    if (!canSave) return
    // Drop an empty secret so we never overwrite a stored one with "".
    const auth: GptActionAuth = { ...draft.auth }
    if (!auth.secret || !auth.secret.trim()) delete auth.secret
    const cleaned: GptAction = {
      ...draft,
      name: draft.name.trim(),
      description: draft.description.trim(),
      url: draft.url.trim(),
      params: draft.params.filter((p) => p.name.trim().length > 0),
      auth,
    }
    if (editIndex === null) onChange([...actions, cleaned])
    else onChange(actions.map((a, i) => (i === editIndex ? cleaned : a)))
    setOpen(false)
  }

  const setParam = (i: number, patch: Partial<GptActionParam>) => {
    setDraft((d) => ({ ...d, params: d.params.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) }))
  }

  const addParam = () => {
    setDraft((d) => ({ ...d, params: [...d.params, { name: "", in: "query", type: "string", required: false }] }))
  }

  const removeParam = (i: number) => {
    setDraft((d) => ({ ...d, params: d.params.filter((_, idx) => idx !== i) }))
  }

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Acciones</Label>
      <p className="text-xs text-muted-foreground">
        Conecta APIs externas. El GPT podrá llamarlas durante la conversación.
      </p>

      {actions.length > 0 && (
        <div className="space-y-2">
          {actions.map((a, i) => (
            <div
              key={a.id || i}
              className="flex items-center gap-2 rounded-xl border border-black/[0.06] bg-white px-3 py-2 dark:border-white/10 dark:bg-zinc-900"
            >
              <Globe className="h-4 w-4 flex-shrink-0 text-zinc-400" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{a.name}</span>
                  <Badge variant="outline" className="text-[10px]">{a.method}</Badge>
                  {a.auth && a.auth.type !== "none" && (
                    <KeyRound className="h-3 w-3 text-zinc-400" aria-label="con autenticación" />
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">{a.url}</p>
              </div>
              <button type="button" onClick={() => openEdit(i)} className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Editar acción">
                <Pencil className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => removeAction(i)} className="rounded-md p-1.5 text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40" aria-label="Eliminar acción">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <Button variant="outline" size="sm" type="button" className="w-full justify-center" onClick={openNew}>
        <Plus className="mr-2 h-4 w-4" />
        {actions.length > 0 ? "Añadir otra acción" : "Crear nueva acción"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editIndex === null ? "Nueva acción" : "Editar acción"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label className="text-xs">Nombre (identificador de la herramienta)</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="get_weather"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Descripción (cuándo usarla)</Label>
              <Textarea
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                placeholder="Obtiene el clima actual de una ciudad."
                rows={2}
              />
            </div>

            <div className="grid grid-cols-[110px_1fr] gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Método</Label>
                <Select value={draft.method} onValueChange={(v) => setDraft((d) => ({ ...d, method: v as GptActionMethod }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">URL (https)</Label>
                <Input
                  value={draft.url}
                  onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
                  placeholder="https://api.ejemplo.com/v1/clima"
                />
              </div>
            </div>

            {/* Parameters */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Parámetros</Label>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={addParam}>
                  <Plus className="mr-1 h-3 w-3" /> Añadir
                </Button>
              </div>
              {draft.params.length === 0 && (
                <p className="text-xs text-muted-foreground">Sin parámetros. Usa {"{nombre}"} en la URL para parámetros de ruta.</p>
              )}
              {draft.params.map((p, i) => (
                <div key={i} className="grid grid-cols-[1fr_84px_90px_auto] items-center gap-1.5">
                  <Input
                    value={p.name}
                    onChange={(e) => setParam(i, { name: e.target.value })}
                    placeholder="nombre"
                    className="h-8 text-xs"
                  />
                  <Select value={p.in} onValueChange={(v) => setParam(i, { in: v as GptActionParamIn })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="query">query</SelectItem>
                      <SelectItem value="path">path</SelectItem>
                      <SelectItem value="body">body</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={p.type} onValueChange={(v) => setParam(i, { type: v as GptActionParamType })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="string">string</SelectItem>
                      <SelectItem value="number">number</SelectItem>
                      <SelectItem value="boolean">boolean</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-1">
                    <Checkbox checked={p.required} onCheckedChange={(c) => setParam(i, { required: c === true })} aria-label="requerido" />
                    <button type="button" onClick={() => removeParam(i)} className="rounded p-1 text-zinc-400 hover:text-red-600" aria-label="Quitar parámetro">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Auth */}
            <div className="space-y-2">
              <Label className="text-xs">Autenticación</Label>
              <Select
                value={draft.auth.type}
                onValueChange={(v) => setDraft((d) => ({ ...d, auth: { ...d.auth, type: v as GptActionAuthType } }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Ninguna</SelectItem>
                  <SelectItem value="api_key">API Key</SelectItem>
                  <SelectItem value="bearer">Bearer token</SelectItem>
                </SelectContent>
              </Select>

              {draft.auth.type === "api_key" && (
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    value={draft.auth.in || "header"}
                    onValueChange={(v) => setDraft((d) => ({ ...d, auth: { ...d.auth, in: v as "header" | "query" } }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="header">En cabecera</SelectItem>
                      <SelectItem value="query">En query</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={draft.auth.name || ""}
                    onChange={(e) => setDraft((d) => ({ ...d, auth: { ...d.auth, name: e.target.value } }))}
                    placeholder="X-API-Key"
                  />
                </div>
              )}

              {(draft.auth.type === "api_key" || draft.auth.type === "bearer") && (
                <Input
                  type="password"
                  value={draft.auth.secret || ""}
                  onChange={(e) => setDraft((d) => ({ ...d, auth: { ...d.auth, secret: e.target.value } }))}
                  placeholder={draft.auth.hasSecret ? "•••••• (guardada — deja vacío para conservar)" : "Pega aquí tu clave/token"}
                  autoComplete="off"
                />
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button type="button" onClick={saveDraft} disabled={!canSave}>Guardar acción</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
