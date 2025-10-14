// "use client"

// import { useState, useEffect } from "react"
// import { Bot, Settings, Plus, MoreHorizontal } from "lucide-react"
// import { Button } from "@/components/ui/button"
// import { Input } from "@/components/ui/input"
// import { Label } from "@/components/ui/label"
// import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
// import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
// import { Badge } from "@/components/ui/badge"
// import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
// import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
// import { Textarea } from "@/components/ui/textarea"
// import { Switch } from "@/components/ui/switch"
// import { apiClient } from "@/lib/api"
// import { toast } from "sonner"
// import { IconProvider } from "@/components/icon-provider"
// interface AIModel {
//   id: string
//   name: string
//   displayName: string
//   provider: string
//   description?: string
//   isActive: boolean
//   type: 'TEXT' | 'IMAGE' // <-- Type shamil karein
//   icon?: string | null    // <-- Icon shamil karein
//   createdAt: string
//   updatedAt: string
// }
// const initialFormData = {
//   name: '',
//   displayName: '',
//   provider: '',
//   type: 'TEXT' as 'TEXT' | 'IMAGE',
//   icon: 'Bot',
//   description: '',
//   apiKey: ''
// };


// export default function ModelsPage() {
//   const [models, setModels] = useState<AIModel[]>([])
//   const [isLoading, setIsLoading] = useState(true)
//   const [isDialogOpen, setIsDialogOpen] = useState(false)
//   const [formData, setFormData] = useState(initialFormData)

//   useEffect(() => {
//     loadModels()
//   }, [])

//   const loadModels = async () => {
//     try {
//       const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/models`, {
//         headers: {
//           'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
//         }
//       })

//       if (response.ok) {
//         const data = await response.json()
//         setModels(data.models)
//       }
//     } catch (error) {
//       console.error('Failed to load models:', error)
//       toast.error('Failed to load models')
//     } finally {
//       setIsLoading(false)
//     }
//   }

//   const handleCreateModel = async (e: React.FormEvent) => {
//     e.preventDefault()

//     try {
//       const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/models`, {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/json',
//           'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
//         },
//         body: JSON.stringify(formData)
//       })

//       if (response.ok) {
//         toast.success('Model created successfully')
//         setIsDialogOpen(false)
//         setFormData({ name: '', displayName: '', provider: '', description: '', apiKey: '' })
//         loadModels()
//       } else {
//         const error = await response.json()
//         toast.error(error.error || 'Failed to create model')
//       }
//     } catch (error) {
//       console.error('Failed to create model:', error)
//       toast.error('Failed to create model')
//     }
//   }

//   const toggleModelStatus = async (modelId: string, currentStatus: boolean) => {
//     try {
//       const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/models/${modelId}`, {
//         method: 'PUT',
//         headers: {
//           'Content-Type': 'application/json',
//           'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
//         },
//         body: JSON.stringify({ isActive: !currentStatus })
//       })

//       if (response.ok) {
//         toast.success('Model status updated')
//         loadModels()
//       } else {
//         toast.error('Failed to update model status')
//       }
//     } catch (error) {
//       console.error('Failed to update model:', error)
//       toast.error('Failed to update model')
//     }
//   }

//   const deleteModel = async (modelId: string) => {
//     if (!confirm('Are you sure you want to delete this model?')) return

//     try {
//       const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/models/${modelId}`, {
//         method: 'DELETE',
//         headers: {
//           'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
//         }
//       })

//       if (response.ok) {
//         toast.success('Model deleted successfully')
//         loadModels()
//       } else {
//         toast.error('Failed to delete model')
//       }
//     } catch (error) {
//       console.error('Failed to delete model:', error)
//       toast.error('Failed to delete model')
//     }
//   }

