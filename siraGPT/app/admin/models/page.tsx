"use client"

import { useState, useEffect } from "react"
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
  Database
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "sonner"
import { IconProvider } from "@/components/icon-provider"
import { getNormalizedApiBaseUrl } from "@/lib/api-base-url"
import { resolveModelIconName } from "@/lib/model-icons"
import { devLog } from "@/lib/dev-log"

interface AIModel {
  id: string
  name: string
  displayName: string
  provider: string
  description?: string
  isActive: boolean
  type: 'TEXT' | 'IMAGE'
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
  provider: 'OpenAI',
  type: 'TEXT' as 'TEXT' | 'IMAGE',
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
      toast.error('Failed to load data')
    } finally {
      setIsLoading(false)
    }
  }

  const loadModels = async () => {
    try {
      const token = localStorage.getItem('auth-token')
      const response = await fetch(`${API_ROOT}/admin/models`, {
        headers: adminAuthHeaders(token)
      })

      if (response.ok) {
        const data = await response.json()
        setModels(data.models)
      } else {
        toast.error('Failed to load models')
      }
    } catch (error) {
      console.error('Failed to load models:', error)
    }
  }

  const loadProviders = async () => {
    try {
      const token = localStorage.getItem('auth-token')
      const response = await fetch(`${API_ROOT}/admin/providers`, {
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
      const response = await fetch(`${API_ROOT}/admin/models/stats`, {
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
      const response = await fetch(`${API_ROOT}/admin/models/sync/status`, {
        headers: adminAuthHeaders(token)
      })

      if (response.ok) {
        const data = await response.json()
        setSyncStatus(data)
      }
    } catch (error) {
      console.error('Failed to load sync status:', error)
    }
  }

  const fetchModelsFromProviders = async () => {
    setIsFetching(true)
    try {
      const token = localStorage.getItem('auth-token')
      const response = await fetch(`${API_ROOT}/admin/models/fetch`, {
        headers: adminAuthHeaders(token)
      })

      const data = await response.json()
      
      if (data.success) {
        toast.success(`Successfully fetched ${data.count} models from providers`)
        devLog('Fetched models:', data.models)
        devLog('Provider breakdown:', data.providers)
      } else {
        toast.error(data.error || 'Failed to fetch models')
      }
    } catch (error) {
      console.error('Failed to fetch models:', error)
      toast.error('Failed to fetch models')
    } finally {
      setIsFetching(false)
    }
  }

  const syncModelsToDatabase = async () => {
    setIsSyncing(true)
    try {
      const token = localStorage.getItem('auth-token')
      const response = await fetch(`${API_ROOT}/admin/models/sync`, {
        method: 'POST',
        headers: adminAuthHeaders(token)
      })

      const data = await response.json()
      
      if (data.success) {
        toast.success(`Models synced: ${data.result.created} created, ${data.result.updated} updated`)
        await Promise.all([loadModels(), loadStats(), loadSyncStatus()])
      } else {
        toast.error(data.error || 'Failed to sync models')
      }
    } catch (error) {
      console.error('Failed to sync models:', error)
      toast.error('Failed to sync models')
    } finally {
      setIsSyncing(false)
    }
  }

  const toggleScheduler = async () => {
    try {
      const token = localStorage.getItem('auth-token')
      const action = syncStatus?.isScheduled ? 'stop' : 'start'
      
      const response = await fetch(`${API_ROOT}/admin/models/sync/scheduler`, {
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
      toast.error('Failed to toggle scheduler')
    }
  }

  const runImmediateSync = async () => {
    setIsSyncing(true)
    try {
      const token = localStorage.getItem('auth-token')
      const response = await fetch(`${API_ROOT}/admin/models/sync/run`, {
        method: 'POST',
        headers: adminAuthHeaders(token)
      })

      const data = await response.json()
      
      if (data.success) {
        toast.success(`Immediate sync completed: ${data.result.created} created, ${data.result.updated} updated`)
        await Promise.all([loadModels(), loadStats(), loadSyncStatus()])
      } else {
        toast.error(data.error || 'Failed to run sync')
      }
    } catch (error) {
      console.error('Failed to run immediate sync:', error)
      toast.error('Failed to run sync')
    } finally {
      setIsSyncing(false)
    }
  }

  const bulkUpdateModels = async (action: 'enable' | 'disable', provider?: string) => {
    try {
      const token = localStorage.getItem('auth-token')
      const response = await fetch(`${API_ROOT}/admin/models/bulk`, {
        method: 'PUT',
        headers: adminAuthHeaders(token, true),
        body: JSON.stringify({ action, provider })
      })

      const data = await response.json()
      
      if (data.success) {
        toast.success(data.message)
        await Promise.all([loadModels(), loadStats()])
      } else {
        toast.error(data.error)
      }
    } catch (error) {
      console.error('Failed to bulk update models:', error)
      toast.error('Failed to update models')
    }
  }

  const handleCreateModel = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const token = localStorage.getItem('auth-token')
      const response = await fetch(`${API_ROOT}/admin/models`, {
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
        toast.error(error.error || 'Failed to create model')
      }
    } catch (error) {
      toast.error('Failed to create model')
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
      const response = await fetch(`${API_ROOT}/admin/models/${editingModel.id}`, {
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
        toast.error(error.error || 'Failed to update model')
      }
    } catch (error) {
      toast.error('Failed to update model')
    }
  }

  const toggleModelStatus = async (modelId: string, currentStatus: boolean) => {
    try {
      const token = localStorage.getItem('auth-token')
      const response = await fetch(`${API_ROOT}/admin/models/${modelId}`, {
        method: 'PUT',
        headers: adminAuthHeaders(token, true),
        body: JSON.stringify({ isActive: !currentStatus })
      })

      if (response.ok) {
        toast.success(`Model ${!currentStatus ? 'activated' : 'deactivated'}`)
        await Promise.all([loadModels(), loadStats()])
      } else {
        toast.error('Failed to update model')
      }
    } catch (error) {
      toast.error('Failed to update model')
    }
  }

  // Filter models based on search and filters
  const filteredModels = models.filter(model => {
    const matchesSearch = model.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         model.displayName.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesProvider = selectedProvider === 'ALL PROVIDERS' || 
                           (selectedProvider === 'OPENAI' && model.provider === 'OpenAI') ||
                           (selectedProvider === 'GEMINI' && model.provider === 'Gemini') ||
                           (selectedProvider === 'DEEPSEEK' && model.provider === 'DeepSeek') ||
                           (selectedProvider === 'OPENROUTER' && model.provider === 'OpenRouter')
    const matchesType = selectedType === 'ALL TYPES' || model.type === selectedType
    
    return matchesSearch && matchesProvider && matchesType
  })

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

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-4 pb-24 sm:px-6 lg:px-8">
        <div className="flex items-center space-x-2">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span>Loading models...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 px-4 py-4 pb-24 sm:space-y-6 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <SidebarTrigger className="mt-1 h-9 w-9 shrink-0 md:hidden" />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">AI Models</h1>
            <p className="text-sm text-muted-foreground sm:text-base">Manage and sync AI models from multiple providers</p>
          </div>
        </div>
        
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          {/* Fetch Models - Commented out, auto-sync handles this
          <Button 
            variant="outline" 
            onClick={fetchModelsFromProviders} 
            disabled={isFetching}
          >
            {isFetching ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Fetch Models
          </Button>
          */}
          
          <Button 
            variant="outline" 
            onClick={syncModelsToDatabase} 
            disabled={isSyncing}
            size="sm"
          >
            {isSyncing ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            <span className="hidden sm:inline">Sync Models</span>
            <span className="sm:hidden">Sync</span>
          </Button>

          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-2 h-4 w-4" />
                <span className="hidden sm:inline">Add Model</span>
                <span className="sm:hidden">Add</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Add New AI Model</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreateModel} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Model Name</Label>
                  <Input
                    id="name"
                    placeholder="e.g., gpt-4"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="displayName">Display Name</Label>
                  <Input
                    id="displayName"
                    placeholder="e.g., GPT-4"
                    value={formData.displayName}
                    onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="provider">Provider</Label>
                  <Select value={formData.provider} onValueChange={(value) => setFormData({ ...formData, provider: value })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OpenAI">OpenAI</SelectItem>
                      <SelectItem value="Gemini">Gemini</SelectItem>
                      <SelectItem value="OpenRouter">OpenRouter</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="type">Model Type</Label>
                  <Select value={formData.type} onValueChange={(value) => setFormData({ ...formData, type: value as 'TEXT' | 'IMAGE' })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="TEXT">TEXT</SelectItem>
                      <SelectItem value="IMAGE">IMAGE</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    placeholder="Enter model description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  />
                </div>
                <Button type="submit" className="w-full">
                  Create Model
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2 sm:p-6 sm:pb-2">
              <CardTitle className="text-sm font-medium">Total Models</CardTitle>
              <Database className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2 sm:p-6 sm:pb-2">
              <CardTitle className="text-sm font-medium">Active Models</CardTitle>
              <CheckCircle className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="text-2xl font-bold text-green-600">{stats.active}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2 sm:p-6 sm:pb-2">
              <CardTitle className="text-sm font-medium">Inactive Models</CardTitle>
              <XCircle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="text-2xl font-bold text-red-600">{stats.inactive}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2 sm:p-6 sm:pb-2">
              <CardTitle className="text-sm font-medium">Providers</CardTitle>
              <Zap className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="text-2xl font-bold">{Object.keys(stats.byProvider).length}</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Auto-Sync Status - Commented out for now, will auto-sync on deployment
      {syncStatus && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">Auto-Sync Status</CardTitle>
                <CardDescription>
                  Automatic model synchronization from providers
                </CardDescription>
              </div>
              <div className="flex items-center space-x-2">
                <Badge variant={syncStatus.isScheduled ? "default" : "secondary"}>
                  {syncStatus.isScheduled ? "Scheduled" : "Stopped"}
                </Badge>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={toggleScheduler}
                >
                  {syncStatus.isScheduled ? (
                    <><Pause className="mr-2 h-4 w-4" />Stop</>
                  ) : (
                    <><Play className="mr-2 h-4 w-4" />Start</>
                  )}
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={runImmediateSync}
                  disabled={isSyncing}
                >
                  {isSyncing ? (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Zap className="mr-2 h-4 w-4" />
                  )}
                  Sync Now
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <p className="text-sm font-medium">Last Sync</p>
                <p className="text-sm text-muted-foreground">
                  {syncStatus.lastSync 
                    ? formatDate(syncStatus.lastSync.timestamp)
                    : 'Never'
                  }
                </p>
              </div>
              
              <div className="space-y-2">
                <p className="text-sm font-medium">Next Sync</p>
                <p className="text-sm text-muted-foreground">
                  {syncStatus.nextRun && syncStatus.isScheduled
                    ? formatDate(syncStatus.nextRun)
                    : 'Not scheduled'
                  }
                </p>
              </div>
              
              <div className="space-y-2">
                <p className="text-sm font-medium">Last Result</p>
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
      */}

      {/* Filters and Search */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
            <div>
              <CardTitle>Models ({totalFilteredModels})</CardTitle>
              <CardDescription>
                Showing {startIndex + 1}-{Math.min(endIndex, totalFilteredModels)} of {totalFilteredModels} models
              </CardDescription>
            </div>
            <div className="flex items-center space-x-2">
              <Input
                placeholder="Search models..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-48"
              />
              <Select value={selectedProvider} onValueChange={setSelectedProvider}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL PROVIDERS">ALL PROVIDERS</SelectItem>
                  <SelectItem value="OPENAI">OPENAI</SelectItem>
                  <SelectItem value="GEMINI">GEMINI</SelectItem>
                  <SelectItem value="DEEPSEEK">DEEPSEEK</SelectItem>
                  <SelectItem value="OPENROUTER">OPENROUTER</SelectItem>
                </SelectContent>
              </Select>
              <Select value={selectedType} onValueChange={setSelectedType}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL TYPES">ALL TYPES</SelectItem>
                  <SelectItem value="TEXT">TEXT</SelectItem>
                  <SelectItem value="IMAGE">IMAGE</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* Models Table */}
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Synced</TableHead>
                <TableHead>Context</TableHead>
                <TableHead>Actions</TableHead>
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
                    <Badge variant={model.type === 'TEXT' ? 'default' : 'secondary'}>
                      {model.type}
                    </Badge>
                  </TableCell>
                  
                  <TableCell>
                    <div className="flex items-center space-x-2">
                      <Switch
                        checked={model.isActive}
                        onCheckedChange={() => toggleModelStatus(model.id, model.isActive)}
                      />
                      <Badge variant={model.isActive ? "default" : "secondary"}>
                        {model.isActive ? "Active" : "Inactive"}
                      </Badge>
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
                        <span className="text-muted-foreground">Never</span>
                      )}
                    </div>
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
                          Edit Model
                        </DropdownMenuItem>
                        <DropdownMenuItem 
                          onClick={() => toggleModelStatus(model.id, model.isActive)}
                        >
                          {model.isActive ? "Deactivate" : "Activate"}
                        </DropdownMenuItem>
                        <DropdownMenuItem>View Details</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>

          {paginatedModels.length === 0 && (
            <div className="text-center py-8">
              <Bot className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">
                No models found matching your criteria
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
                  Page {currentPage} of {totalPages} • {totalFilteredModels} total models
                </p>
              </div>
              <div className="flex items-center space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={goToPrevPage}
                  disabled={currentPage === 1}
                >
                  Previous
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
                  Next
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
            <DialogTitle>Edit Model</DialogTitle>
          </DialogHeader>
          {editingModel && (
            <form onSubmit={handleUpdateModel} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name">Model Name</Label>
                <Input
                  id="edit-name"
                  value={editingModel.name}
                  onChange={(e) => setEditingModel({ ...editingModel, name: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-displayName">Display Name</Label>
                <Input
                  id="edit-displayName"
                  value={editingModel.displayName}
                  onChange={(e) => setEditingModel({ ...editingModel, displayName: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-provider">Provider</Label>
                <Select value={editingModel.provider} onValueChange={(value) => setEditingModel({ ...editingModel, provider: value })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OpenAI">OpenAI</SelectItem>
                    <SelectItem value="Gemini">Gemini</SelectItem>
                    <SelectItem value="OpenRouter">OpenRouter</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-type">Type</Label>
                <Select value={editingModel.type} onValueChange={(value) => setEditingModel({ ...editingModel, type: value as 'TEXT' | 'IMAGE' })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TEXT">TEXT</SelectItem>
                    <SelectItem value="IMAGE">IMAGE</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-description">Description</Label>
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
                <Label htmlFor="edit-isActive">Active</Label>
              </div>
              <div className="flex justify-end space-x-2">
                <Button type="button" variant="outline" onClick={() => setEditingModel(null)}>
                  Cancel
                </Button>
                <Button type="submit">
                  Update Model
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
