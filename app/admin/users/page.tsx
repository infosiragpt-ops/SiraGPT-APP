"use client"

import { useEffect, useMemo, useState } from "react"
import { Search, MoreHorizontal, UserPlus, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AdminPageHeader, AdminPageBody } from "@/components/admin/admin-chrome"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { apiClient } from "@/lib/api"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"

// Minimal local type to represent user rows returned by API
type UserRow = {
  id: string
  name: string
  email: string
  plan?: string
  isAdmin?: boolean
  apiUsage?: number
  monthlyLimit?: number
  createdAt?: string
}

type FormErrors = {
  name?: string
  email?: string
  password?: string
  plan?: string
  monthlyLimit?: string
  general?: string
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // UI state
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedPlan, setSelectedPlan] = useState<string>("All")
  const [page, setPage] = useState<number>(1)
  const [limit] = useState<number>(20) // page size

  // Pagination meta returned from API
  const [totalPages, setTotalPages] = useState<number>(1)
  const [totalCount, setTotalCount] = useState<number>(0)

  // Modals
  const [showAddModal, setShowAddModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingUser, setEditingUser] = useState<UserRow | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  // Delete confirmation (replace browser confirm)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name?: string } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Form state for add/edit
  const initialForm = { name: "", email: "", password: "", plan: "FREE", isAdmin: false, monthlyLimit: 0 }
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    plan: "FREE",
    isAdmin: false,
    monthlyLimit: 0,
  })

  // Per-form field errors (inline)
  const [addFormErrors, setAddFormErrors] = useState<FormErrors>({})
  const [editFormErrors, setEditFormErrors] = useState<FormErrors>({})
  const [isExporting, setIsExporting] = useState(false)

  // Load users from API
  // NOTE: this now returns the API response so callers can inspect the returned users immediately
  const loadUsers = async (opts?: { page?: number; search?: string; plan?: string }) => {
    setLoading(true)
    setError(null)
    try {
      const res: any = await apiClient.getUsers({
        page: opts?.page ?? page,
        limit,
        search: opts?.search ?? searchTerm,
        plan: opts?.plan && opts.plan !== "All" ? opts.plan : "",
      })

      // api returns { users, pagination }
      setUsers(res?.users ?? [])
      if (res?.pagination) {
        setPage(res.pagination.page || 1)
        setTotalPages(res.pagination.pages || 1)
        setTotalCount(res.pagination.total || 0)
      } else {
        setTotalPages(1)
        setTotalCount((res?.users ?? []).length)
      }

      return res
    } catch (err: any) {
      console.error("Failed to load users", err)
      setError(err?.message || "No se pudieron cargar los usuarios")
      toast.error(err?.message || "No se pudieron cargar los usuarios")
      return null
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // initial load
    loadUsers({ page: 1 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // debounce/submit search/filter
  useEffect(() => {
    const t = setTimeout(() => {
      loadUsers({ page: 1, search: searchTerm, plan: selectedPlan })
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, selectedPlan])

  const openAddModal = () => {
    setForm(initialForm)
    setAddFormErrors({})
    setShowAddModal(true)
  }

  const openEditModal = (u: UserRow) => {
    setEditingUser(u)
    setForm({
      name: u.name || "",
      email: u.email || "",
      password: "",
      plan: u.plan || "FREE",
      isAdmin: !!u.isAdmin,
      monthlyLimit: u.monthlyLimit ?? 0,
    })
    setEditFormErrors({})
    setTimeout(() => setShowEditModal(true), 0)
  }

  // 2) Replace your existing handleAddUser function with this improved version:

  const handleAddUser = async () => {
    // clear previous errors
    setAddFormErrors({})

    // basic client-side validation
    const errs: FormErrors = {}
    if (!form.name) errs.name = "Name is required"
    if (!form.email) errs.email = "Email is required"
    if (!form.password) errs.password = "Password is required"
    else if (String(form.password).length < 6) errs.password = "Password must be at least 6 characters"

    if (Object.keys(errs).length) {
      setAddFormErrors(errs)
      toast.error("Please fix the highlighted fields")
      return
    }

    setIsSaving(true)
    try {
      const payload = {
        name: form.name,
        email: form.email,
        password: form.password,
        plan: form.plan,
        isAdmin: !!form.isAdmin,
        monthlyLimit: Number(form.monthlyLimit ?? 0),
      }

      const res = await apiClient.createUserAdmin(payload)

      if (res && res.user) {
        toast.success("User created")
        setShowAddModal(false)
        setAddFormErrors({})
        await loadUsers({ page: 1 })
        setIsSaving(false)
        return
      }

      // fallback success-ish behavior
      toast.success("User registered (fallback). Refreshing list...")
      setShowAddModal(false)
      setAddFormErrors({})
      await loadUsers({ page: 1 })
    } catch (err: any) {
      console.error("Add user error", err)

      // Try to extract server validation errors robustly
      const serverErrors = extractServerErrors(err)
      if (serverErrors) {
        const mapped = mapValidationErrors(serverErrors)
        setAddFormErrors(mapped)
        // keep modal open for fixes
        toast.error("Validation error — please fix the highlighted fields")
      } else if (err?.details && (err.details.error || err.details.message)) {
        const msg = err.details.error || err.details.message
        setAddFormErrors({ general: msg })
        toast.error(msg)
      } else if (err?.error) {
        setAddFormErrors({ general: err.error })
        toast.error(err.error)
      } else {
        const msg = err?.message || "No se pudo crear el usuario"
        setAddFormErrors({ general: msg })
        toast.error(msg)
      }
    } finally {
      setIsSaving(false)
    }
  }

  // 3) Replace your existing handleEditUser with this version (supports optional password and inline errors):

  const handleEditUser = async () => {
    if (!editingUser) return

    // clear previous errors
    setEditFormErrors({})

    // client-side checks: if admin entered a password ensure min length, otherwise skip
    if (form.password && String(form.password).length > 0 && String(form.password).length < 6) {
      setEditFormErrors({ password: "Password must be at least 6 characters" })
      toast.error("Please fix the highlighted fields")
      return
    }

    setIsSaving(true)
    try {
      // Build payload only with fields that changed to avoid accidental overwrites
      const payload: any = {}
      if (String(form.name ?? "") !== String(editingUser.name ?? "")) {
        payload.name = form.name
      }

      if (String(form.plan ?? "") !== String(editingUser.plan ?? "")) {
        payload.plan = form.plan
      }

      if (Boolean(form.isAdmin) !== Boolean(editingUser.isAdmin)) {
        payload.isAdmin = form.isAdmin
      }

      // monthlyLimit — allow 0 and only send if it's different
      const currentMl = Number(editingUser.monthlyLimit ?? 0)
      const newMl = Number(form.monthlyLimit ?? 0)
      if (!Number.isNaN(newMl) && newMl !== currentMl) {
        payload.monthlyLimit = newMl
      }

      // include password only when admin typed one (for reset)
      if (form.password && String(form.password).length >= 6) {
        payload.password = form.password
      }

      if (Object.keys(payload).length === 0) {
        toast.info("No changes to save")
        setIsSaving(false)
        setShowEditModal(false)
        setEditingUser(null)
        return
      }

      await apiClient.updateUser(editingUser.id, payload)

      toast.success("User updated")
      setShowEditModal(false)
      setEditingUser(null)
      setEditFormErrors({})
      await loadUsers({ page })
    } catch (err: any) {
      console.error("Update user error", err)

      const serverErrors = extractServerErrors(err)
      if (serverErrors) {
        const mapped = mapValidationErrors(serverErrors)
        setEditFormErrors(mapped)
        toast.error("Validation error — please fix the highlighted fields")
      } else if (err?.details && (err.details.error || err.details.message)) {
        const msg = err.details.error || err.details.message
        setEditFormErrors({ general: msg })
        toast.error(msg)
      } else if (err?.error) {
        setEditFormErrors({ general: err.error })
        toast.error(err.error)
      } else {
        toast.error(err?.message || "No se pudo actualizar el usuario")
      }
    } finally {
      setIsSaving(false)
    }
  }

  // Start deletion flow by showing confirmation dialog
  const confirmDeleteUser = (id: string, name?: string) => {
    setDeleteTarget({ id, name })
  }

  const performDeleteUser = async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      await apiClient.deleteUser(deleteTarget.id)
      toast.success("User deleted")
      setDeleteTarget(null)
      // reload (keep same page)
      await loadUsers({ page })
    } catch (err: any) {
      console.error("Delete user error", err)
      toast.error(err?.message || "No se pudo eliminar el usuario")
    } finally {
      setIsDeleting(false)
    }
  }

  const plans = useMemo(() => ["All", "FREE", "PRO", "PRO_MAX", "ENTERPRISE"], [])

  const handleExport = async () => {
    setIsExporting(true)
    try {
      const data = await apiClient.exportUsersCsv()

      // Create a Blob from the CSV data
      const blob = new Blob([data], { type: "text/csv;charset=utf-8;" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.setAttribute("href", url)
      link.setAttribute("download", "user-emails.csv")
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      toast.success("Emails exported successfully")
    } catch (err: any) {
      console.error("Export error", err)
      toast.error(err?.message || "No se pudieron exportar los correos")
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <>
      <AdminPageHeader
        title="Usuarios"
        description="Gestiona usuarios y permisos de la plataforma"
        actions={
          <>
            <Button onClick={openAddModal} size="sm" className="h-8 text-[13px]">
              <UserPlus className="mr-1.5 h-3.5 w-3.5" />
              Agregar
            </Button>
            <Button onClick={handleExport} size="sm" variant="outline" className="h-8 text-[13px]" disabled={isExporting}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {isExporting ? "Exportando…" : "Exportar"}
            </Button>
          </>
        }
      />
      <AdminPageBody className="space-y-3">

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar usuarios…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8 text-sm"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <Label className="text-sm">Plan</Label>
              <Select value={selectedPlan} onValueChange={(v) => setSelectedPlan(v)}>
                <SelectTrigger className="w-32 sm:w-40 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p === "All" ? "Todos los planes" : p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Users Table */}
      <Card>
        <CardHeader>
          <CardTitle>Usuarios ({totalCount})</CardTitle>
          <CardDescription>Usuarios registrados en la plataforma</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-8 text-center">Cargando usuarios…</div>
          ) : error ? (
            <div className="py-8 text-center text-red-600">Error: {error}</div>
          ) : (
            <>
              {/* Desktop/tablet table; phones get the card list below. */}
              <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Usuario</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Uso</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Alta</TableHead>
                    <TableHead>Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div>
                          <div className="font-medium">{user.name}</div>
                          <div className="text-sm text-muted-foreground">{user.email}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={user.plan === "ENTERPRISE" ? "default" : (user.plan === "PRO" || user.plan === "PRO_MAX") ? "secondary" : "outline"}
                        >
                          {user.plan || "FREE"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          {(user.apiUsage ?? 0).toLocaleString()} / {(user.monthlyLimit ?? 0).toLocaleString()}
                        </div>
                        <div className="w-full bg-muted rounded-full h-1 mt-1">
                          <div
                            className="bg-primary h-1 rounded-full"
                            style={{
                              width: `${Math.min(((user.apiUsage || 0) / (user.monthlyLimit || 1)) * 100, 100)}%`,
                            }}
                          />
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="default">{user.isAdmin ? "Admin" : "Activo"}</Badge>
                      </TableCell>
                      <TableCell>{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "N/A"}</TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            <DropdownMenuItem onClick={() => openEditModal(user)}>Editar</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => confirmDeleteUser(user.id, user.name)} className="text-red-600">
                              Eliminar
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>

              {/* Mobile card list */}
              <div className="space-y-2 md:hidden">
                {users.map((user) => (
                  <div key={user.id} className="rounded-lg border bg-card p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{user.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{user.email}</div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEditModal(user)}>Editar</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => confirmDeleteUser(user.id, user.name)} className="text-red-600">
                            Eliminar
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge variant={user.plan === "ENTERPRISE" ? "default" : (user.plan === "PRO" || user.plan === "PRO_MAX") ? "secondary" : "outline"}>
                        {user.plan || "FREE"}
                      </Badge>
                      <Badge variant="default">{user.isAdmin ? "Admin" : "Activo"}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "N/A"}
                      </span>
                    </div>
                    <div className="mt-2">
                      <div className="text-xs text-muted-foreground">
                        {(user.apiUsage ?? 0).toLocaleString()} / {(user.monthlyLimit ?? 0).toLocaleString()}
                      </div>
                      <div className="mt-1 h-1 w-full rounded-full bg-muted">
                        <div
                          className="h-1 rounded-full bg-primary"
                          style={{ width: `${Math.min(((user.apiUsage || 0) / (user.monthlyLimit || 1)) * 100, 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Simple pagination controls */}
              <div className="mt-4 flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  Página {page} de {totalPages} · {totalCount} usuarios
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => { if (page > 1) { setPage(page - 1); loadUsers({ page: page - 1 }) } }} disabled={page <= 1}>
                    Anterior
                  </Button>
                  <Button onClick={() => { if (page < totalPages) { setPage(page + 1); loadUsers({ page: page + 1 }) } }} disabled={page >= totalPages}>
                    Siguiente
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Add User Modal */}
      <Dialog
        open={showAddModal}
        onOpenChange={(open) => {
          // clear errors when the modal is closed
          if (!open) setAddFormErrors({})
          setShowAddModal(open)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create User</DialogTitle>
            <CardDescription>Fill in the details below to add a new user.</CardDescription>
          </DialogHeader>

          {/* Use a form so Enter submits naturally */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleAddUser()
            }}
            className="space-y-6 mt-4"
          >
            {/* Basic Info */}
            <div className="space-y-4">
              <div>
                <Label>Name</Label>
                <Input
                  autoFocus
                  aria-invalid={!!addFormErrors.name}
                  className={addFormErrors.name ? "border-red-600" : ""}
                  placeholder="John Doe"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
                {addFormErrors.name && <p className="text-sm text-red-600 mt-1">{addFormErrors.name}</p>}
              </div>

              <div>
                <Label>Email</Label>
                <Input
                  type="email"
                  aria-invalid={!!addFormErrors.email}
                  className={addFormErrors.email ? "border-red-600" : ""}
                  placeholder="john@example.com"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
                {addFormErrors.email && <p className="text-sm text-red-600 mt-1">{addFormErrors.email}</p>}
              </div>

              <div>
                <Label>Password</Label>
                <Input
                  type="password"
                  aria-invalid={!!addFormErrors.password}
                  className={addFormErrors.password ? "border-red-600" : ""}
                  placeholder="••••••••"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
                {addFormErrors.password ? (
                  <p className="text-sm text-red-600 mt-1">{addFormErrors.password}</p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-1">Min 6 characters.</p>
                )}
              </div>
            </div>

            <hr />

            {/* Permissions */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Plan</Label>
                <Select value={form.plan} onValueChange={(v) => setForm({ ...form, plan: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a plan" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FREE">Free</SelectItem>
                    <SelectItem value="PRO">Pro</SelectItem>
                    <SelectItem value="PRO_MAX">Pro Max</SelectItem>
                    <SelectItem value="ENTERPRISE">Enterprise</SelectItem>
                  </SelectContent>
                </Select>
                {addFormErrors.plan && <p className="text-sm text-red-600 mt-1">{addFormErrors.plan}</p>}
              </div>

              <div>
                <Label>Monthly Limit</Label>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  aria-invalid={!!addFormErrors.monthlyLimit}
                  className={addFormErrors.monthlyLimit ? "border-red-600" : ""}
                  placeholder="1000"
                  value={String(form.monthlyLimit ?? 0)}
                  onChange={(e) => setForm({ ...form, monthlyLimit: parseMonthlyLimit(e.target.value) })}
                />
                {addFormErrors.monthlyLimit ? (
                  <p className="text-sm text-red-600 mt-1">{addFormErrors.monthlyLimit}</p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-1">Number of credits per month.</p>
                )}
              </div>
            </div>

            {/* Admin toggle */}
            <div className="flex items-center gap-3 bg-muted/30 p-3 rounded-lg">
              <Checkbox id="isAdmin" checked={form.isAdmin} onCheckedChange={(v) => setForm({ ...form, isAdmin: !!v })} />
              <Label htmlFor="isAdmin">Grant Admin Access</Label>
            </div>

            {/* General/server error */}
            {addFormErrors.general && <div className="text-sm text-red-600">{addFormErrors.general}</div>}

            <DialogFooter className="mt-2">
              <div className="flex gap-2 w-full justify-end">
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => {
                    setShowAddModal(false)
                    setAddFormErrors({})
                  }}
                  disabled={isSaving}
                >
                  Cancelar
                </Button>

                <Button type="submit" disabled={isSaving}>
                  {isSaving ? "Saving..." : "Create User"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Editar Modal */}

      <Dialog
        open={showEditModal}
        onOpenChange={(open) => {
          if (!open) {
            setEditingUser(null)
            setEditFormErrors({})
            // keep form password cleared when closing
            setForm(f => ({ ...f, password: "" }))

          }
          setShowEditModal(open)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Editar</DialogTitle>
            <CardDescription>Update user details.</CardDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleEditUser()
            }}
            className="space-y-6 mt-4"
          >
            <div className="space-y-4">
              <div>
                <Label>Name</Label>
                <Input
                  className={editFormErrors.name ? "border-red-600" : ""}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
                {editFormErrors.name && <p className="text-sm text-red-600 mt-1">{editFormErrors.name}</p>}
              </div>

              <div>
                <Label>Email</Label>
                <Input
                  className={editFormErrors.email ? "border-red-600" : ""}
                  value={form.email}
                  disabled
                />
                {editFormErrors.email && <p className="text-sm text-red-600 mt-1">{editFormErrors.email}</p>}
              </div>

            </div>


            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Plan</Label>
                <Select value={form.plan} onValueChange={(v) => setForm({ ...form, plan: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FREE">FREE</SelectItem>
                    <SelectItem value="PRO">PRO</SelectItem>
                    <SelectItem value="PRO_MAX">PRO MAX</SelectItem>
                    <SelectItem value="ENTERPRISE">ENTERPRISE</SelectItem>
                  </SelectContent>
                </Select>
                {editFormErrors.plan && <p className="text-sm text-red-600 mt-1">{editFormErrors.plan}</p>}
              </div>

              <div>
                <Label>Monthly limit</Label>
                <Input
                  className={editFormErrors.monthlyLimit ? "border-red-600" : ""}
                  type="number"
                  min={0}
                  step={1}
                  value={form.monthlyLimit === null ? "" : String(form.monthlyLimit)}
                  onChange={(e) => setForm({ ...form, monthlyLimit: parseMonthlyLimit(e.target.value) })}
                />
                {editFormErrors.monthlyLimit && <p className="text-sm text-red-600 mt-1">{editFormErrors.monthlyLimit}</p>}
              </div>
            </div>
            {/* Grant admin access (same UI as Add modal) */}
            <div className="flex items-center gap-3 bg-muted/30 p-3 rounded-lg">
              <Checkbox
                id="isAdminEdit"
                checked={form.isAdmin}
                onCheckedChange={(v) => setForm({ ...form, isAdmin: !!v })}
              />
              <Label htmlFor="isAdminEdit">Acceso de administrador</Label>
            </div>
            {editFormErrors.general && <div className="text-sm text-red-600 mt-1">{editFormErrors.general}</div>}

            <DialogFooter className="mt-2">
              <div className="flex gap-2 w-full justify-end">
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => {
                    setShowEditModal(false)
                    setEditFormErrors({})
                  }}
                  disabled={isSaving}
                >
                  Cancelar
                </Button>
                <Button type="submit" disabled={isSaving}>
                  {isSaving ? "Guardando…" : "Guardar"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {/* Delete confirmation dialog (replaces browser confirm) */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eliminar usuario</DialogTitle>
          </DialogHeader>

          <div className="py-4">
            ¿Eliminar a{" "}
            <strong>{deleteTarget?.name ?? "este usuario"}</strong>? Esta acción no se puede deshacer.
          </div>

          <DialogFooter>
            <div className="flex gap-2 w-full justify-end">
              <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={isDeleting}>Cancelar</Button>
              <Button className="bg-red-600 hover:bg-red-700" onClick={performDeleteUser} disabled={isDeleting}>
                {isDeleting ? "Eliminando…" : "Eliminar"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </AdminPageBody>
    </>
  )
}

// Add this helper near the top of the file (after your initialForm / setForm declarations)
function parseMonthlyLimit(value: string | number) {
  // Keep empty input possible during edit, but convert to number for state.
  if (value === "" || value === null || value === undefined) return 0
  const n = typeof value === "string" ? parseInt(value, 10) : Number(value)
  return Number.isNaN(n) ? 0 : n
}

// Map express-validator / backend style errors array to a field:error map
function mapValidationErrors(errorsArray: any[]): FormErrors {
  const out: FormErrors = {}
  for (const e of errorsArray) {
    // Support either { path, msg } or { param, msg }
    const key = (e.path || e.param || "").toString()
    if (!key) continue
    out[key as keyof FormErrors] = e.msg || String(e.message || "Invalid")
  }
  return out
}
// 1) Helper - add somewhere near the top (after mapValidationErrors or before the handlers)
function extractServerErrors(err: any): any[] | null {
  // Look for common places server validation arrays may live
  if (!err) return null
  if (Array.isArray(err)) return err
  if (Array.isArray(err.errors)) return err.errors
  if (err?.details && Array.isArray(err.details.errors)) return err.details.errors
  if (err?.response?.data && Array.isArray(err.response.data.errors)) return err.response.data.errors
  if (err?.data && Array.isArray(err.data.errors)) return err.data.errors

  // Sometimes the API client attached parsed JSON on `.details` or `.response`
  try {
    // If message contains JSON, try to parse and find errors
    if (typeof err.message === "string" && err.message.trim().startsWith("{")) {
      const parsed = JSON.parse(err.message)
      if (parsed && Array.isArray(parsed.errors)) return parsed.errors
    }
  } catch (e) {
    // ignore parse error
  }

  return null
}