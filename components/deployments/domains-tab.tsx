"use client"

import * as React from "react"
import { ChevronDown, Link2, Loader2, Plus, ShoppingCart, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  deploymentsApi,
  type Deployment,
  type DeploymentDomain,
  type DeploymentVersion,
  type DnsRecord,
} from "@/lib/deployments/deployments-api"

import { WarningBanner } from "./shared"

function defaultDomainName(deployment: Deployment): string {
  try {
    return new URL(deployment.defaultDomain).hostname
  } catch {
    return deployment.defaultDomain.replace(/^https?:\/\//, "")
  }
}

export function DomainsTab({
  deploymentId,
  deployment,
  domains,
  versions,
  onRefetch,
}: {
  deploymentId: string
  deployment: Deployment
  domains: DeploymentDomain[]
  versions: DeploymentVersion[]
  onRefetch: () => void
}) {
  const [hostname, setHostname] = React.useState("")
  const [adding, setAdding] = React.useState(false)
  const [showConnect, setShowConnect] = React.useState(false)
  const [removingId, setRemovingId] = React.useState<string | null>(null)
  const [expandedId, setExpandedId] = React.useState<string | null>(null)

  const customDomains = domains.filter((d) => d.kind !== "default")
  const hasLiveVersion =
    versions.some((v) => v.isLive || v.status === "promoted") || deployment.status === "running"

  const addDomain = async () => {
    const trimmed = hostname.trim()
    if (!trimmed) {
      toast.error("Enter a domain.")
      return
    }
    setAdding(true)
    try {
      const domain = await deploymentsApi.addDomain(deploymentId, trimmed)
      toast.success("Domain added. Configure the DNS records.")
      setHostname("")
      setShowConnect(false)
      setExpandedId(domain.id)
      onRefetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add domain.")
    } finally {
      setAdding(false)
    }
  }

  const removeDomain = async (domainId: string) => {
    setRemovingId(domainId)
    try {
      await deploymentsApi.removeDomain(deploymentId, domainId)
      toast.success("Domain removed.")
      onRefetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove domain.")
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-foreground">Domains</h3>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => toast.message("Domain purchasing is coming soon.")}
          >
            <ShoppingCart className="h-3.5 w-3.5" />
            Buy a new domain
          </Button>
          <Button size="sm" className="h-8 gap-1.5" onClick={() => setShowConnect((v) => !v)}>
            <Link2 className="h-3.5 w-3.5" />
            Connect your own domain
          </Button>
        </div>
      </div>

      {!hasLiveVersion ? (
        <WarningBanner>You must successfully publish your project before linking a domain</WarningBanner>
      ) : null}

      {showConnect ? (
        <div className="flex gap-2 rounded-lg border border-border/60 bg-card/80 p-3">
          <Input
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !adding) void addDomain()
            }}
            placeholder="app.midominio.com"
            className="h-9 text-[12px]"
            autoFocus
          />
          <Button size="sm" className="h-9 shrink-0 gap-1.5" onClick={() => void addDomain()} disabled={adding}>
            {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add
          </Button>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border/60 bg-card/80">
        <table className="w-full text-left text-[12px]">
          <thead className="border-b border-border/60 bg-muted/30 text-[11px] font-medium text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Registered With</th>
              <th className="w-[120px] px-4 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {/* Default domain row */}
            <tr className="border-b border-border/40">
              <td className="px-4 py-2.5 font-mono text-[11px]">{defaultDomainName(deployment)}</td>
              <td className="px-4 py-2.5 text-muted-foreground">N/A</td>
              <td className="px-4 py-2.5 text-right">
                <Button size="sm" variant="ghost" className="h-7 text-[11px] text-muted-foreground" disabled>
                  Manage
                </Button>
              </td>
            </tr>

            {/* Custom domain rows */}
            {customDomains.map((domain) => {
              const expanded = expandedId === domain.id
              const records: DnsRecord[] = domain.dnsRecords ?? []
              return (
                <React.Fragment key={domain.id}>
                  <tr className="border-b border-border/40 last:border-b-0">
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-2">
                        <span className="font-mono text-[11px]">{domain.hostname}</span>
                        <VerificationPill status={domain.verificationStatus} />
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">Custom DNS</td>
                    <td className="px-4 py-2.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 text-[11px]"
                        onClick={() => setExpandedId((prev) => (prev === domain.id ? null : domain.id))}
                      >
                        Manage
                        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
                      </Button>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className="border-b border-border/40 bg-muted/20 last:border-b-0">
                      <td colSpan={3} className="px-4 py-3">
                        <div className="space-y-3">
                          <p className="text-[11px] text-muted-foreground">
                            Add these records in your DNS provider to verify the domain:
                          </p>
                          {records.length > 0 ? (
                            <div className="overflow-hidden rounded-md border border-border/60">
                              <table className="w-full text-left text-[11px]">
                                <thead className="bg-muted/40 text-muted-foreground">
                                  <tr>
                                    <th className="px-3 py-1.5 font-medium">Tipo</th>
                                    <th className="px-3 py-1.5 font-medium">Nombre</th>
                                    <th className="px-3 py-1.5 font-medium">Valor</th>
                                    <th className="px-3 py-1.5 font-medium">TTL</th>
                                  </tr>
                                </thead>
                                <tbody className="font-mono">
                                  {records.map((record, index) => (
                                    <tr key={`${record.type}-${index}`} className="border-t border-border/50">
                                      <td className="px-3 py-1.5">{record.type}</td>
                                      <td className="px-3 py-1.5 break-all">{record.name}</td>
                                      <td className="px-3 py-1.5 break-all">{record.value}</td>
                                      <td className="px-3 py-1.5">{record.ttl}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <p className="text-[11px] text-muted-foreground">
                              No DNS records are available yet.
                            </p>
                          )}
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 gap-1.5 text-muted-foreground hover:text-rose-600"
                              onClick={() => void removeDomain(domain.id)}
                              disabled={removingId === domain.id}
                            >
                              {removingId === domain.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                              Remove
                            </Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function VerificationPill({ status }: { status: DeploymentDomain["verificationStatus"] }) {
  const map: Record<DeploymentDomain["verificationStatus"], { label: string; cls: string; dot: string }> = {
    verified: {
      label: "Verified",
      cls: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600",
      dot: "bg-emerald-500",
    },
    pending: {
      label: "Pending",
      cls: "border-amber-500/25 bg-amber-500/10 text-amber-600",
      dot: "bg-amber-500",
    },
    failed: {
      label: "Failed",
      cls: "border-rose-500/25 bg-rose-500/10 text-rose-600",
      dot: "bg-rose-500",
    },
  }
  const entry = map[status]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        entry.cls,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", entry.dot)} aria-hidden />
      {entry.label}
    </span>
  )
}