//   return (
//     <div className="flex-1 space-y-6 p-6">
//       <div className="flex items-center justify-between">
//         <div>
//           <h1 className="text-3xl font-bold">AI Models</h1>
//           <p className="text-muted-foreground">Manage AI models and their configurations</p>
//         </div>
//         <Dialog>
//           <DialogTrigger asChild>
//             <Button onClick={() => setIsDialogOpen(true)}>
//               <Plus className="mr-2 h-4 w-4" />
//               Add Model
//             </Button>
//           </DialogTrigger>
//           <DialogContent open={isDialogOpen} onOpenChange={setIsDialogOpen}>
//             <DialogHeader>
//               <DialogTitle>Add New AI Model</DialogTitle>
//             </DialogHeader>
//             <form onSubmit={handleCreateModel} className="space-y-4">
//               <div className="grid grid-cols-2 gap-4">
//                 <div className="space-y-2">
//                   <Label htmlFor="name">Model Name</Label>
//                   <Input
//                     id="name"
//                     placeholder="e.g., gpt-4"
//                     value={formData.name}
//                     onChange={(e) => setFormData({ ...formData, name: e.target.value })}
//                     required
//                   />
//                 </div>
//                 <div className="space-y-2">
//                   <Label htmlFor="displayName">Display Name</Label>
//                   <Input
//                     id="displayName"
//                     placeholder="e.g., GPT-4"
//                     value={formData.displayName}
//                     onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
//                     required
//                   />
//                 </div>
//               </div>
//               <div className="space-y-2">
//                 <Label htmlFor="provider">Provider</Label>
//                 <Input
//                   id="provider"
//                   placeholder="e.g., OpenAI"
//                   value={formData.provider}
//                   onChange={(e) => setFormData({ ...formData, provider: e.target.value })}
//                   required
//                 />
//               </div>
//               <div className="space-y-2">
//                 <Label htmlFor="description">Description</Label>
//                 <Textarea
//                   id="description"
//                   placeholder="Enter model description"
//                   value={formData.description}
//                   onChange={(e) => setFormData({ ...formData, description: e.target.value })}
//                 />
//               </div>
//               <div className="space-y-2">
//                 <Label htmlFor="apiKey">API Key (Optional)</Label>
//                 <Input
//                   id="apiKey"
//                   type="password"
//                   placeholder="Enter API key if required"
//                   value={formData.apiKey}
//                   onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
//                 />
//               </div>
//               <Button type="submit" className="w-full">Add Model</Button>
//             </form>
//           </DialogContent>
//         </Dialog>
//       </div>

//       {/* Model Stats */}
//       <div className="grid gap-4 md:grid-cols-4">
//         <Card>
//           <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
//             <CardTitle className="text-sm font-medium">Total Models</CardTitle>
//             <Bot className="h-4 w-4 text-muted-foreground" />
//           </CardHeader>
//           <CardContent>
//             <div className="text-2xl font-bold">{models.length}</div>
//           </CardContent>
//         </Card>
//         <Card>
//           <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
//             <CardTitle className="text-sm font-medium">Active Models</CardTitle>
//             <Bot className="h-4 w-4 text-muted-foreground" />
//           </CardHeader>
//           <CardContent>
//             <div className="text-2xl font-bold">{models.filter((m) => m.isActive).length}</div>
//           </CardContent>
//         </Card>
//         <Card>
//           <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
//             <CardTitle className="text-sm font-medium">Total Usage</CardTitle>
//             <Bot className="h-4 w-4 text-muted-foreground" />
//           </CardHeader>
//           <CardContent>
//             <div className="text-2xl font-bold">-</div>
//           </CardContent>
//         </Card>
//         <Card>
//           <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
//             <CardTitle className="text-sm font-medium">Providers</CardTitle>
//             <Bot className="h-4 w-4 text-muted-foreground" />
//           </CardHeader>
//           <CardContent>
//             <div className="text-2xl font-bold">{new Set(models.map((m) => m.provider)).size}</div>
//           </CardContent>
//         </Card>
//       </div>

