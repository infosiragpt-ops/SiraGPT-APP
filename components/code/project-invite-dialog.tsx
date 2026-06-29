"use client"

import * as React from "react"
import { CheckCircle2, Copy, Loader2, Mail, UserPlus } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  apiClient,
  type OrganizationInvitation,
  type OrganizationSummary,
} from "@/lib/api"
import { useCodeWorkspace } from "@/lib/code-workspace-context"
import { cn } from "@/lib/utils"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const NEW_ORG_ID = "__new_org__"
const INVITE_ROLES = new Set(["OWNER", "ADMIN"])

function canInvite(org: OrganizationSummary) {
  return INVITE_ROLES.has(String(org.role || "").toUpperCase())
}

function defaultTeamName(workspaceName: string) {
  const clean = workspaceName.trim()
  return clean && clean !== "Workspace" ? clean : "Equipo de Sira"
}

function messageForInviteError(error: unknown) {
  const err = error as { message?: string; status?: number; statusCode?: number; errorData?: any }
  const status = err?.status ?? err?.statusCode
  const data = err?.errorData || {}
  if (status === 402) {
    return `El plan ${data.plan || "actual"} ya alcanzó el límite de miembros.`
  }
  if (status === 403) return "Tu rol no permite invitar miembros en ese equipo."
  if (status === 409) return "Ya existe una invitación pendiente para ese correo."
  if (status === 401) return "Inicia sesión de nuevo para invitar miembros."
  return err?.message || "No se pudo crear la invitación."
}

export function ProjectInviteDialog({ open, onOpenChange }: Props) {
  const { activeFolder, workspaceSource } = useCodeWorkspace()
  const workspaceName = activeFolder?.name || workspaceSource.name || "Workspace"
  const [email, setEmail] = React.useState("")
  const [teamName, setTeamName] = React.useState(() => defaultTeamName(workspaceName))
  const [orgs, setOrgs] = React.useState<OrganizationSummary[]>([])
  const [selectedOrgId, setSelectedOrgId] = React.useState(NEW_ORG_ID)
  const [loadingOrgs, setLoadingOrgs] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [invitation, setInvitation] = React.useState<OrganizationInvitation | null>(null)

  const manageableOrgs = React.useMemo(() => orgs.filter(canInvite), [orgs])
  const creatingOrg = selectedOrgId === NEW_ORG_ID || manageableOrgs.length === 0

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setInvitation(null)
    setTeamName(defaultTeamName(workspaceName))

    let cancelled = false
    setLoadingOrgs(true)
    apiClient
      .listMyOrganizations()
      .then((result) => {
        if (cancelled) return
        const items = Array.isArray(result.items) ? result.items : []
        const allowed = items.filter(canInvite)
        setOrgs(items)
        setSelectedOrgId(allowed[0]?.id || NEW_ORG_ID)
      })
      .catch(() => {
        if (!cancelled) {
          setOrgs([])
          setSelectedOrgId(NEW_ORG_ID)
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingOrgs(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, workspaceName])

  const shareText = React.useMemo(() => {
    if (!invitation) return ""
    const workspaceUrl = typeof window !== "undefined" ? window.location.href : ""
    return [
      `Te invité a colaborar en ${workspaceName} dentro de Sira.`,
      `Acceso a Sira: ${invitation.magicLink}`,
      workspaceUrl ? `Workspace: ${workspaceUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  }, [invitation, workspaceName])

  const handleCopy = React.useCallback(async () => {
    if (!shareText) return
    try {
      await navigator.clipboard.writeText(shareText)
      toast.success("Invitación copiada")
    } catch {
      toast.error("No se pudo copiar la invitación")
    }
  }, [shareText])

  const handleSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const normalizedEmail = email.trim().toLowerCase()
      const normalizedTeam = teamName.trim()
      if (!normalizedEmail || !normalizedEmail.includes("@")) {
        setError("Escribe un correo válido.")
        return
      }
      if (creatingOrg && !normalizedTeam) {
        setError("Escribe el nombre del equipo.")
        return
      }

      setSubmitting(true)
      setError(null)
      setInvitation(null)
      try {
        const org = creatingOrg
          ? await apiClient.createOrganization({ name: normalizedTeam })
          : manageableOrgs.find((item) => item.id === selectedOrgId)
        if (!org?.id) throw new Error("No se encontró un equipo para invitar.")

        const invite = await apiClient.inviteOrganizationMember(org.id, {
          email: normalizedEmail,
          projectName: workspaceName,
          role: "MEMBER",
          workspaceUrl: typeof window !== "undefined" ? window.location.href : undefined,
        })
        setInvitation(invite)
        setSelectedOrgId(org.id)
        setOrgs((items) => (items.some((item) => item.id === org.id) ? items : [{ ...org, role: "OWNER" }, ...items]))
        toast.success("Invitación creada")
      } catch (err) {
        setError(messageForInviteError(err))
      } finally {
        setSubmitting(false)
      }
    },
    [creatingOrg, email, manageableOrgs, selectedOrgId, teamName],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-48px)] overflow-y-auto p-0 sm:max-w-[520px]">
        <DialogHeader className="border-b border-border/70 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#FF0000]/10 text-[#D00000]">
              <UserPlus className="h-4 w-4" />
            </span>
            Invitar
          </DialogTitle>
          <DialogDescription>
            Suma un miembro al equipo para colaborar en Sira.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
          <div className="rounded-md border border-border/70 bg-muted/25 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Proyecto</p>
            <p className="mt-0.5 truncate text-sm font-medium">{workspaceName}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="code-invite-email" className="text-xs">
              Correo del miembro
            </Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="code-invite-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="nombre@empresa.com"
                className="h-10 pl-9 text-sm"
                disabled={submitting}
              />
            </div>
          </div>

          {manageableOrgs.length > 0 ? (
            <div className="space-y-2">
              <Label htmlFor="code-invite-org" className="text-xs">
                Equipo
              </Label>
              <select
                id="code-invite-org"
                value={selectedOrgId}
                onChange={(event) => setSelectedOrgId(event.target.value)}
                disabled={submitting || loadingOrgs}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {manageableOrgs.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
                <option value={NEW_ORG_ID}>Crear equipo nuevo</option>
              </select>
            </div>
          ) : null}

          {creatingOrg ? (
            <div className="space-y-2">
              <Label htmlFor="code-invite-team" className="text-xs">
                Nombre del equipo o empresa
              </Label>
              <Input
                id="code-invite-team"
                value={teamName}
                onChange={(event) => setTeamName(event.target.value)}
                placeholder="Equipo de producto"
                className="h-10 text-sm"
                disabled={submitting}
              />
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
              {error}
            </div>
          ) : null}

          {invitation ? (
            <div className="space-y-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium">Invitación lista para {invitation.email}</p>
                  <p className="mt-1 break-all text-xs opacity-80">{invitation.magicLink}</p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopy}
                className="h-8 border-emerald-300 bg-white/70 text-xs text-emerald-900 hover:bg-white dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100"
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copiar invitación
              </Button>
            </div>
          ) : null}

          <DialogFooter className="gap-2 border-t border-border/70 pt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className="h-9 text-sm"
            >
              Cerrar
            </Button>
            <Button
              type="submit"
              disabled={submitting || loadingOrgs}
              className={cn("h-9 bg-[#FF0000] text-sm text-white hover:bg-[#D60000]")}
            >
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
              Invitar por correo
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
