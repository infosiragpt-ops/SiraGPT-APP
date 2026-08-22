"use client"

import { useState, useEffect, useRef } from "react"
import { 
  Bot, 
  Settings, 
  Plus, 
  MoreHorizontal, 
  RefreshCw, 
  Download, 
  Upload,
  Play,
  Pause,
  Clock,
  CheckCircle,
  XCircle,
  Zap,
  Database,
  Search
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { AdminPageHeader, AdminStatCard, AdminPageBody } from "@/components/admin/admin-chrome"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { toast } from "sonner"
import { IconProvider } from "@/components/icon-provider"
import { getNormalizedApiBaseUrl } from "@/lib/api-base-url"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { resolveModelIconName } from "@/lib/model-icons"
import { devLog } from "@/lib/dev-log"

interface AIModel {
  id: string
  name: string
  displayName: string
  provider: string
  description?: string
  isActive: boolean
  type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'MUSIC'
  icon?: string | null
  lastSynced?: string
  syncSource?: string
  contextLength?: number
  pricing?: any
  tags?: string[]
  createdAt: string
  updatedAt: string
}

interface ProviderStats {
  total: number
  active: number
  inactive: number
  byProvider: Record<string, number>
}

interface SyncStatus {
  isScheduled: boolean
  isRunning: boolean
  nextRun?: string
  lastSync?: {
    timestamp: string
    result: {
      created: number
      updated: number
      errors: number
    }
    status: string
  }
  history?: any[]
}

const initialFormData = {
  name: '',
  displayName: '',
  provider: 'DeepSeek',
  type: 'TEXT' as 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'MUSIC',
  icon: 'Bot',
  description: '',
  apiKey: ''
};

const API_ROOT = getNormalizedApiBaseUrl()

function adminAuthHeaders(token: string | null, includeJson = false): HeadersInit {
  const headers: Record<string, string> = {}
  if (includeJson) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/** Compact iOS-style switch: 32px track, 28px thumb, 44px tap target. */
function ModelActiveSwitch({
  checked,
  disabled,
  onCheckedChange,
  ariaLabel,
}: {
  checked: boolean
  disabled?: boolean
  onCheckedChange: (next: boolean) => void
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md disabled:opacity-60"
    >
      <span
        aria-hidden
        className="relative block overflow-hidden rounded-full"
        style={{
          width: 52,
          height: 32,
          backgroundColor: checked ? "#34C759" : "#D1D5DB",
          transition: "background-color 160ms ease",
        }}
      >
        <span
          className="absolute top-[2px] block rounded-full bg-white shadow-md"
          style={{
            width: 28,
            height: 28,
            left: checked ? 22 : 2,
            transition: "left 160ms ease",
          }}
        />
      </span>
    </button>
  )
}

export default function ModelsPage() {
  const [models, setModels] = useState<AIModel[]>([])
  const [providers, setProviders] = useState<string[]>([])
  const [stats, setStats] = useState<ProviderStats | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isFetching, setIsFetching] = useState(false)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [formData, setFormData] = useState(initialFormData)
  const [editingModel, setEditingModel] = useState<AIModel | null>(null)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<string>('ALL PROVIDERS')
  const [selectedType, setSelectedType] = useState<string>('ALL TYPES')
  const [searchQuery, setSearchQuery] = useState('')
  const [activosOpen, setActivosOpen] = useState(false)
  const [activosQuery, setActivosQuery] = useState('')
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1)
  const [modelsPerPage] = useState(20)
  const [totalPages, setTotalPages] = useState(1)

  useEffect(() => {
    loadInitialData()
    // loadInitialData is defined below in the component body, so adding
    // it to deps would lint-loop. Intent is "load once on mount", and
    // loadInitialData closes over no changing state, so an empty deps
    // array is the right shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadInitialData = async () => {
    setIsLoading(true)
    try {
      await Promise.all([
        loadModels(),
        loadProviders(),
        loadStats(),
        loadSyncStatus()
      ])
    } catch (error) {
      console.error('Failed to load initial data:', error)
      toast.error('No se pudieron cargar los datos')
    } finally {
      setIsLoading(false)
    }
  }

  const loadModels = async () => {
    try {
      const token = localStorage.getItem('auth-token')
      const response = await authenticatedFetch(`${API_ROOT}/admin/models`, {
        headers: adminAuthHeaders(token)
      })

      if (response.ok) {
        const data = await response.json()
        setModels(data.models)
      } else {
        toast.error('No se pudieron cargar los modelos')
      }
    } catch (error) {
      console.error('Failed to load models:', error)
    }
  }

  const loadProviders = async () => {
    try {
      const token = localStorage.getItem('auth-token')
      const response = await authenticatedFetch(`${API_ROOT}/admin/providers`, {
        headers: adminAuthHeaders(token)
      })

      if (response.ok) {
        const data = await response.json()
        setProviders(data.providers)
      }
    } catch (error) {
      console.error('Failed to load providers:', error)
    }
  }

  const loadStats = async () => {
    try {
      const token = localStorage.getItem('auth-token')
      const response = await authenticatedFetch(`${API_ROOT}/admin/models/stats`, {
        headers: adminAuthHeaders(token)
      })

      if (response.ok) {
        const data = await response.json()
        setStats(data.stats)
      }
    } catch (error) {
      console.error('Failed to load stats:', error)
    }
  }

  const loadSyncStatus = async () => {
    try {
      const token = localStorage.getItem('auth-token')
      const response = await authenticatedFetch(`${API_ROOT}/admin/models/sync/status`, {
        headers: adminAuthHeaders(token)
      })

      if (response.ok) {
        const data = await response.json()
        // The API wraps the payload: { status: { isScheduled, nextRun, … } }.
        // Reading the top level left isScheduled always undefined, which
        // made the scheduler toggle always send action:'start'.
        setSyncStatus(data?.status ?? data)
      }
    } catch (error) {
      console.error('Failed to load sync status:', error)
    }
  }

  const fetchModelsFromProviders = async () => {
    setIsFetching(true)
    try {
      const token = localStorage.getItem('auth-token')
      const response = await authenticatedFetch(`${API_ROOT}/admin/models/fetch`, {
        headers: adminAuthHeaders(token)
      })

      const data = await response.json()
      
      if (data.success) {
        toast.success(`Se obtuvieron ${data.count} modelos de los proveedores`)
        devLog('Fetched models:', data.models)
        devLog('Provider breakdown:', data.providers)
      } else {
        toast.error(data.error || 'No se pudieron obtener los modelos')
      }
    } catch (error) {
      console.error('Failed to fetch models:', error)
      toast.error('No se pudieron obtener los modelos')
    } finally {
      setIsFetching(false)
    }
  }

  const syncModelsToDatabase = async () => {
    setIsSyncing(true)
    try {
      const token = localStorage.getItem('auth-token')
      const response = await authenticatedFetch(`${API_ROOT}/admin/models/sync`, {
        method: 'POST',
        headers: adminAuthHeaders(token)
      })

      const data = await response.json()
      
      if (data.success) {
        toast.success(`Sincronizados: ${data.result.created} creados, ${data.result.updated} actualizados`)
        await Promise.all([loadModels(), loadStats(), loadSyncStatus()])
      } else {
        toast.error(data.error || 'No se pudieron sincronizar los modelos')
      }
    } catch (error) {
      console.error('Failed to sync models:', error)
      toast.error('No se pudieron sincronizar los modelos')
    } finally {
      setIsSyncing(false)
    }
  }

  const toggleScheduler = async () => {
    try {
      const token = localStorage.getItem('auth-token')
      const action = syncStatus?.isScheduled ? 'stop' : 'start'
      
      const response = await authenticatedFetch(`${API_ROOT}/admin/models/sync/scheduler`, {
        method: 'POST',
        headers: adminAuthHeaders(token, true),
        body: JSON.stringify({ action })
      })

      const data = await response.json()
      
      if (data.success) {
        toast.success(data.message)
        loadSyncStatus()
      } else {
        toast.error(data.error)
      }
    } catch (error) {
      console.error('Failed to toggle scheduler:', error)
      toast.error('No se pudo cambiar el programador')
    }
  }

  const runImmediateSync = async () => {
    setIsSyncing(true)
    try {
      const token = localStorage.getItem('auth-token')
      const response = await authenticatedFetch(`${API_ROOT}/admin/models/sync/run`, {
        method: 'POST',
        headers: adminAuthHeaders(token)
      })

      const data = await response.json()
      
      if (data.success) {
        toast.success(`Sincronización lista: ${data.result.created} creados, ${data.result.updated} actualizados`)
        await Promise.all([loadModels(), loadStats(), loadSyncStatus()])
      } else {
        toast.error(data.error || 'No se pudo sincronizar')
      }
    } catch (error) {
      console.error('Failed to run immediate sync:', error)
      toast.error('No se pudo sincronizar')
    } finally {
      setIsSyncing(false)
    }
  }

  const handleCreateModel = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const token = localStorage.getItem('auth-token')
      const response = await authenticatedFetch(`${API_ROOT}/admin/models`, {
        method: 'POST',
        headers: adminAuthHeaders(token, true),
        body: JSON.stringify(formData)
      })

      if (response.ok) {
        toast.success('Model created successfully')
        setIsDialogOpen(false)
        setFormData(initialFormData)
        await Promise.all([loadModels(), loadStats()])
      } else {
        const error = await response.json()
        toast.error(error.error || 'No se pudo crear el modelo')
      }
    } catch (error) {
      toast.error('No se pudo crear el modelo')
    }
  }

  const handleEditModel = (model: AIModel) => {
    setEditingModel({ ...model })
  }

  const handleUpdateModel = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingModel) return

    try {
      const token = localStorage.getItem('auth-token')
      const response = await authenticatedFetch(`${API_ROOT}/admin/models/${editingModel.id}`, {
        method: 'PUT',
        headers: adminAuthHeaders(token, true),
        body: JSON.stringify({
          name: editingModel.name,
          displayName: editingModel.displayName,
          provider: editingModel.provider,
          type: editingModel.type,
          description: editingModel.description,
          contextLength: editingModel.contextLength,
          isActive: editingModel.isActive
        })
      })

      if (response.ok) {
        toast.success('Model updated successfully')
        setEditingModel(null)
        await Promise.all([loadModels(), loadStats()])
      } else {
        const error = await response.json()
        toast.error(error.error || 'No se pudo actualizar el modelo')
      }
    } catch (error) {
      toast.error('No se pudo actualizar el modelo')
    }
  }

  const togglingIdsRef = useRef<Set<string>>(new Set())

  const toggleModelStatus = async (modelId: string, currentStatus: boolean) => {
    if (togglingIdsRef.current.has(modelId)) return
    togglingIdsRef.current.add(modelId)
    const next = !currentStatus
    setModels((prev) => prev.map((m) => (m.id === modelId ? { ...m, isActive: next } : m)))
    setStats((prev) => prev ? {
      ...prev,
      active: Math.max(0, prev.active + (next ? 1 : -1)),
      inactive: Math.max(0, prev.inactive + (next ? -1 : 1)),
    } : prev)
    try {
      const token = localStorage.getItem('auth-token')
      const response = await authenticatedFetch(`${API_ROOT}/admin/models/${modelId}`, {
        method: 'PATCH',
        headers: adminAuthHeaders(token, true),
        body: JSON.stringify({ isActive: next })
      })
      if (!response.ok) throw new Error('toggle failed')
      toast.success(next ? 'Modelo activado' : 'Modelo desactivado')
    } catch (error) {
      setModels((prev) => prev.map((m) => (m.id === modelId ? { ...m, isActive: currentStatus } : m)))
      setStats((prev) => prev ? {
        ...prev,
        active: Math.max(0, prev.active + (currentStatus ? 1 : -1)),
        inactive: Math.max(0, prev.inactive + (currentStatus ? -1 : 1)),
      } : prev)
      toast.error('No se pudo actualizar el modelo')
    } finally {
      togglingIdsRef.current.delete(modelId)
    }
  }

  // Filter models based on search and filters
  const filteredModels = models.filter(model => {
    const matchesSearch = model.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         model.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         model.provider.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesProvider = selectedProvider === 'ALL PROVIDERS' || model.provider === selectedProvider
    const matchesType = selectedType === 'ALL TYPES' || model.type === selectedType
    
    return matchesSearch && matchesProvider && matchesType
  })

  const activosModels = models
    .filter((m) => m.isActive)
    .slice()
    .sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name, 'es'))
  const activosQ = activosQuery.trim().toLowerCase()
  const activosVisible = activosQ
    ? activosModels.filter((m) =>
        m.displayName.toLowerCase().includes(activosQ) ||
        m.name.toLowerCase().includes(activosQ) ||
        m.provider.toLowerCase().includes(activosQ)
      )
    : activosModels

  // Pagination logic
  const totalFilteredModels = filteredModels.length
  const totalPagesCalculated = Math.ceil(totalFilteredModels / modelsPerPage)
  const startIndex = (currentPage - 1) * modelsPerPage
  const endIndex = startIndex + modelsPerPage
  const paginatedModels = filteredModels.slice(startIndex, endIndex)

  // Update total pages when filters change
  useEffect(() => {
    setTotalPages(totalPagesCalculated)
    setCurrentPage(1) // Reset to first page when filters change
  }, [totalFilteredModels, totalPagesCalculated])

  const goToPage = (page: number) => {
    setCurrentPage(page)
  }

  const goToPrevPage = () => {
    setCurrentPage(prev => Math.max(prev - 1, 1))
  }

  const goToNextPage = () => {
    setCurrentPage(prev => Math.min(prev + 1, totalPages))
  }

  const getProviderIcon = (provider: string) => {
    return resolveModelIconName({ provider })
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const formatModelCost = (pricing?: any) => {
    if (!pricing) {
      return {
        main: 'N/D',
        detail: 'sin precio',
      }
    }

    const input = typeof pricing.input === 'number' ? pricing.input : null
    const output = typeof pricing.output === 'number' ? pricing.output : null

    if (input === null && output === null) {
      return {
        main: 'N/D',
        detail: pricing.source || 'sin precio',
      }
    }

    const money = (value: number | null) => value === null ? 'N/D' : `$${value.toLocaleString('en-US', {
      minimumFractionDigits: value >= 1 ? 2 : 4,
      maximumFractionDigits: value >= 1 ? 2 : 6,
    })}`

    return {
      main: `${money(input)} in / ${money(output)} out`,
      detail: pricing.unit === 'per_1m_tokens' ? 'por 1M tokens' : (pricing.unit || pricing.source || ''),
    }
  }

  if (isLoading) {
    return (
      <>
        <AdminPageHeader title="Modelos IA" description="Cargando catálogo…" />
        <AdminPageBody>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ThinkingIndicator size="sm" />
            <span>Cargando modelos…</span>
          </div>
        </AdminPageBody>
      </>
    )
  }

  return (
    <>
      <AdminPageHeader
        title="Modelos IA"
        description="Gestiona y sincroniza modelos de varios proveedores"
        actions={
          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          {/* Vista previa de modelos disponibles en los proveedores (GET
              /admin/models/fetch — verificado en vivo: 574 modelos). */}
          <Button
            variant="outline"
            onClick={fetchModelsFromProviders}
            disabled={isFetching}
            size="sm"
            className="h-8 text-[13px]"
          >
            {isFetching ? (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            )}
            Obtener
          </Button>
          
          <Button 
            variant="outline" 
            onClick={syncModelsToDatabase} 
            disabled={isSyncing}
            size="sm"
            className="h-8 text-[13px]"
          >
            {isSyncing ? (
              <ThinkingIndicator size="sm" className="mr-1.5" />
            ) : (
              <Upload className="mr-1.5 h-3.5 w-3.5" />
            )}
            Sincronizar
          </Button>

          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="h-8 text-[13px]">
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Agregar
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Agregar modelo de IA</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreateModel} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Nombre del modelo</Label>
                  <Input
                    id="name"
                    placeholder="e.g., gpt-4"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="displayName">Nombre visible</Label>
                  <Input
                    id="displayName"
                    placeholder="e.g., GPT-4"
                    value={formData.displayName}
                    onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="provider">Proveedor</Label>
                  <Select value={formData.provider} onValueChange={(value) => setFormData({ ...formData, provider: value })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(providers.length ? providers : ['DeepSeek']).map((p) => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="type">Tipo</Label>
                  <Select value={formData.type} onValueChange={(value) => setFormData({ ...formData, type: value as 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'MUSIC' })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="TEXT">Texto</SelectItem>
                      <SelectItem value="IMAGE">Imagen</SelectItem>
                      <SelectItem value="VIDEO">Video</SelectItem>
                      <SelectItem value="AUDIO">Audio / Voz</SelectItem>
                      <SelectItem value="MUSIC">Música</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Descripción</Label>
                  <Textarea
                    id="description"
                    placeholder="Enter model description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  />
                </div>
                <Button type="submit" className="w-full">
                  Crear modelo
                </Button>
              </form>
            </DialogContent>
          </Dialog>
          </div>
        }
      />
      <AdminPageBody className="space-y-3 pb-24">

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <AdminStatCard title="Total" value={stats.total} icon={Database} />
          <div className="relative">
            <AdminStatCard
              title="Activos"
              value={stats.active}
              icon={CheckCircle}
              valueClassName="text-emerald-600"
              description="Ver activos"
            />
            <button
              type="button"
              onClick={() => {
                setActivosQuery('')
                setActivosOpen(true)
              }}
              className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              aria-label="Ver activos"
            />
          </div>
          <AdminStatCard title="Inactivos" value={stats.inactive} icon={XCircle} valueClassName="text-red-600" />
          <AdminStatCard title="Proveedores" value={Object.keys(stats.byProvider).length} icon={Zap} />
        </div>
      )}

      <Dialog open={activosOpen} onOpenChange={setActivosOpen}>
        <DialogContent className="flex max-h-[80vh] max-w-lg flex-col gap-3 overflow-hidden">
          <DialogHeader>
            <DialogTitle>Modelos activos ({activosModels.length})</DialogTitle>
            <DialogDescription>
              Desactiva modelos sin recorrer la tabla completa.
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={activosQuery}
              onChange={(e) => setActivosQuery(e.target.value)}
              placeholder="Buscar por nombre o proveedor…"
              className="pl-8"
              autoFocus
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {activosVisible.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {activosModels.length === 0
                  ? 'No hay modelos activos.'
                  : 'Ningún activo coincide con la búsqueda.'}
              </p>
            ) : (
              <ul className="divide-y">
                {activosVisible.map((model) => (
                  <li key={model.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{model.displayName || model.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {model.provider}
                        {model.displayName && model.name && model.displayName !== model.name ? ` · ${model.name}` : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <ModelActiveSwitch
                        checked={model.isActive}
                        onCheckedChange={() => toggleModelStatus(model.id, model.isActive)}
                        ariaLabel="Desactivar modelo"
                      />
                      <span className="text-xs font-medium text-green-600 dark:text-green-500">Activo</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Auto-Sync Status — restored: GET /models/sync/status and the
          scheduler/run endpoints work (verified live); the card was hidden
          while the status shape bug made isScheduled read undefined. */}
      {syncStatus && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Sincronización automática</CardTitle>
                <CardDescription>
                  Sincronización automática desde proveedores
                </CardDescription>
              </div>
              <div className="flex items-center space-x-2">
                <Badge variant={syncStatus.isScheduled ? "default" : "secondary"}>
                  {syncStatus.isScheduled ? "Programada" : "Detenida"}
                </Badge>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={toggleScheduler}
                >
                  {syncStatus.isScheduled ? (
                    <><Pause className="mr-2 h-4 w-4" />Detener</>
                  ) : (
                    <><Play className="mr-2 h-4 w-4" />Iniciar</>
                  )}
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={runImmediateSync}
                  disabled={isSyncing}
                >
                  {isSyncing ? (
                    <ThinkingIndicator size="sm" className="mr-2" />
                  ) : (
                    <Zap className="mr-2 h-4 w-4" />
                  )}
                  Sincronizar
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <p className="text-sm font-medium">Última sincronización</p>
                <p className="text-sm text-muted-foreground">
                  {syncStatus.lastSync 
                    ? formatDate(syncStatus.lastSync.timestamp)
                    : 'Nunca'
                  }
                </p>
              </div>
              
              <div className="space-y-2">
                <p className="text-sm font-medium">Próxima sincronización</p>
                <p className="text-sm text-muted-foreground">
                  {syncStatus.nextRun && syncStatus.isScheduled
                    ? formatDate(syncStatus.nextRun)
                    : 'No programada'
                  }
                </p>
              </div>
              
              <div className="space-y-2">
                <p className="text-sm font-medium">Último resultado</p>
                <div className="text-sm">
                  {syncStatus.lastSync?.result && (
                    <div className="space-x-4">
                      <span className="text-green-600">
                        +{syncStatus.lastSync.result.created}
                      </span>
                      <span className="text-blue-600">
                        ~{syncStatus.lastSync.result.updated}
                      </span>
                      {syncStatus.lastSync.result.errors > 0 && (
                        <span className="text-red-600">
                          !{syncStatus.lastSync.result.errors}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters and Search */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
            <div>
              <CardTitle>Modelos ({totalFilteredModels})</CardTitle>
              <CardDescription>
                Mostrando {startIndex + 1}-{Math.min(endIndex, totalFilteredModels)} de {totalFilteredModels}
              </CardDescription>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-2">
              <Input
                placeholder="Buscar modelos…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full sm:w-48"
              />
              <Select value={selectedProvider} onValueChange={setSelectedProvider}>
                <SelectTrigger className="w-full sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL PROVIDERS">Todos los proveedores</SelectItem>
                  {providers.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {provider.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={selectedType} onValueChange={setSelectedType}>
                <SelectTrigger className="w-full sm:w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL TYPES">TODOS</SelectItem>
                  <SelectItem value="TEXT">Texto</SelectItem>
                  <SelectItem value="IMAGE">Imagen</SelectItem>
                  <SelectItem value="VIDEO">Video</SelectItem>
                  <SelectItem value="AUDIO">Audio / Voz</SelectItem>
                  <SelectItem value="MUSIC">Música</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* Models Table — desktop/tablet only; phones get the card list below */}
          <div className="hidden overflow-x-auto md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Modelo</TableHead>
                <TableHead>Proveedor</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Última sync</TableHead>
                <TableHead>Costo</TableHead>
                <TableHead>Contexto</TableHead>
                <TableHead>Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedModels.map((model) => (
                <TableRow key={model.id}>
                  <TableCell>
                    <div className="flex items-center space-x-2">
                      <IconProvider
                        name={resolveModelIconName(model)}
                        className="h-6 w-6"
                      />
                      <div>
                        <div className="font-medium">{model.displayName}</div>
                        <div className="text-sm text-muted-foreground">
                          {model.name}
                        </div>
                        {model.description && (
                          <div className="text-xs text-muted-foreground max-w-xs truncate">
                            {model.description}
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  
                  <TableCell>
                    <div className="flex items-center space-x-2">
                      <IconProvider 
                        name={getProviderIcon(model.provider)} 
                        className="h-4 w-4" 
                      />
                      <span>{model.provider}</span>
                    </div>
                  </TableCell>
                  
                  <TableCell>
                    <Badge
                      variant={
                        model.type === 'TEXT' ? 'default' :
                        model.type === 'VIDEO' ? 'outline' :
                        model.type === 'AUDIO' ? 'secondary' :
                        model.type === 'MUSIC' ? 'destructive' :
                        'secondary'
                      }
                      className={
                        model.type === 'AUDIO' ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 border-purple-200' :
                        model.type === 'MUSIC' ? 'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200 border-pink-200' :
                        model.type === 'VIDEO' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 border-blue-200' :
                        model.type === 'IMAGE' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 border-amber-200' :
                        ''
                      }
                    >
                      {model.type === 'TEXT' ? 'Texto' :
                       model.type === 'IMAGE' ? 'Imagen' :
                       model.type === 'VIDEO' ? 'Video' :
                       model.type === 'AUDIO' ? 'Audio' :
                       model.type === 'MUSIC' ? 'Música' :
                       model.type}
                    </Badge>
                  </TableCell>
                  
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <ModelActiveSwitch
                        checked={model.isActive}
                        onCheckedChange={() => toggleModelStatus(model.id, model.isActive)}
                        ariaLabel={model.isActive ? "Desactivar modelo" : "Activar modelo"}
                      />
                      <span className={model.isActive ? "text-xs font-medium text-green-600 dark:text-green-500" : "text-xs font-medium text-muted-foreground"}>
                        {model.isActive ? "Activo" : "Inactivo"}
                      </span>
                    </div>
                  </TableCell>
                  
                  <TableCell>
                    <div className="text-sm">
                      {model.lastSynced ? (
                        <>
                          <div>{formatDate(model.lastSynced)}</div>
                          <div className="text-xs text-muted-foreground">
                            via {model.syncSource}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">Nunca</span>
                      )}
                    </div>
                  </TableCell>
                  
                  <TableCell>
                    {(() => {
                      const cost = formatModelCost(model.pricing)
                      return (
                        <div className="text-sm">
                          <div className="whitespace-nowrap font-medium">{cost.main}</div>
                          <div className="text-xs text-muted-foreground">{cost.detail}</div>
                        </div>
                      )
                    })()}
                  </TableCell>
                  
                  <TableCell>
                    {model.contextLength && (
                      <span className="text-sm">
                        {model.contextLength.toLocaleString()}
                      </span>
                    )}
                  </TableCell>
                  
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 p-0">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEditModel(model)}>
                          <Settings className="mr-2 h-4 w-4" />
                          Editar
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>

          {/* Mobile card list — phones get a stacked, tappable layout instead
              of a side-scrolling 8-column table. Reuses the same handlers. */}
          <div className="space-y-2 md:hidden">
            {paginatedModels.map((model) => {
              const cost = formatModelCost(model.pricing)
              const typeLabel = model.type === 'TEXT' ? 'Texto'
                : model.type === 'IMAGE' ? 'Imagen'
                : model.type === 'VIDEO' ? 'Video'
                : model.type === 'AUDIO' ? 'Audio'
                : model.type === 'MUSIC' ? 'Música'
                : model.type
              return (
                <div key={model.id} className="rounded-lg border bg-card p-3">
                  <div className="flex items-start gap-2">
                    <IconProvider name={resolveModelIconName(model)} className="h-6 w-6 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{model.displayName}</div>
                      <div className="truncate text-xs text-muted-foreground">{model.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary" className="text-[11px]">{typeLabel}</Badge>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <IconProvider name={getProviderIcon(model.provider)} className="h-3.5 w-3.5" />
                          {model.provider}
                        </span>
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 shrink-0 p-0">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEditModel(model)}>
                          <Settings className="mr-2 h-4 w-4" />
                          Editar
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t border-border/60 pt-2">
                    <div className="flex items-center gap-2">
                      <ModelActiveSwitch
                        checked={model.isActive}
                        onCheckedChange={() => toggleModelStatus(model.id, model.isActive)}
                        ariaLabel={model.isActive ? "Desactivar modelo" : "Activar modelo"}
                      />
                      <span className={model.isActive ? "text-xs font-medium text-green-600 dark:text-green-500" : "text-xs font-medium text-muted-foreground"}>
                        {model.isActive ? "Activo" : "Inactivo"}
                      </span>
                    </div>
                    <span className="whitespace-nowrap text-xs text-muted-foreground">{cost.main}</span>
                  </div>
                </div>
              )
            })}
          </div>

          {paginatedModels.length === 0 && (
            <div className="text-center py-8">
              <Bot className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">
                No hay modelos que coincidan
              </p>
            </div>
          )}
        </CardContent>
        
        {/* Pagination Controls */}
        {totalPages > 1 && (
          <div className="px-6 pb-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <p className="text-sm text-muted-foreground">
                  Página {currentPage} de {totalPages} · {totalFilteredModels} modelos
                </p>
              </div>
              <div className="flex items-center space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={goToPrevPage}
                  disabled={currentPage === 1}
                >
                  Anterior
                </Button>
                
                <div className="flex items-center space-x-1">
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    let pageNumber;
                    if (totalPages <= 5) {
                      pageNumber = i + 1;
                    } else if (currentPage <= 3) {
                      pageNumber = i + 1;
                    } else if (currentPage >= totalPages - 2) {
                      pageNumber = totalPages - 4 + i;
                    } else {
                      pageNumber = currentPage - 2 + i;
                    }
                    
                    return (
                      <Button
                        key={pageNumber}
                        variant={currentPage === pageNumber ? "default" : "outline"}
                        size="sm"
                        onClick={() => goToPage(pageNumber)}
                        className="w-8 h-8 p-0"
                      >
                        {pageNumber}
                      </Button>
                    );
                  })}
                </div>
                
                <Button
                  variant="outline"
                  size="sm"
                  onClick={goToNextPage}
                  disabled={currentPage === totalPages}
                >
                  Siguiente
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Edit Model Dialog */}
      <Dialog open={editingModel !== null} onOpenChange={() => setEditingModel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar modelo</DialogTitle>
          </DialogHeader>
          {editingModel && (
            <form onSubmit={handleUpdateModel} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name">Nombre del modelo</Label>
                <Input
                  id="edit-name"
                  value={editingModel.name}
                  onChange={(e) => setEditingModel({ ...editingModel, name: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-displayName">Nombre visible</Label>
                <Input
                  id="edit-displayName"
                  value={editingModel.displayName}
                  onChange={(e) => setEditingModel({ ...editingModel, displayName: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-provider">Proveedor</Label>
                <Select value={editingModel.provider} onValueChange={(value) => setEditingModel({ ...editingModel, provider: value })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(providers.length ? providers : ['DeepSeek']).map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-type">Tipo</Label>
                <Select value={editingModel.type} onValueChange={(value) => setEditingModel({ ...editingModel, type: value as 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'MUSIC' })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TEXT">TEXT</SelectItem>
                    <SelectItem value="IMAGE">IMAGE</SelectItem>
                    <SelectItem value="VIDEO">VIDEO</SelectItem>
                    <SelectItem value="AUDIO">AUDIO</SelectItem>
                    <SelectItem value="MUSIC">MUSIC</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-description">Descripción</Label>
                <textarea
                  id="edit-description"
                  value={editingModel.description || ''}
                  onChange={(e) => setEditingModel({ ...editingModel, description: e.target.value })}
                  className="w-full p-2 border rounded-md"
                  rows={3}
                />
              </div>
              <div className="flex items-center space-x-2">
                <Switch
                  id="edit-isActive"
                  checked={editingModel.isActive}
                  onCheckedChange={(checked) => setEditingModel({ ...editingModel, isActive: checked })}
                />
                <Label htmlFor="edit-isActive">Activo</Label>
              </div>
              <div className="flex justify-end space-x-2">
                <Button type="button" variant="outline" onClick={() => setEditingModel(null)}>
                  Cancelar
                </Button>
                <Button type="submit">
                  Guardar
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
      </AdminPageBody>
    </>
  )
}
