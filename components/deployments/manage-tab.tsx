"use client"

import * as React from "react"
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  ExternalLink,
  Globe2,
  Loader2,
  Pause,
  Play,
  Power,
  RefreshCw,
  Save,
  Server,
  Settings2,
  Smartphone,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  deploymentsApi,
  type Deployment,
  type DeploymentPatch,
  type DeploymentProvider,
  type DeploymentType,
  type DeploymentVisibility,
} from "@/lib/deployments/deployments-api"

import { InfoBanner, PanelCard, StatusPill } from "./shared"

const TYPE_OPTIONS: { value: DeploymentType; label: string }[] = [
  { value: "autoscale", label: "Autoscale" },
  { value: "reserved_vm", label: "Reserved VM" },
  { value: "static", label: "Static" },
  { value: "scheduled", label: "Scheduled" },
  { value: "hostinger_vps", label: "Hostinger VPS" },
  { value: "aws", label: "AWS" },
]

const VISIBILITY_OPTIONS: { value: DeploymentVisibility; label: string }[] = [
  { value: "public", label: "Public" },
  { value: "workspace", label: "Workspace" },
  { value: "private", label: "Private" },
  { value: "password", label: "Password protected" },
]

const MACHINE_TIER_OPTIONS: { value: string; label: string }[] = [
  { value: "0.5vcpu_2gb", label: "Shared 0.5 vCPU / 2 GiB RAM" },
  { value: "1vcpu_4gb", label: "Dedicated 1 vCPU / 4 GiB RAM" },
  { value: "2vcpu_8gb", label: "Dedicated 2 vCPU / 8 GiB RAM" },
  { value: "4vcpu_16gb", label: "Dedicated 4 vCPU / 16 GiB RAM" },
]
const RESERVED_MACHINE_TIERS = new Set(MACHINE_TIER_OPTIONS.map((option) => option.value))

const SUSPENDED_INFO =
  "Your deployment was suspended due to a billing failure. Navigate to Account > Billing to resolve. If no action is taken your deployment will be deleted 30 days after the date it was suspended. For more assistance reach out to support at support@replit.com."

function formatComputeUnits(deployment: Deployment): string {
  const cpu = typeof deployment.cpu === "number" ? deployment.cpu : 1
  const memory = typeof deployment.memoryMb === "number" ? deployment.memoryMb : 1024
  const created = new Date(deployment.createdAt).getTime()
  const ageDays = Number.isFinite(created)
    ? Math.max(1, Math.ceil((Date.now() - created) / (24 * 60 * 60 * 1000)))
    : 1
  return Math.round((cpu * 1920 + memory / 16) * ageDays).toLocaleString()
}

function formatRenewalDate(): string {
  const next = new Date()
  next.setDate(next.getDate() + 18)
  return next.toLocaleDateString("en", { day: "numeric", month: "short" }).toLowerCase()
}

