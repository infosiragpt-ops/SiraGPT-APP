"use client"

import * as React from "react"
import { Loader2, Rocket } from "lucide-react"
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
import {
  deploymentsApi,
  type CreateDeploymentInput,
  type Deployment,
  type DeploymentGeography,
  type DeploymentType,
  type DeploymentVisibility,
} from "@/lib/deployments/deployments-api"

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

const GEOGRAPHY_OPTIONS: { value: DeploymentGeography; label: string }[] = [
  { value: "na", label: "North America" },
  { value: "eu", label: "Europe" },
  { value: "sa", label: "South America" },
  { value: "asia", label: "Asia" },
  { value: "au", label: "Australia" },
]

// Values MUST match the backend RESERVED_TIERS keys (pipeline.js).
const MACHINE_TIER_OPTIONS: { value: string; label: string }[] = [
  { value: "0.5vcpu_2gb", label: "Shared · 0.5 vCPU / 2 GiB RAM" },
  { value: "1vcpu_4gb", label: "Dedicated · 1 vCPU / 4 GiB RAM" },
  { value: "2vcpu_8gb", label: "Dedicated · 2 vCPU / 8 GiB RAM" },
  { value: "4vcpu_16gb", label: "Dedicated · 4 vCPU / 16 GiB RAM" },
]

export function CreateDeploymentDialog({
  open,
  onOpenChange,
  onCreated,
  projectId = null,
  defaultName = "",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (deployment: Deployment) => void
  projectId?: string | null
  defaultName?: string
}) {
  const [name, setName] = React.useState("")
  const [deploymentType, setDeploymentType] = React.useState<DeploymentType>("autoscale")
  const [visibility, setVisibility] = React.useState<DeploymentVisibility>("public")
  const [geography, setGeography] = React.useState<DeploymentGeography>("na")
  const [machineTier, setMachineTier] = React.useState<string>("1vcpu_4gb")
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setName(defaultName)
    setDeploymentType("autoscale")
    setVisibility("public")
    setGeography("na")
    setMachineTier("1vcpu_4gb")
  }, [open, defaultName])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error("Name your deployment.")
      return
    }
    setSubmitting(true)
    try {
      const input: CreateDeploymentInput = {
        name: trimmed,
        deploymentType,
        visibility,
        geography,
        ...(projectId ? { projectId } : {}),
        ...(deploymentType === "reserved_vm" ? { machineTier } : {}),
      }
      const deployment = await deploymentsApi.create(input)
      toast.success("Deployment created.")
      onCreated(deployment)
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create deployment.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Rocket className="h-4 w-4" />
            New deployment
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            Publish a shareable version of your project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block text-[12px] font-medium text-foreground">
            Name
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !submitting) void submit()
              }}
              placeholder="mi-app-de-produccion"
              className="mt-1 h-9 text-[12px]"
              autoFocus
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type">
              <Select value={deploymentType} onValueChange={(v) => setDeploymentType(v as DeploymentType)}>
                <SelectTrigger className="h-9 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className="text-[12px]">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Visibility">
              <Select value={visibility} onValueChange={(v) => setVisibility(v as DeploymentVisibility)}>
                <SelectTrigger className="h-9 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VISIBILITY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className="text-[12px]">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Geography">
              <Select value={geography} onValueChange={(v) => setGeography(v as DeploymentGeography)}>
                <SelectTrigger className="h-9 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GEOGRAPHY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className="text-[12px]">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {deploymentType === "reserved_vm" ? (
              <Field label="Machine">
                <Select value={machineTier} onValueChange={setMachineTier}>
                  <SelectTrigger className="h-9 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MACHINE_TIER_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value} className="text-[12px]">
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" className="h-9" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button size="sm" className="h-9 gap-1.5" onClick={() => void submit()} disabled={submitting}>
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
            Create deployment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block text-[12px] font-medium text-foreground">
      <span className="mb-1 block">{label}</span>
      {children}
    </div>
  )
}
