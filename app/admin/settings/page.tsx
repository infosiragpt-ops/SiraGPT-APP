"use client"

// Persisted via GET/PUT /api/admin/settings (system_settings blob).
// The old Save button was setTimeout + alert() — nothing ever persisted.
// Maintenance mode keeps its dedicated super-admin endpoint by design.

import { useCallback, useEffect, useState } from "react"
import { Save, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { toast } from "sonner"

type PageSettings = {
  siteName: string
  siteDescription: string
  adminEmail: string
  supportEmail: string
  maxUsersPerPlan: { free: number; pro: number; enterprise: number }
  enableRegistration: boolean
  enableEmailVerification: boolean
  enableMaintenanceMode: boolean
  defaultUserPlan: string
  sessionTimeout: number
  maxFileSize: number
}

const EMPTY_SETTINGS: PageSettings = {
  siteName: "",
  siteDescription: "",
  adminEmail: "",
  supportEmail: "",
  maxUsersPerPlan: { free: 0, pro: 0, enterprise: 0 },
  enableRegistration: true,
  enableEmailVerification: true,
  enableMaintenanceMode: false,
  defaultUserPlan: "free",
  sessionTimeout: 30,
  maxFileSize: 100,
}

async function adminFetch(path: string, init?: RequestInit): Promise<any> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem("auth-token") : null
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
    credentials: "include",
  })
  if (!res.ok) {
    const err: any = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

// Server blob (FREE/PRO/… + *Minutes/*Mb) ↔ page shape (lowercase keys).
function serverToPage(server: any, maintenanceEnabled: boolean): PageSettings {
  const s = server || {}
  const caps = s.maxUsersPerPlan || {}
  return {
    siteName: s.siteName ?? "",
    siteDescription: s.siteDescription ?? "",
    adminEmail: s.adminEmail ?? "",
    supportEmail: s.supportEmail ?? "",
    maxUsersPerPlan: {
      free: caps.FREE ?? 0,
      pro: caps.PRO ?? 0,
      enterprise: caps.ENTERPRISE ?? 0,
    },
    enableRegistration: Boolean(s.enableRegistration),
    enableEmailVerification: Boolean(s.enableEmailVerification),
    enableMaintenanceMode: maintenanceEnabled,
    defaultUserPlan: String(s.defaultUserPlan || "FREE").toLowerCase(),
    sessionTimeout: s.sessionTimeoutMinutes ?? 30,
    maxFileSize: s.maxFileSizeMb ?? 100,
  }
}

function pageToServer(page: PageSettings) {
  return {
    siteName: page.siteName,
    siteDescription: page.siteDescription,
    adminEmail: page.adminEmail,
    supportEmail: page.supportEmail,
    enableRegistration: page.enableRegistration,
    enableEmailVerification: page.enableEmailVerification,
    defaultUserPlan: page.defaultUserPlan.toUpperCase(),
    sessionTimeoutMinutes: page.sessionTimeout,
    maxFileSizeMb: page.maxFileSize,
    maxUsersPerPlan: {
      FREE: page.maxUsersPerPlan.free,
      PRO: page.maxUsersPerPlan.pro,
      ENTERPRISE: page.maxUsersPerPlan.enterprise,
    },
  }
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<PageSettings>(EMPTY_SETTINGS)
  const [loadedMaintenance, setLoadedMaintenance] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      const data = await adminFetch("/api/admin/settings")
      const maintenanceEnabled = Boolean(data?.maintenance?.enabled)
      setSettings(serverToPage(data?.settings, maintenanceEnabled))
      setLoadedMaintenance(maintenanceEnabled)
    } catch {
      toast.error("No se pudieron cargar los ajustes")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const data = await adminFetch("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ settings: pageToServer(settings) }),
      })
      // Maintenance mode lives behind its dedicated super-admin endpoint.
      if (settings.enableMaintenanceMode !== loadedMaintenance) {
        try {
          await adminFetch("/api/admin/maintenance/mode", {
            method: "POST",
            body: JSON.stringify({ enabled: settings.enableMaintenanceMode }),
          })
          setLoadedMaintenance(settings.enableMaintenanceMode)
        } catch (err: any) {
          if (err?.status === 403) {
            toast.error("El modo mantenimiento requiere super-admin")
          } else {
            toast.error("No se pudo cambiar el modo mantenimiento")
          }
          setSettings((prev) => ({ ...prev, enableMaintenanceMode: loadedMaintenance }))
        }
      }
      setSettings((prev) => ({ ...serverToPage(data?.settings, prev.enableMaintenanceMode) }))
      toast.success("Ajustes guardados")
    } catch {
      toast.error("No se pudieron guardar los ajustes")
    } finally {
      setIsSaving(false)
    }
  }

  const updateSetting = (key: string, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div className="flex-1 space-y-4 sm:space-y-6 p-3 sm:p-4 lg:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 sm:gap-3">
            <SidebarTrigger className="md:hidden" />
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold">System Settings</h1>
              <p className="text-muted-foreground text-sm sm:text-base mt-1">Configure platform settings and preferences</p>
            </div>
          </div>
        </div>
        <Button onClick={handleSave} disabled={isSaving || isLoading} size="sm" className="flex-shrink-0 text-sm">
          {isSaving ? <ThinkingIndicator size="sm" className="mr-2" /> : <Save className="mr-2 h-3 w-3 sm:h-4 sm:w-4" />}
          <span className="hidden sm:inline">{isSaving ? "Saving..." : "Save Changes"}</span>
          <span className="sm:hidden">Save</span>
        </Button>
      </div>

      <Tabs defaultValue="general" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-5 text-xs sm:text-sm">
          <TabsTrigger value="general" className="text-xs sm:text-sm">General</TabsTrigger>
          <TabsTrigger value="users" className="text-xs sm:text-sm">Users</TabsTrigger>
          <TabsTrigger value="email" className="text-xs sm:text-sm">Email</TabsTrigger>
          <TabsTrigger value="security" className="text-xs sm:text-sm">Security</TabsTrigger>
          <TabsTrigger value="limits" className="text-xs sm:text-sm">Limits</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>General Settings</CardTitle>
              <CardDescription>Basic platform configuration</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="site-name">Site Name</Label>
                <Input
                  id="site-name"
                  value={settings.siteName}
                  onChange={(e) => updateSetting("siteName", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="site-description">Site Description</Label>
                <Textarea
                  id="site-description"
                  value={settings.siteDescription}
                  onChange={(e) => updateSetting("siteDescription", e.target.value)}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Maintenance Mode</Label>
                  <div className="text-sm text-muted-foreground">
                    Enable to temporarily disable access to the platform
                  </div>
                </div>
                <Switch
                  checked={settings.enableMaintenanceMode}
                  onCheckedChange={(checked) => updateSetting("enableMaintenanceMode", checked)}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>User Settings</CardTitle>
              <CardDescription>Configure user registration and defaults</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Enable Registration</Label>
                  <div className="text-sm text-muted-foreground">Allow new users to register accounts</div>
                </div>
                <Switch
                  checked={settings.enableRegistration}
                  onCheckedChange={(checked) => updateSetting("enableRegistration", checked)}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Email Verification</Label>
                  <div className="text-sm text-muted-foreground">Require email verification for new accounts</div>
                </div>
                <Switch
                  checked={settings.enableEmailVerification}
                  onCheckedChange={(checked) => updateSetting("enableEmailVerification", checked)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="default-plan">Default User Plan</Label>
                <Select
                  value={settings.defaultUserPlan}
                  onValueChange={(value) => updateSetting("defaultUserPlan", value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="free">Free</SelectItem>
                    <SelectItem value="pro">Pro</SelectItem>
                    <SelectItem value="enterprise">Enterprise</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="email" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Email Configuration</CardTitle>
              <CardDescription>Configure email settings and notifications</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="admin-email">Admin Email</Label>
                <Input
                  id="admin-email"
                  type="email"
                  value={settings.adminEmail}
                  onChange={(e) => updateSetting("adminEmail", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="support-email">Support Email</Label>
                <Input
                  id="support-email"
                  type="email"
                  value={settings.supportEmail}
                  onChange={(e) => updateSetting("supportEmail", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="smtp-host">SMTP Host</Label>
                <Input id="smtp-host" placeholder="smtp.gmail.com" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="smtp-port">SMTP Port</Label>
                  <Input id="smtp-port" placeholder="587" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="smtp-user">SMTP Username</Label>
                  <Input id="smtp-user" placeholder="your-email@gmail.com" />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Security Settings</CardTitle>
              <CardDescription>Configure security and session settings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="session-timeout">Session Timeout (minutes)</Label>
                <Input
                  id="session-timeout"
                  type="number"
                  value={settings.sessionTimeout}
                  onChange={(e) => updateSetting("sessionTimeout", Number.parseInt(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="jwt-secret">JWT Secret Key</Label>
                <Input id="jwt-secret" type="password" placeholder="Enter JWT secret key" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="encryption-key">Encryption Key</Label>
                <Input id="encryption-key" type="password" placeholder="Enter encryption key" />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="limits" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>System Limits</CardTitle>
              <CardDescription>Configure system limits and quotas</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="max-file-size">Max File Size (MB)</Label>
                <Input
                  id="max-file-size"
                  type="number"
                  value={settings.maxFileSize}
                  onChange={(e) => updateSetting("maxFileSize", Number.parseInt(e.target.value))}
                />
              </div>
              <div className="space-y-4">
                <Label>Max Users Per Plan</Label>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="free-users">Free Plan</Label>
                    <Input
                      id="free-users"
                      type="number"
                      value={settings.maxUsersPerPlan.free}
                      onChange={(e) =>
                        updateSetting("maxUsersPerPlan", {
                          ...settings.maxUsersPerPlan,
                          free: Number.parseInt(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pro-users">Pro Plan</Label>
                    <Input
                      id="pro-users"
                      type="number"
                      value={settings.maxUsersPerPlan.pro}
                      onChange={(e) =>
                        updateSetting("maxUsersPerPlan", {
                          ...settings.maxUsersPerPlan,
                          pro: Number.parseInt(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="enterprise-users">Enterprise Plan</Label>
                    <Input
                      id="enterprise-users"
                      type="number"
                      value={settings.maxUsersPerPlan.enterprise}
                      onChange={(e) =>
                        updateSetting("maxUsersPerPlan", {
                          ...settings.maxUsersPerPlan,
                          enterprise: Number.parseInt(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