//       {/* Models Table */}
//       <Card>
//         <CardHeader>
//           <CardTitle>AI Models</CardTitle>
//           <CardDescription>Configure and manage AI models available on the platform</CardDescription>
//         </CardHeader>
//         <CardContent>
//           <Table>
//             <TableHeader>
//               <TableRow>
//                 <TableHead>Model</TableHead>
//                 <TableHead>Provider</TableHead>
//                 <TableHead>Status</TableHead>
//                 <TableHead>Usage</TableHead>
//                 <TableHead>Cost</TableHead>
//                 <TableHead>Actions</TableHead>
//               </TableRow>
//             </TableHeader>
//             <TableBody>
//               {models.map((model) => (
//                 <TableRow key={model.id}>
//                   <TableCell>
//                     <div>
//                       <div className="font-medium">{model.displayName}</div>
//                       <div className="text-sm text-muted-foreground">{model.description}</div>
//                     </div>
//                   </TableCell>
//                   <TableCell>{model.provider}</TableCell>
//                   <TableCell>
//                     <div className="flex items-center space-x-2">
//                       <Switch
//                         checked={model.isActive}
//                         onCheckedChange={() => toggleModelStatus(model.id, model.isActive)}
//                       />
//                       <Badge variant={model.isActive ? "default" : "secondary"}>
//                         {model.isActive ? "Active" : "Inactive"}
//                       </Badge>
//                     </div>
//                   </TableCell>
//                   <TableCell>-</TableCell>
//                   <TableCell>-</TableCell>
//                   <TableCell>
// <DropdownMenu>
//   <DropdownMenuTrigger asChild>
//     <Button variant="ghost" size="sm">
//       <MoreHorizontal className="h-4 w-4" />
//     </Button>
//   </DropdownMenuTrigger>
//   <DropdownMenuContent>
//     <DropdownMenuItem>
//       <Settings className="mr-2 h-4 w-4" />
//       Configure
//     </DropdownMenuItem>
//     <DropdownMenuItem onClick={() => toggleModelStatus(model.id, model.isActive)}>
//       {model.isActive ? "Deactivate" : "Activate"}
//     </DropdownMenuItem>
//     <DropdownMenuItem>View Analytics</DropdownMenuItem>
//     <DropdownMenuItem
//       className="text-red-600"
//       onClick={() => deleteModel(model.id)}
//     >
//       Remove Model
//     </DropdownMenuItem>
//   </DropdownMenuContent>
// </DropdownMenu>
//                   </TableCell>
//                 </TableRow>
//               ))}
//             </TableBody>
//           </Table>
//         </CardContent>
//       </Card>
//     </div>
//   )
// }



"use client"

import { useState, useEffect } from "react"
import { Bot, Plus, MoreHorizontal, Settings, Type, Image as ImageIconLucide } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { toast } from "sonner"
import { IconProvider } from "@/components/icon-provider" // <-- Naya Icon helper

// Model ki type update karein
interface AIModel {
  id: string
  name: string
  displayName: string
  provider: string
  type: 'TEXT' | 'IMAGE' // <-- Type shamil karein
  icon?: string | null    // <-- Icon shamil karein
  description?: string
  isActive: boolean
}

const initialFormData = {
  name: '',
  displayName: '',
  provider: '',
  type: 'TEXT' as 'TEXT' | 'IMAGE',
  icon: 'Bot',
  description: '',
  apiKey: ''
};

