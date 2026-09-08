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
import { agentCompanyDisplayName } from "@/lib/code-agent-company"
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

function isGenericWorkspaceName(name: string) {
  const clean = String(name || "").trim()
  if (!clean) return true
  return /^(workspace(\s+del\s+navegador)?|workspace|empresa|sira|equipo de sira)$/i.test(clean)
}

function resolveCompanyLabel(folderName: string, orgName?: string) {
  if (folderName && !isGenericWorkspaceName(folderName)) {
    return agentCompanyDisplayName(folderName)
  }
  const org = String(orgName || "").trim()
  if (org && !isGenericWorkspaceName(org)) return org
  if (folderName) {
    const display = agentCompanyDisplayName(folderName)
    if (display && !isGenericWorkspaceName(display)) return display
  }
  return ""
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
  const { activeFolder } = useCodeWorkspace()
  const folderName = activeFolder?.name?.trim() || ""
  const [email, setEmail] = React.useState("")
  const [orgs, setOrgs] = React.useState<OrganizationSummary[]>([])
  const [selectedOrgId, setSelectedOrgId] = React.useState(NEW_ORG_ID)
  const [loadingOrgs, setLoadingOrgs] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [invitation, setInvitation] = React.useState<OrganizationInvitation | null>(null)

  const manageableOrgs = React.useMemo(() => orgs.filter(canInvite), [orgs])
  const selectedOrg = manageableOrgs.find((item) => item.id === selectedOrgId)
  const creatingOrg = selectedOrgId === NEW_ORG_ID || manageableOrgs.length === 0
  const companyLabel = resolveCompanyLabel(folderName, selectedOrg?.name)
  const teamName = companyLabel || "Equipo"

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setInvitation(null)

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
  }, [open, folderName])

  const shareText = React.useMemo(() => {
    if (!invitation) return ""
    const workspaceUrl = typeof window !== "undefined" ? window.location.href : ""
    const label = companyLabel || "Sira"
    return [
      `Te invité a colaborar en ${label} dentro de Sira.`,
      `Acceso a Sira: ${invitation.magicLink}`,
      workspaceUrl ? `Workspace: ${workspaceUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  }, [invitation, companyLabel])

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
      if (!normalizedEmail || !normalizedEmail.includes("@")) {
        setError("Escribe un correo válido.")
        return
      }

      setSubmitting(true)
      setError(null)
      setInvitation(null)
      try {
        const org = creatingOrg
          ? await apiClient.createOrganization({ name: teamName })
          : manageableOrgs.find((item) => item.id === selectedOrgId)
        if (!org?.id) throw new Error("No se encontró un equipo para invitar.")

        const invite = await apiClient.inviteOrganizationMember(org.id, {
          email: normalizedEmail,
          projectName: companyLabel || org.name || teamName,
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
    [companyLabel, creatingOrg, email, manageableOrgs, selectedOrgId, teamName],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 shadow-xl sm:max-w-[440px] sm:rounded-2xl"
        data-testid="project-invite-dialog"
        data-invite-pro="20260815"
      >
        <DialogHeader className="space-y-1.5 px-5 pb-0 pt-5 text-left">
          <DialogTitle className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <UserPlus className="h-4 w-4" />
            </span>
            Invitar al equipo
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-snug">
            Envía un correo para colaborar en esta empresa.
          </DialogDescription>
          {companyLabel ? (
            <p className="text-[12px] text-muted-foreground" data-testid="project-invite-company">
              {companyLabel}
            </p>
          ) : null}
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 pb-5 pt-4">
          <div className="space-y-1.5">
            <Label htmlFor="code-invite-email" className="text-[12px] font-medium text-muted-foreground">
              Correo
            </Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="code-invite-email"
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="nombre@empresa.com"
                className="h-10 rounded-lg border-border/80 pl-9 text-sm shadow-none focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/25 focus-visible:ring-offset-0"
                disabled={submitting}
              />
            </div>
          </div>

          {manageableOrgs.length > 1 ? (
            <div className="space-y-1.5">
              <Label htmlFor="code-invite-org" className="text-[12px] font-medium text-muted-foreground">
                Equipo
              </Label>
              <select
                id="code-invite-org"
                value={selectedOrgId}
                onChange={(event) => setSelectedOrgId(event.target.value)}
                disabled={submitting || loadingOrgs}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {manageableOrgs.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-red-200/80 bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
              {error}
            </div>
          ) : null}

          {invitation ? (
            <div className="space-y-2.5 rounded-lg border border-emerald-200/80 bg-emerald-50/80 px-3 py-2.5 text-[13px] text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium">Invitación lista para {invitation.email}</p>
                  <p className="mt-1 break-all text-[11px] opacity-70">{invitation.magicLink}</p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopy}
                className="h-8 border-emerald-300/80 bg-background/70 text-xs hover:bg-background dark:border-emerald-800"
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copiar invitación
              </Button>
            </div>
          ) : null}

          <DialogFooter className="gap-2 border-0 bg-transparent p-0 sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className="h-9 text-sm text-muted-foreground hover:text-foreground"
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={submitting || loadingOrgs} className={cn("h-9 px-4 text-sm")}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Enviar invitación
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