export function ManageTab({
  deployment,
  onRefetch,
}: {
  deployment: Deployment
  onRefetch: () => void
}) {
  // Settings form state.
  const [buildCommand, setBuildCommand] = React.useState(deployment.buildCommand ?? "")
  const [runCommand, setRunCommand] = React.useState(deployment.runCommand ?? "")
  const [publicDir, setPublicDir] = React.useState(deployment.publicDir ?? "")
  const [externalPort, setExternalPort] = React.useState(
    deployment.externalPort != null ? String(deployment.externalPort) : "",
  )
  const [visibility, setVisibility] = React.useState<DeploymentVisibility>(deployment.visibility)
  const [saving, setSaving] = React.useState(false)

  // Change-type reveal state.
  const [showChangeType, setShowChangeType] = React.useState(false)
  const [deploymentType, setDeploymentType] = React.useState<DeploymentType>(deployment.deploymentType)
  const [machineTier, setMachineTier] = React.useState(deployment.machineTier)
  const [changingType, setChangingType] = React.useState(false)

  // Lifecycle actions.
  const [pausing, setPausing] = React.useState(false)
  const [resuming, setResuming] = React.useState(false)
  const [confirmShutdown, setConfirmShutdown] = React.useState(false)
  const [shuttingDown, setShuttingDown] = React.useState(false)
  const [providers, setProviders] = React.useState<DeploymentProvider[]>([])
  const [providersLoading, setProvidersLoading] = React.useState(false)
  const [connectingProvider, setConnectingProvider] = React.useState<string | null>(null)

  // Re-sync the form when the selected deployment changes.
  React.useEffect(() => {
    setBuildCommand(deployment.buildCommand ?? "")
    setRunCommand(deployment.runCommand ?? "")
    setPublicDir(deployment.publicDir ?? "")
    setExternalPort(deployment.externalPort != null ? String(deployment.externalPort) : "")
    setVisibility(deployment.visibility)
    setDeploymentType(deployment.deploymentType)
    setMachineTier(deployment.machineTier)
  }, [deployment])

  React.useEffect(() => {
    let alive = true
    setProvidersLoading(true)
    deploymentsApi
      .providers()
      .then((rows) => {
        if (alive) setProviders(rows)
      })
      .catch(() => {
        if (alive) setProviders([])
      })
      .finally(() => {
        if (alive) setProvidersLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const save = async () => {
    setSaving(true)
    const parsedPort = externalPort.trim() === "" ? null : Number.parseInt(externalPort, 10)
    if (parsedPort != null && !Number.isFinite(parsedPort)) {
      toast.error("External port must be a number.")
      setSaving(false)
      return
    }
    const patch: DeploymentPatch = {
      buildCommand: buildCommand.trim() || null,
      runCommand: runCommand.trim() || null,
      publicDir: publicDir.trim() || null,
      visibility,
      externalPort: parsedPort,
    }
    try {
      await deploymentsApi.update(deployment.id, patch)
      toast.success("Settings saved.")
      onRefetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save settings.")
    } finally {
      setSaving(false)
    }
  }

  const changeType = async () => {
    setChangingType(true)
    const patch: DeploymentPatch = {
      deploymentType,
      ...(deploymentType === "reserved_vm" ? { machineTier } : {}),
    }
    try {
      await deploymentsApi.update(deployment.id, patch)
      toast.success("Deployment type updated.")
      setShowChangeType(false)
      onRefetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change type.")
    } finally {
      setChangingType(false)
    }
  }

  const updateDeploymentType = (value: DeploymentType) => {
    setDeploymentType(value)
    if (value === "reserved_vm" && !RESERVED_MACHINE_TIERS.has(machineTier)) {
      setMachineTier("1vcpu_4gb")
    }
  }

  const connectProvider = async (provider: DeploymentProvider) => {
    if (provider.id !== "hostinger_vps" && provider.id !== "aws") return
    setConnectingProvider(provider.id)
    try {
      await deploymentsApi.connectProvider(deployment.id, provider.id)
      toast.success(`${provider.label} connected.`)
      onRefetch()
      setProviders(await deploymentsApi.providers())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not connect provider.")
    } finally {
      setConnectingProvider(null)
    }
  }

  const pause = async () => {
    setPausing(true)
    try {
      await deploymentsApi.pause(deployment.id)
      toast.success("Deployment paused.")
      onRefetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not pause.")
    } finally {
      setPausing(false)
    }
  }

  const resume = async () => {
    setResuming(true)
    try {
      await deploymentsApi.resume(deployment.id)
      toast.success("Deployment resumed.")
      onRefetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not resume.")
    } finally {
      setResuming(false)
    }
  }

  const shutdown = async () => {
    setShuttingDown(true)
    try {
      await deploymentsApi.shutdown(deployment.id)
      toast.success("Deployment shut down.")
      setConfirmShutdown(false)
      onRefetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not shut down.")
    } finally {
      setShuttingDown(false)
    }
  }

  const isPausedOrSuspended = deployment.status === "paused" || deployment.status === "suspended"
  const isSuspended = deployment.status === "suspended"
  const isShutDown = deployment.status === "shut_down"
  const isRunning = deployment.status === "running"
  const computeUnits = formatComputeUnits(deployment)
  const renewsAt = formatRenewalDate()

  return (
    <div className="mx-auto w-full space-y-8 pt-5" style={{ maxWidth: 600 }}>
      <section className="space-y-2">
        <h3 className="text-[15px] font-semibold text-foreground">Resource usage</h3>
        <div className="relative rounded-md p-3 pr-10 text-[13px] text-foreground" style={{ backgroundColor: "#e2dfd6" }}>
          <button
            type="button"
            onClick={() => setShowChangeType(true)}
            className="absolute right-3 top-3 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Edit resource usage"
          >
            <Settings2 className="h-4 w-4" />
          </button>
          <p>{deployment.typeLabel} ({deployment.machineLabel})</p>
          <p className="mt-1">
            {computeUnits} compute units used this billing period
            <span className="ml-2 text-muted-foreground">Renews {renewsAt}</span>
          </p>
          <button
            type="button"
            onClick={() => toast.message("Resource limits are managed by your connected provider.")}
            className="mt-1 text-[13px] font-medium text-[#0b72e7] hover:opacity-80"
          >
            View account resource limits
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-[15px] font-semibold text-foreground">Manage published app</h3>

        {isSuspended ? <InfoBanner>{SUSPENDED_INFO}</InfoBanner> : null}

        <ActionItem
          icon={<Pause className="h-4 w-4" />}
          label="Pause"
          description="Your billing will continue, but all users will lose access to your app"
          onClick={() => void pause()}
          disabled={!isRunning || pausing}
          busy={pausing}
        />

        <ActionItem
          icon={<Settings2 className="h-4 w-4" />}
          label="Change deployment type"
          description="To change your deployment type, you will need to unpublish and publish again."
          onClick={() => setShowChangeType((v) => !v)}
        />
        {showChangeType ? (
          <div className="grid gap-3 rounded-md border border-border bg-background p-3 sm:grid-cols-2">
            <SelectField
              label="Deployment type"
              value={deploymentType}
              onChange={(v) => updateDeploymentType(v as DeploymentType)}
            >
              {TYPE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-[12px]">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectField>
            {deploymentType === "reserved_vm" ? (
              <SelectField label="Machine" value={machineTier} onChange={setMachineTier}>
                {MACHINE_TIER_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-[12px]">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectField>
            ) : null}
            <div className="sm:col-span-2 flex justify-end">
              <Button size="sm" className="h-8 gap-1.5" onClick={() => void changeType()} disabled={changingType}>
                {changingType ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Apply change
              </Button>
            </div>
          </div>
        ) : null}

        <ActionItem
          icon={<Power className="h-4 w-4" />}
          label="Shut down"
          description="Your published app billing will be canceled, and it will cease to exist."
          onClick={() => setConfirmShutdown(true)}
          disabled={isShutDown}
          destructive
        />
      </section>

      <section className="space-y-2">
        <h3 className="text-[15px] font-semibold text-foreground">Publish on the go</h3>
        <Button
          size="sm"
          variant="outline"
          className="h-8 w-full rounded-md border-transparent bg-[#e8e6df] text-[13px] font-medium shadow-none hover:bg-[#dedbd2]"
          onClick={() => window.open("https://replit.com/mobile", "_blank", "noopener,noreferrer")}
        >
          <Smartphone className="h-3.5 w-3.5" />
          Install the Replit App
        </Button>
      </section>

      {isPausedOrSuspended && !isShutDown ? (
        <section className="space-y-2">
          <h3 className="text-[15px] font-semibold text-foreground">Paused deployment</h3>
          <ActionItem
            icon={<Play className="h-4 w-4" />}
            label="Resume"
            description="Your app will become accessible to users again."
            onClick={() => void resume()}
            disabled={resuming}
            busy={resuming}
          />
        </section>
      ) : null}

      <PanelCard
        title="Provider connections"
        detail="Connect this deployment to real infrastructure and domain providers."
      >
        {providersLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading providers
          </div>
        ) : (
          <div className="space-y-2">
            {providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                active={deployment.deploymentType === provider.id}
                busy={connectingProvider === provider.id}
                onConnect={() => void connectProvider(provider)}
              />
            ))}
          </div>
        )}
      </PanelCard>

      {/* Settings form (landing target for "Adjust settings") */}
      <PanelCard
        title="Commands and domain"
        detail="Configure what the selected deployment builds and runs."
        action={
          <Button size="sm" className="h-8 gap-1.5" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        }
      >
        <div className="grid gap-3">
          <TextField label="Build command" value={buildCommand} onChange={setBuildCommand} mono />
          <TextField label="Run command" value={runCommand} onChange={setRunCommand} mono />
          <TextField label="Public directory" value={publicDir} onChange={setPublicDir} mono />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="External port" value={externalPort} onChange={setExternalPort} placeholder="3000" />
            <SelectField
              label="Visibility"
              value={visibility}
              onChange={(v) => setVisibility(v as DeploymentVisibility)}
            >
              {VISIBILITY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-[12px]">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectField>
          </div>
        </div>
      </PanelCard>

      <Dialog open={confirmShutdown} onOpenChange={setConfirmShutdown}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-[15px]">Shut down deployment?</DialogTitle>
            <DialogDescription className="text-[12px]">
              Billing for "{deployment.name}" will be canceled and it will cease to exist. You will need to publish
              again to reactivate it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => setConfirmShutdown(false)}
              disabled={shuttingDown}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => void shutdown()}
              disabled={shuttingDown}
            >
              {shuttingDown ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
              Shut down
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ProviderRow({
  provider,
  active,
  busy,
  onConnect,
}: {
  provider: DeploymentProvider
  active: boolean
  busy: boolean
  onConnect: () => void
}) {
  const isCompute = provider.category === "compute"
  const configured = provider.configured
  const missing = provider.missingRequired.join(", ")
  return (
    <div className="rounded-md border border-border/60 bg-background/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex flex-1 items-start gap-2.5">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
            {provider.id === "hostinger_vps" ? (
              <Server className="h-4 w-4" />
            ) : provider.id === "aws" ? (
              <Cloud className="h-4 w-4" />
            ) : (
              <Globe2 className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[12px] font-semibold text-foreground">{provider.label}</p>
              {active ? <StatusPill tone="success" label="Active" /> : null}
              <StatusPill tone={configured ? "success" : "warn"} label={configured ? "Configured" : "Setup required"} />
            </div>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{provider.description}</p>
            {!configured ? (
              <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-4 text-amber-700">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Missing: <span className="font-mono">{missing}</span>
              </p>
            ) : (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] leading-4 text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Required variables are present.
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" className="h-8 gap-1.5" asChild>
            <a href={provider.docsUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
              Docs
            </a>
          </Button>
          {isCompute ? (
            <Button size="sm" className="h-8 gap-1.5" onClick={onConnect} disabled={!configured || busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Connect
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ActionItem({
  icon,
  label,
  description,
  onClick,
  disabled,
  busy,
  destructive,
}: {
  icon: React.ReactNode
  label: string
  description: string
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  destructive?: boolean
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || busy}
        className={cn(
          "flex h-8 w-full items-center justify-center gap-2 rounded-md border px-3 text-center text-[13px] font-medium transition-colors",
          "disabled:cursor-not-allowed disabled:text-muted-foreground",
          destructive
            ? "border-border bg-background text-foreground hover:bg-muted/60"
            : "border-transparent bg-[#e8e6df] text-foreground hover:bg-[#dedbd2] disabled:bg-[#e8e6df]",
        )}
      >
        <span className="shrink-0 text-muted-foreground">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
        </span>
        {label}
      </button>
      <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{description}</p>
    </div>
  )
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  mono?: boolean
}) {
  return (
    <label className="block text-[12px] font-medium text-foreground">
      {label}
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn("mt-1 h-9 text-[12px]", mono && "font-mono")}
      />
    </label>
  )
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  children: React.ReactNode
}) {
  return (
    <div className="block text-[12px] font-medium text-foreground">
      <span className="mb-1 block">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9 text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </div>
  )
}
