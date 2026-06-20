"use client"

/**
 * /admin/connections — admin-curated upstream AI API connections.
 *
 * Each provider (OpenAI, Anthropic, Gemini, ...) groups one or more
 * base URLs. The admin can:
 *   - add a connection (URL + auth + extra headers + model allow-list)
 *   - toggle individual rows on/off
 *   - test a connection (calls the upstream /models endpoint)
 *   - edit/delete
 *
 * Enabled keys are applied to the backend provider bridge. Saving/testing a
 * connection also imports provider models into Admin → AI Models, where they
 * remain inactive until the admin explicitly publishes them.
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { Plus, RefreshCw, Eye, EyeOff, Trash2, CheckCircle2, XCircle, Plug, Settings as SettingsIcon, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"
import { apiClient } from "@/lib/api"

const KNOWN_URLS = [
  "https://api.fal.ai/v1",
  "https://api.openai.com/v1",
  "https://api.anthropic.com/v1",
  "https://generativelanguage.googleapis.com/v1beta/openai",
  "https://api.mistral.ai/v1",
  "https://api.groq.com/openai/v1",
  "https://openrouter.ai/api/v1",
  "https://api.together.xyz/v1",
  "https://api.fireworks.ai/inference/v1",
  "https://api.deepseek.com/v1",
  "https://api.x.ai/v1",
]

type AuthType = "Bearer" | "Key" | "None" | "Custom"
type ApiType = "chat_completions" | "responses" | "embeddings" | "video"

const PROVIDER_DEFAULTS: Record<string, { url: string; authType: AuthType; apiType: ApiType }> = {
  fal: { url: "https://api.fal.ai/v1", authType: "Key", apiType: "video" },
  openai: { url: "https://api.openai.com/v1", authType: "Bearer", apiType: "chat_completions" },
  anthropic: { url: "https://api.anthropic.com/v1", authType: "Bearer", apiType: "chat_completions" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai", authType: "Bearer", apiType: "chat_completions" },
  mistral: { url: "https://api.mistral.ai/v1", authType: "Bearer", apiType: "chat_completions" },
  groq: { url: "https://api.groq.com/openai/v1", authType: "Bearer", apiType: "chat_completions" },
  openrouter: { url: "https://openrouter.ai/api/v1", authType: "Bearer", apiType: "chat_completions" },
  together: { url: "https://api.together.xyz/v1", authType: "Bearer", apiType: "chat_completions" },
  fireworks: { url: "https://api.fireworks.ai/inference/v1", authType: "Bearer", apiType: "chat_completions" },
  deepseek: { url: "https://api.deepseek.com/v1", authType: "Bearer", apiType: "chat_completions" },
  xai: { url: "https://api.x.ai/v1", authType: "Bearer", apiType: "chat_completions" },
}

const PROVIDERS: Array<{ key: string; label: string }> = [
  { key: "fal", label: "fal.ai Video API" },
  { key: "openai", label: "OpenAI API" },
  { key: "anthropic", label: "Anthropic API" },
  { key: "gemini", label: "Google Gemini API" },
  { key: "mistral", label: "Mistral API" },
  { key: "groq", label: "Groq API" },
  { key: "openrouter", label: "OpenRouter API" },
  { key: "together", label: "Together AI API" },
  { key: "fireworks", label: "Fireworks AI API" },
  { key: "deepseek", label: "DeepSeek API" },
  { key: "xai", label: "xAI API" },
  { key: "custom", label: "Custom API" },
]

type Connection = {
  id: string
  url: string
  providerKey: string
  providerLabel: string
  apiKey: string | null
  apiKeySet: boolean
  authType: AuthType
  apiType: ApiType
  headers: Record<string, string> | null
  prefixId: string | null
  modelIds: string[]
  tags: string[]
  enabled: boolean
  lastSyncedAt: string | null
  lastSyncOk: boolean
  lastSyncError: string | null
}

type ProviderGroup = {
  providerKey: string
  providerLabel: string
  enabled: boolean
  connections: Connection[]
}

function inferProviderFromUrl(u: string): string {
  const lower = (u || "").toLowerCase()
  if (lower.includes("fal.ai") || lower.includes("fal.run")) return "fal"
  if (lower.includes("openai.com")) return "openai"
  if (lower.includes("anthropic.com")) return "anthropic"
  if (lower.includes("googleapis.com") || lower.includes("generativelanguage")) return "gemini"
  if (lower.includes("mistral.ai")) return "mistral"
  if (lower.includes("groq.com")) return "groq"
  if (lower.includes("openrouter.ai")) return "openrouter"
  if (lower.includes("together.xyz") || lower.includes("together.ai")) return "together"
  if (lower.includes("fireworks.ai")) return "fireworks"
  if (lower.includes("deepseek.com")) return "deepseek"
  if (lower.includes("x.ai")) return "xai"
  return "custom"
}

export default function AdminConnectionsPage() {
  const [groups, setGroups] = useState<ProviderGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Connection | null>(null)
  const [presetProvider, setPresetProvider] = useState<string>("custom")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiClient.getAdminConnections()
      setGroups((data as any).providers || [])
    } catch (e: any) {
      toast.error(`No se pudieron cargar las conexiones: ${e?.message || e}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Only render providers that actually have at least one connection.
  // Empty-provider cards add noise — adding a new connection goes
  // through the global "+ Agregar conexión" button instead.
  const renderedGroups = useMemo(() => {
    const present = groups.filter((g) => g.connections.length > 0)
    const order = new Map(PROVIDERS.map((p, i) => [p.key, i]))
    return present.sort((a, b) => (order.get(a.providerKey) ?? 999) - (order.get(b.providerKey) ?? 999))
  }, [groups])

  const disabledConnections = useMemo(
    () => groups.flatMap((g) => g.connections.filter((c) => !c.enabled)),
    [groups]
  )

  const openAdd = (providerKey: string) => {
    setEditing(null)
    setPresetProvider(providerKey)
    setModalOpen(true)
  }

  const openEdit = (c: Connection) => {
    setEditing(c)
    setPresetProvider(c.providerKey)
    setModalOpen(true)
  }

  const toggle = async (c: Connection, enabled: boolean) => {
    try {
      await apiClient.updateAdminConnection(c.id, { enabled })
      toast.success(enabled ? "Conexión activada" : "Conexión desactivada")
      load()
    } catch (e: any) {
      toast.error(`Error: ${e?.message || e}`)
    }
  }

  const remove = async (c: Connection) => {
    if (!confirm(`Eliminar conexión ${c.url}? Esta acción no se puede deshacer.`)) return
    try {
      await apiClient.deleteAdminConnection(c.id)
      toast.success("Conexión eliminada")
      load()
    } catch (e: any) {
      toast.error(`Error: ${e?.message || e}`)
    }
  }

  const testConn = async (c: Connection) => {
    const t = toast.loading(`Probando ${c.url}…`)
    try {
      const r: any = await apiClient.testAdminConnection(c.id)
      toast.dismiss(t)
      if (r?.ok) toast.success(`OK — ${r.count} modelo(s) disponibles`)
      else toast.error(`Falló: ${r?.error || `HTTP ${r?.status}`}`)
      load()
    } catch (e: any) {
      toast.dismiss(t)
      toast.error(`Error: ${e?.message || e}`)
    }
  }

  const healthCheckAll = async () => {
    const t = toast.loading("Probando todas las conexiones…")
    try {
      const r: any = await apiClient.healthCheckAdminConnections()
      toast.dismiss(t)
      const results = r?.results || {}
      const healthy = Object.entries(results).filter(([_, v]: any) => v?.healthy).map(([k]) => k)
      const unhealthy = Object.entries(results).filter(([_, v]: any) => v && !v.healthy && v.reason !== "no_key").map(([k]) => k)
      const noKey = Object.entries(results).filter(([_, v]: any) => v?.reason === "no_key").map(([k]) => k)
      const parts: string[] = []
      if (healthy.length) parts.push(`✓ ${healthy.join(", ")}`)
      if (unhealthy.length) parts.push(`✗ ${unhealthy.join(", ")}`)
      if (noKey.length) parts.push(`sin clave: ${noKey.join(", ")}`)
      toast.success(parts.join(" · ") || "Sin proveedores configurados")
      load()
    } catch (e: any) {
      toast.dismiss(t)
      toast.error(`Error: ${e?.message || e}`)
    }
  }

  const removeAllDisabled = async () => {
    if (disabledConnections.length === 0) return
    if (!confirm(`Eliminar ${disabledConnections.length} conexión(es) desactivada(s)? Esta acción no se puede deshacer.`)) return
    try {
      await Promise.all(disabledConnections.map((c) => apiClient.deleteAdminConnection(c.id)))
      toast.success(`${disabledConnections.length} conexión(es) eliminada(s)`)
      load()
    } catch (e: any) {
      toast.error(`Error: ${e?.message || e}`)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Plug className="h-6 w-6" /> Conexiones
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            API keys de proveedores. Las conexiones activas sincronizan modelos en AI Models como inactivos; publícalos desde AI Models.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {disabledConnections.length > 0 && (
            <Button variant="outline" onClick={removeAllDisabled} className="text-red-600 hover:text-red-700">
              <Trash2 className="h-4 w-4 mr-2" />
              Eliminar desactivadas ({disabledConnections.length})
            </Button>
          )}
          <Button variant="outline" onClick={healthCheckAll}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Probar todas
          </Button>
          <Button variant="outline" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refrescar
          </Button>
          <Button variant="outline" onClick={() => openAdd("fal")}>
            <Plus className="h-4 w-4 mr-2" />
            Agregar fal.ai
          </Button>
          <Button onClick={() => openAdd("openai")}>
            <Plus className="h-4 w-4 mr-2" />
            Agregar conexión
          </Button>
        </div>
      </div>

      {loading && groups.length === 0 ? (
        <div className="text-sm text-muted-foreground">Cargando conexiones…</div>
      ) : renderedGroups.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Plug className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground mb-4">
              No hay conexiones configuradas todavía.
            </p>
            <Button onClick={() => openAdd("openai")}>
              <Plus className="h-4 w-4 mr-2" />
              Agregar la primera
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {renderedGroups.map((g) => (
            <Card key={g.providerKey}>
              <CardHeader className="flex flex-row items-center justify-between py-3">
                <CardTitle className="text-base flex items-center gap-2">
                  {g.providerLabel}
                  <Badge variant={g.enabled ? "default" : "secondary"} className="text-xs font-normal">
                    {g.connections.length}
                  </Badge>
                </CardTitle>
                <Switch
                  checked={g.enabled}
                  onCheckedChange={async (v) => {
                    try {
                      await Promise.all(g.connections.map((c) => apiClient.updateAdminConnection(c.id, { enabled: v })))
                      toast.success(v ? `${g.providerLabel} activado` : `${g.providerLabel} desactivado`)
                      load()
                    } catch (e: any) {
                      toast.error(`Error: ${e?.message || e}`)
                    }
                  }}
                />
              </CardHeader>
              <CardContent className="pt-0 pb-3">
                <div className="space-y-1.5">
                  {g.connections.map((c) => (
                    <div key={c.id} className="flex items-center justify-between gap-2 py-1.5 px-2 -mx-2 rounded hover:bg-accent/40">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-mono truncate" title={c.url}>{c.url}</div>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          {c.apiKeySet ? (
                            <Badge variant="outline" className="text-[10px] py-0 font-mono">{c.apiKey}</Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] py-0 text-amber-600">sin api key</Badge>
                          )}
                          {c.lastSyncedAt && (
                            c.lastSyncOk ? (
                              <Badge variant="outline" className="text-[10px] py-0 text-green-600 flex items-center gap-1">
                                <CheckCircle2 className="h-3 w-3" /> OK
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px] py-0 text-red-600 flex items-center gap-1" title={c.lastSyncError || ""}>
                                <XCircle className="h-3 w-3" /> fail
                              </Badge>
                            )
                          )}
                          {c.modelIds.length > 0 && (
                            <Badge variant="outline" className="text-[10px] py-0">{c.modelIds.length} modelo(s)</Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button variant="ghost" size="sm" onClick={() => testConn(c)} title="Probar /models">
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(c)} title="Editar">
                          <SettingsIcon className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => remove(c)} title="Eliminar">
                          <Trash2 className="h-4 w-4 text-red-600" />
                        </Button>
                        <Switch checked={c.enabled} onCheckedChange={(v) => toggle(c, v)} />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConnectionDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        connection={editing}
        defaultProvider={presetProvider}
        onSaved={load}
      />
    </div>
  )
}

function ConnectionDialog({
  open,
  onOpenChange,
  connection,
  defaultProvider,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  connection: Connection | null
  defaultProvider: string
  onSaved: () => void
}) {
  const isEdit = !!connection
  const [url, setUrl] = useState("")
  const [providerKey, setProviderKey] = useState(defaultProvider)
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [authType, setAuthType] = useState<AuthType>("Bearer")
  const [apiType, setApiType] = useState<ApiType>("chat_completions")
  const [headersJson, setHeadersJson] = useState("")
  const [prefixId, setPrefixId] = useState("")
  const [modelIdsInput, setModelIdsInput] = useState("")
  const [modelIds, setModelIds] = useState<string[]>([])
  const [tagsInput, setTagsInput] = useState("")
  const [tags, setTags] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      if (connection) {
        setUrl(connection.url)
        setProviderKey(connection.providerKey)
        setApiKey("") // edit: don't show old value, blank = keep
        setAuthType(connection.authType)
        setApiType(connection.apiType)
        setHeadersJson(connection.headers ? JSON.stringify(connection.headers, null, 2) : "")
        setPrefixId(connection.prefixId || "")
        setModelIds(connection.modelIds || [])
        setTags(connection.tags || [])
      } else {
        const defaults = PROVIDER_DEFAULTS[defaultProvider]
        setUrl(defaults?.url || "")
        setProviderKey(defaultProvider)
        setApiKey("")
        setAuthType(defaults?.authType || "Bearer")
        setApiType(defaults?.apiType || "chat_completions")
        setHeadersJson("")
        setPrefixId("")
        setModelIds([])
        setTags([])
      }
      setModelIdsInput("")
      setTagsInput("")
      setShowKey(false)
      setShowSuggestions(false)
    }
  }, [open, connection, defaultProvider])

  const applyProviderDefaults = (nextProvider: string) => {
    setProviderKey(nextProvider)
    const defaults = PROVIDER_DEFAULTS[nextProvider]
    if (!defaults || isEdit) return
    setUrl((current) => (!current || KNOWN_URLS.includes(current) ? defaults.url : current))
    setAuthType(defaults.authType)
    setApiType(defaults.apiType)
  }

  const submit = async () => {
    if (!url.trim()) {
      toast.error("URL es requerida")
      return
    }
    let headers: any = null
    if (headersJson.trim()) {
      try { headers = JSON.parse(headersJson) }
      catch { toast.error("Headers no es JSON válido"); return }
    }
    setSaving(true)
    try {
      const payload: any = {
        url: url.trim(),
        providerKey,
        authType,
        apiType,
        headers,
        prefixId: prefixId.trim() || null,
        modelIds,
        tags,
      }
      if (apiKey) payload.apiKey = apiKey
      let savedConnection: Connection
      if (isEdit) {
        savedConnection = await apiClient.updateAdminConnection(connection!.id, payload) as Connection
      } else {
        payload.enabled = true
        savedConnection = await apiClient.createAdminConnection(payload) as Connection
      }

      const canSyncModels = savedConnection.enabled && (authType === "None" || savedConnection.apiKeySet)
      if (canSyncModels) {
        const t = toast.loading("Sincronizando modelos en AI Models…")
        try {
          const syncResult: any = await apiClient.testAdminConnection(savedConnection.id)
          toast.dismiss(t)
          toast.success(`Conexión guardada. ${syncResult?.imported ?? syncResult?.count ?? 0} modelo(s) sincronizado(s) como inactivos.`)
        } catch (syncError: any) {
          toast.dismiss(t)
          toast.warning(`Conexión guardada, pero no se pudieron sincronizar modelos: ${syncError?.message || syncError}`)
        }
      } else {
        toast.success(isEdit ? "Conexión actualizada" : "Conexión creada")
      }

      await Promise.resolve(onSaved())
      onOpenChange(false)
    } catch (e: any) {
      toast.error(`Error: ${e?.message || e}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Editar conexión" : "Add Connection"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Connection Type</span>
            <span>External</span>
          </div>

          <div className="space-y-1.5 relative">
            <Label>URL</Label>
            <div className="flex items-center gap-2">
              <Input
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value)
                  const inferred = inferProviderFromUrl(e.target.value)
                  if (inferred !== "custom" && !isEdit) {
                    setProviderKey(inferred)
                    const defaults = PROVIDER_DEFAULTS[inferred]
                    if (defaults) {
                      setAuthType(defaults.authType)
                      setApiType(defaults.apiType)
                    }
                  }
                }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                placeholder="API Base URL"
              />
            </div>
            {showSuggestions && (
              <div className="absolute z-50 mt-1 w-full bg-popover border border-border rounded-md shadow-lg max-h-48 overflow-y-auto">
                {KNOWN_URLS.filter((u) => !url || u.toLowerCase().includes(url.toLowerCase())).map((u) => (
                  <button
                    key={u}
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent block"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setUrl(u)
                      const inferred = inferProviderFromUrl(u)
                      if (inferred !== "custom") applyProviderDefaults(inferred)
                      setShowSuggestions(false)
                    }}
                  >
                    {u}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Auth</Label>
            <div className="flex items-center gap-2">
              <Select value={authType} onValueChange={(v) => setAuthType(v as AuthType)}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Bearer">Bearer</SelectItem>
                  <SelectItem value="Key">Key</SelectItem>
                  <SelectItem value="None">None</SelectItem>
                  <SelectItem value="Custom">Custom</SelectItem>
                </SelectContent>
              </Select>
              <div className="relative flex-1">
                <Input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={isEdit ? (connection?.apiKeySet ? "Dejar vacío para conservar la actual" : "API Key") : (providerKey === "fal" ? "fal.ai API Key" : "API Key")}
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  title={showKey ? "Ocultar" : "Mostrar"}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Headers</Label>
            <Textarea
              value={headersJson}
              onChange={(e) => setHeadersJson(e.target.value)}
              placeholder='Enter additional headers in JSON format (e.g. {"X-Custom":"value"})'
              rows={3}
              className="font-mono text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Prefix ID</Label>
              <Input
                value={prefixId}
                onChange={(e) => setPrefixId(e.target.value)}
                placeholder="Prefix ID"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={providerKey} onValueChange={applyProviderDefaults}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>API Type</Label>
            <Select value={apiType} onValueChange={(v) => setApiType(v as ApiType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="chat_completions">Chat Completions</SelectItem>
                <SelectItem value="responses">Responses</SelectItem>
                <SelectItem value="embeddings">Embeddings</SelectItem>
                <SelectItem value="video">Video Generation</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Model IDs</Label>
            <div className="text-xs text-muted-foreground">
              {providerKey === "fal"
                ? "Opcional. Déjalo vacío para sincronizar el catálogo de video de fal.ai."
                : 'Leave empty to include all models from "/models" endpoint'}
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={modelIdsInput}
                onChange={(e) => setModelIdsInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && modelIdsInput.trim()) {
                    e.preventDefault()
                    if (!modelIds.includes(modelIdsInput.trim())) setModelIds([...modelIds, modelIdsInput.trim()])
                    setModelIdsInput("")
                  }
                }}
                placeholder="Add a model ID"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (modelIdsInput.trim() && !modelIds.includes(modelIdsInput.trim())) {
                    setModelIds([...modelIds, modelIdsInput.trim()])
                    setModelIdsInput("")
                  }
                }}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {modelIds.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {modelIds.map((m) => (
                  <Badge key={m} variant="secondary" className="flex items-center gap-1">
                    {m}
                    <button onClick={() => setModelIds(modelIds.filter((x) => x !== m))} className="hover:text-red-600">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Tags</Label>
            <div className="flex items-center gap-2">
              <Input
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagsInput.trim()) {
                    e.preventDefault()
                    if (!tags.includes(tagsInput.trim())) setTags([...tags, tagsInput.trim()])
                    setTagsInput("")
                  }
                }}
                placeholder="Add a tag..."
              />
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {tags.map((t) => (
                  <Badge key={t} variant="outline" className="flex items-center gap-1">
                    {t}
                    <button onClick={() => setTags(tags.filter((x) => x !== t))} className="hover:text-red-600">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={submit} disabled={saving}>
              {saving ? "Guardando…" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