export default function ModelsPage() {
  const [models, setModels] = useState<AIModel[]>([])
  const [providers, setProviders] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [formData, setFormData] = useState(initialFormData);
  const [editingModel, setEditingModel] = useState<AIModel | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);


  useEffect(() => {
    loadInitialData()
  }, [])

  const loadInitialData = async () => {
    setIsLoading(true);
    try {
      const token = localStorage.getItem('auth-token');
      const headers = { 'Authorization': `Bearer ${token}` };

      // Models aur Providers ek sath fetch karein
      const [modelsRes, providersRes] = await Promise.all([
        fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/models`, { headers }),
        fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/providers`, { headers })
      ]);

      if (modelsRes.ok) {
        const data = await modelsRes.json();
        setModels(data.models);
      } else {
        toast.error('Failed to load models');
      }

      if (providersRes.ok) {
        const data = await providersRes.json();
        setProviders(data.providers);
        // Default provider set karein
        if (data.providers.length > 0) {
          setFormData(prev => ({ ...prev, provider: data.providers[0] }));
        }
      } else {
        toast.error('Failed to load providers');
      }

    } catch (error) {
      console.error('Failed to load initial data:', error);
      toast.error('Failed to load data');
    } finally {
      setIsLoading(false);
    }
  }

  const handleCreateModel = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/models`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
        },
        body: JSON.stringify(formData)
      });

      if (response.ok) {
        toast.success('Model created successfully');
        setIsDialogOpen(false);
        setFormData(initialFormData); // Form ko reset karein
        loadInitialData(); // Data reload karein
      } else {
        const error = await response.json();
        toast.error(error.error || 'Failed to create model');
      }
    } catch (error) {
      toast.error('Failed to create model');
    }
  }

  const handleUpdateModel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingModel) return;

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/models/${editingModel.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
        },
        body: JSON.stringify(editingModel)
      });

      if (response.ok) {
        toast.success('Model updated successfully');
        setIsEditDialogOpen(false);
        setEditingModel(null);
        loadInitialData();
      } else {
        const error = await response.json();
        toast.error(error.error || 'Failed to update model');
      }
    } catch (error) {
      toast.error('Failed to update model');
    }
  }

  // ... toggleModelStatus aur deleteModel functions waise hi rahenge ...

  const toggleModelStatus = async (modelId: string, currentStatus: boolean) => {
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/models/${modelId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
        },
        body: JSON.stringify({ isActive: !currentStatus })
      })

      if (response.ok) {
        toast.success('Model status updated')
        loadInitialData()
      } else {
        toast.error('Failed to update model status')
      }
    } catch (error) {
      console.error('Failed to update model:', error)
      toast.error('Failed to update model')
    }
  }

  const deleteModel = async (modelId: string) => {
    if (!confirm('Are you sure you want to delete this model?')) return

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/models/${modelId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
        }
      })

      if (response.ok) {
        toast.success('Model deleted successfully')
        loadInitialData()
      } else {
        toast.error('Failed to delete model')
      }
    } catch (error) {
      console.error('Failed to delete model:', error)
      toast.error('Failed to delete model')
    }
  }

  return (
    <div className="flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">AI Models Management</h1>
          <p className="text-muted-foreground">Configure AI models for your platform</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="mr-2 h-4 w-4" /> Add Model</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add New AI Model</DialogTitle></DialogHeader>
            <form onSubmit={handleCreateModel} className="space-y-4">
              {/* Form Content */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Model Name (e.g., gpt-4o)</Label>
                  <Input id="name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="displayName">Display Name (e.g., GPT-4 Omni)</Label>
                  <Input id="displayName" value={formData.displayName} onChange={(e) => setFormData({ ...formData, displayName: e.target.value })} required />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="provider">Provider</Label>
                <Select value={formData.provider} onValueChange={(value) => setFormData({ ...formData, provider: value })}>
                  <SelectTrigger><SelectValue placeholder="Select a provider" /></SelectTrigger>
                  <SelectContent>
                    {providers.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Model Type</Label>
                <RadioGroup defaultValue="TEXT" value={formData.type} onValueChange={(value) => setFormData({ ...formData, type: value as 'TEXT' | 'IMAGE' })}>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="TEXT" id="r-text" />
                    <Label htmlFor="r-text" className="flex items-center gap-2"><Type className="h-4 w-4" /> Text Generation</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="IMAGE" id="r-image" />
                    <Label htmlFor="r-image" className="flex items-center gap-2"><ImageIconLucide className="h-4 w-4" /> Image Generation</Label>
                  </div>
                </RadioGroup>
              </div>

              <div className="space-y-2">
                <Label htmlFor="icon">Icon Name (from Lucide)</Label>
                <Input id="icon" value={formData.icon} onChange={(e) => setFormData({ ...formData, icon: e.target.value })} placeholder="e.g., Bot, Sparkles, ImageIcon" />
                <p className="text-xs text-muted-foreground">Enter a valid name from lucide-react icons.</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea id="description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} />
              </div>

              <Button type="submit" className="w-full">Add Model</Button>
            </form>
          </DialogContent>
        </Dialog>

        {/* Edit Model Dialog */}
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Edit {editingModel?.displayName}</DialogTitle></DialogHeader>
            {editingModel && (
              <form onSubmit={handleUpdateModel} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-name">Model Name</Label>
                    <Input id="edit-name" value={editingModel.name} onChange={(e) => setEditingModel({ ...editingModel, name: e.target.value })} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-displayName">Display Name</Label>
                    <Input id="edit-displayName" value={editingModel.displayName} onChange={(e) => setEditingModel({ ...editingModel, displayName: e.target.value })} required />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-provider">Provider</Label>
                  <Select value={editingModel.provider} onValueChange={(value) => setEditingModel({ ...editingModel, provider: value })}>
                    <SelectTrigger><SelectValue placeholder="Select a provider" /></SelectTrigger>
                    <SelectContent>
                      {providers.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Model Type</Label>
                  <RadioGroup value={editingModel.type} onValueChange={(value) => setEditingModel({ ...editingModel, type: value as 'TEXT' | 'IMAGE' })}>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="TEXT" id="edit-r-text" />
                      <Label htmlFor="edit-r-text" className="flex items-center gap-2"><Type className="h-4 w-4" /> Text Generation</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="IMAGE" id="edit-r-image" />
                      <Label htmlFor="edit-r-image" className="flex items-center gap-2"><ImageIconLucide className="h-4 w-4" /> Image Generation</Label>
                    </div>
                  </RadioGroup>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-icon">Icon Name</Label>
                  <Input id="edit-icon" value={editingModel.icon || ''} onChange={(e) => setEditingModel({ ...editingModel, icon: e.target.value })} placeholder="e.g., Bot, Sparkles" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-description">Description</Label>
                  <Textarea id="edit-description" value={editingModel.description || ''} onChange={(e) => setEditingModel({ ...editingModel, description: e.target.value })} />
                </div>
                <Button type="submit" className="w-full">Save Changes</Button>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* Models Table */}
      <Card>
        <CardHeader><CardTitle>Configured Models</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model) => (
                <TableRow key={model.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <IconProvider name={model.icon} className="h-5 w-5" />
                      <div>
                        <div className="font-medium">{model.displayName}</div>
                        <div className="text-sm text-muted-foreground">{model.name}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell><Badge variant="outline">{model.provider}</Badge></TableCell>
                  <TableCell>
                    <Badge variant={model.type === 'IMAGE' ? 'default' : 'secondary'}>
                      {model.type}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Switch checked={model.isActive} /* onCheckedChange logic */ />
                  </TableCell>
                  <TableCell>
                    {/* Actions Dropdown */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onSelect={() => { setEditingModel(model); setIsEditDialogOpen(true); }}>
                          <Settings className="mr-2 h-4 w-4" />
                          Edit Model
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toggleModelStatus(model.id, model.isActive)}>
                          {model.isActive ? "Deactivate" : "Activate"}
                        </DropdownMenuItem>
                        <DropdownMenuItem>View Analytics</DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => deleteModel(model.id)}
                        >
                          Remove Model
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>

                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
