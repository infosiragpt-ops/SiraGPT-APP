"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import {
  ArrowUpDown,
  ChevronDown,
  Copy,
  ExternalLink,
  Globe,
  List,
  Pause,
  QrCode,
  Rocket,
  Search,
  Settings,
  SlidersHorizontal,
  Smartphone,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import type {
  PublishingActionId,
  PublishingActionResult,
  PublishingConsoleState,
  PublishingDomain,
  PublishingLogEntry,
  PublishingTabId,
} from "@/lib/publishing-console-types"

type PublishingConsoleProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type TabDef = {
  id: PublishingTabId
  label: string
  icon: LucideIcon
}

const TABS: TabDef[] = [
  { id: "overview", label: "Overview", icon: Globe },
  { id: "logs", label: "Logs", icon: List },
  { id: "domains", label: "Domains", icon: Globe },
  { id: "manage", label: "Manage", icon: Settings },
]

const PUBLISHING_ENDPOINT = "/code/publishing-state"

const EMPTY_STATE: PublishingConsoleState = {
  appName: "siragpt",
  ownerName: "kk",
  statusLabel: "published",
  visibility: "Public",
  seoRating: "HEALTHY",
  productionUrl: "https://siragpt.com",
  replitUrl: "https://siragpt.replit.app",
  customDomainUrl: "https://siragpt.com",
  referralLink: "https://replit.com/refer/infosiragpt",
  geography: "North America",
  deploymentType: "Reserved VM",
  deploymentTypeDetail: "Dedicated 2 vCPU / 8 GiB RAM",
  databaseLabel: "Production database connected",
  healthStatus: "healthy",
  lastPublishedAgo: "about 4 hours ago",
  deploymentId: "63298d0b",
  domains: [
    {
      host: "siragpt.replit.app",
      url: "https://siragpt.replit.app",
      registeredWith: "N/A",
      verified: true,
      manageable: false,
    },
    {
      host: "siragpt.com",
      url: "https://siragpt.com",
      registeredWith: "GoDaddy.com, LLC",
      verified: true,
      warning: true,
      manageable: true,
    },
  ],
  timeline: [
    { id: "438d7595", label: "438d7595", publishedAgo: "kk published 10 days ago" },
    { id: "39864864", label: "39864864", publishedAgo: "kk published 11 days ago" },
  ],
  logs: [],
  madeWithReplitBadge: false,
  apiConfigured: true,
  generatedAt: new Date(0).toISOString(),
}

export function PublishingConsole({ open, onOpenChange }: PublishingConsoleProps) {
  const [activeTab, setActiveTab] = React.useState<PublishingTabId>("overview")
  const [state, setState] = React.useState<PublishingConsoleState>(EMPTY_STATE)
  const [loading, setLoading] = React.useState(false)
  const [busyAction, setBusyAction] = React.useState<PublishingActionId | null>(null)
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(PUBLISHING_ENDPOINT, { cache: "no-store" })
      if (!response.ok) throw new Error(`Publishing API returned ${response.status}`)
      setState((await response.json()) as PublishingConsoleState)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo cargar Publishing")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onOpenChange, open])

  const runAction = React.useCallback(
    async (action: PublishingActionId, options?: { domain?: PublishingDomain; silent?: boolean }) => {
      if (action === "install-app" && typeof window !== "undefined") {
        window.open("https://replit.com/mobile", "_blank", "noopener,noreferrer")
      }
      if (action === "buy-domain" && typeof window !== "undefined") {
        window.open("https://replit.com/domains", "_blank", "noopener,noreferrer")
      }
      if (action === "connect-domain") setActiveTab("domains")
      if (action === "adjust-settings") setActiveTab("manage")
      if (action === "manage-domain" && options?.domain?.url && typeof window !== "undefined") {
        window.open(options.domain.url, "_blank", "noopener,noreferrer")
      }

      setBusyAction(action)
      try {
        const response = await fetch(PUBLISHING_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        })
        const result = (await response.json()) as PublishingActionResult
        if (!response.ok || !result.ok) throw new Error(result.message || "Publishing action failed")
        if (result.state) setState(result.state)
        if (!options?.silent) toast.success(result.message)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "No se pudo ejecutar la acción")
      } finally {
        setBusyAction(null)
      }
    },
    [],
  )

  if (!open || !mounted) return null

  return createPortal(
    <section
      role="dialog"
      aria-label="Publishing"
      className="fixed inset-0 z-[2147483000] isolate flex min-w-0 flex-col overflow-hidden bg-[#f7f6f2] text-[#2f2f2f]"
    >
      <PublishingNav activeTab={activeTab} onChange={setActiveTab} onClose={() => onOpenChange(false)} />

      {activeTab === "overview" ? (
        <OverviewTab
          state={state}
          loading={loading}
          busyAction={busyAction}
          onAction={runAction}
          onCopy={copyText}
        />
      ) : null}
      {activeTab === "logs" ? <LogsTab logs={state.logs} deploymentId={state.deploymentId} loading={loading} /> : null}
      {activeTab === "domains" ? <DomainsTab state={state} busyAction={busyAction} onAction={runAction} /> : null}
      {activeTab === "manage" ? (
        <ManageTab state={state} busyAction={busyAction} onAction={runAction} onBadgeChange={setState} />
      ) : null}
    </section>,
    document.body,
  )
}

function PublishingNav({
  activeTab,
  onChange,
  onClose,
}: {
  activeTab: PublishingTabId
  onChange: (tab: PublishingTabId) => void
  onClose: () => void
}) {
  return (
    <div className="flex h-[41px] shrink-0 items-end border-b border-[#d8d6cf] bg-[#f7f6f2]">
      <div className="flex h-full min-w-0 flex-1 items-end">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const active = tab.id === activeTab
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={cn(
                "flex h-[41px] items-center gap-2 border-b px-[21px] text-[14px] leading-none text-[#2f2f2f]",
                active ? "border-[#1f1f1f] bg-[#f0efeb]" : "border-transparent hover:bg-[#efede8]",
              )}
              onClick={() => onChange(tab.id)}
            >
              <Icon className="h-4 w-4" strokeWidth={1.7} />
              <span>{tab.label}</span>
            </button>
          )
        })}
      </div>
      <button
        type="button"
        className="sr-only"
        aria-label="Close Publishing"
        onClick={onClose}
      >
        Close
      </button>
    </div>
  )
}

function OverviewTab({
  state,
  loading,
  busyAction,
  onAction,
  onCopy,
}: {
  state: PublishingConsoleState
  loading: boolean
  busyAction: PublishingActionId | null
  onAction: (action: PublishingActionId, options?: { silent?: boolean }) => Promise<void>
  onCopy: (value: string, label: string) => Promise<void>
}) {
  const [showReferral, setShowReferral] = React.useState(true)

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto bg-[#f7f6f2] pb-8">
      <OverviewRail />
      <div className="flex h-[52px] items-center gap-8 px-[31px]">
        <ReplitButton
          tone="primary"
          icon={Rocket}
          disabled={busyAction === "republish"}
          onClick={() => onAction("republish")}
        >
          {busyAction === "republish" ? "Republishing" : "Republish"}
        </ReplitButton>
        <ReplitButton icon={ArrowUpDown} onClick={() => onAction("adjust-settings")}>
          Adjust settings
        </ReplitButton>
        <ReplitButton icon={ExternalLink} onClick={() => onAction("security-scan")}>
          Run security scan
        </ReplitButton>
      </div>

      <section className="mx-[31px] rounded-[6px] bg-[#f0efeb] px-4 pb-[18px] pt-[15px]">
        <div className="mb-[13px] text-[16px] font-semibold leading-none">Production</div>
        <DetailRow label="Status">
          <span className="h-2 w-2 rounded-full bg-[#3bb273]" />
          <span>
            <strong>{state.ownerName}</strong> {state.statusLabel} {state.lastPublishedAgo}
          </span>
          <List className="ml-2 h-4 w-4 text-[#707070]" strokeWidth={1.6} />
        </DetailRow>
        <DetailRow label="Visibility">
          <Globe className="h-4 w-4" strokeWidth={1.6} />
          <span>{state.visibility}</span>
        </DetailRow>
        <DetailRow label="SEO Rating">
          <span
            className={cn(
              "rounded-full px-[10px] py-[5px] text-[11px] font-medium leading-none",
              state.seoRating === "HEALTHY" ? "bg-[#cfecd6] text-[#23824d]" : "bg-[#ffe6bd] text-[#8a5a00]",
            )}
          >
            {state.seoRating}
          </span>
          <button
            type="button"
            className="rounded-[6px] border border-[#d1cec6] bg-[#faf9f6] px-3 py-[6px] text-[12px] leading-none hover:bg-white"
            onClick={() => onAction("security-scan")}
          >
            Review SEO with Agent
          </button>
        </DetailRow>
        <DetailRow label="Domain" alignStart>
          <DomainLinks state={state} onCopy={onCopy} />
        </DetailRow>
        <DetailRow label="Geography">{state.geography}</DetailRow>
        <DetailRow label="Type">
          <span>
            {state.deploymentType} <span className="text-[#59606a]">({state.deploymentTypeDetail})</span>
          </span>
          <button type="button" className="text-[#006adc] hover:underline" onClick={() => onAction("adjust-settings")}>
            Manage
          </button>
        </DetailRow>
        <DetailRow label="Database">
          <span>{state.databaseLabel}</span>
          <button type="button" className="text-[#006adc] hover:underline" onClick={() => onAction("adjust-settings")}>
            Manage
          </button>
        </DetailRow>
      </section>

      {showReferral ? (
        <section className="mx-[31px] mt-[11px] rounded-[6px] bg-[#f0efeb] px-4 pb-4 pt-[18px]">
          <div className="flex items-start justify-between gap-4">
            <div className="text-[16px] font-semibold leading-none">Earn $20 for every friend who joins Replit Core</div>
            <button
              type="button"
              aria-label="Dismiss referral"
              className="rounded-sm p-1 hover:bg-[#e5e3dc]"
              onClick={() => setShowReferral(false)}
            >
              <X className="h-4 w-4" strokeWidth={1.6} />
            </button>
          </div>
          <p className="mt-[19px] text-[14px] leading-none text-[#464646]">
            Share your link. When a friend signs up and upgrades to Replit Core, you'll both get $20 in credits.
          </p>
          <div className="mt-[15px] flex gap-2">
            <input
              readOnly
              value={displayUrl(state.referralLink)}
              className="h-8 min-w-0 flex-1 rounded-[4px] border border-[#dad7cf] bg-white px-3 text-[14px] text-[#484848] outline-none"
            />
            <ReplitButton tone="primary" icon={Copy} onClick={() => onCopy(state.referralLink, "Referral link")}>
              Copy link
            </ReplitButton>
          </div>
        </section>
      ) : null}

      <div className="mx-[31px] mt-[15px] space-y-[19px] pb-6">
        {state.timeline.map((entry, index) => (
          <div key={`${entry.id}-${index}`} className="flex items-center gap-3 text-[14px] leading-none text-[#626975]">
            <span>{entry.label}</span>
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#1382d8] text-[9px] font-semibold text-white">
              v
            </span>
            <span>{entry.publishedAgo}</span>
          </div>
        ))}
      </div>

      {loading ? <div className="absolute right-4 top-4 text-xs text-[#6d6a63]">Refreshing…</div> : null}
    </div>
  )
}

function OverviewRail() {
  return (
    <div className="pointer-events-none absolute left-[14px] top-[20px] h-[562px] w-px bg-[#c9c7bd]">
      <span className="absolute left-[-4px] top-[1px] h-2 w-2 rounded-full border border-[#c9c7bd] bg-[#f7f6f2]" />
      <span className="absolute left-[-3px] top-[63px] h-[7px] w-[7px] rounded-full bg-[#2e8ef0]" />
      <span className="absolute left-[-2px] top-[528px] h-1.5 w-1.5 rounded-full bg-[#7bc489]" />
      <span className="absolute left-[-2px] top-[564px] h-1.5 w-1.5 rounded-full bg-[#7bc489]" />
    </div>
  )
}

function DetailRow({
  label,
  children,
  alignStart,
}: {
  label: string
  children: React.ReactNode
  alignStart?: boolean
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[100px_minmax(0,1fr)] gap-0 text-[14px] leading-none",
        alignStart ? "items-start" : "items-center",
        "mb-[14px] last:mb-0",
      )}
    >
      <div className="text-[#4d535b]">{label}</div>
      <div className={cn("flex min-w-0 flex-wrap items-center gap-2", alignStart && "items-start")}>{children}</div>
    </div>
  )
}

function DomainLinks({
  state,
  onCopy,
}: {
  state: PublishingConsoleState
  onCopy: (value: string, label: string) => Promise<void>
}) {
  const domains = [state.replitUrl, state.customDomainUrl].filter(Boolean) as string[]
  return (
    <div className="space-y-[12px]">
      {domains.map((url) => (
        <div key={url} className="flex min-w-0 items-center gap-3">
          <a href={url} target="_blank" rel="noreferrer" className="truncate text-[#1e1f21] hover:underline">
            {url}
          </a>
          <button type="button" aria-label={`Copy ${url}`} onClick={() => onCopy(url, "Domain")}>
            <Copy className="h-4 w-4 text-[#555]" strokeWidth={1.5} />
          </button>
          <button type="button" aria-label={`Show QR for ${url}`} onClick={() => toast.message(`QR ready for ${displayUrl(url)}`)}>
            <QrCode className="h-4 w-4 text-[#555]" strokeWidth={1.5} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="inline-flex h-7 items-center rounded-[6px] border border-[#d1cec6] bg-[#fbfaf7] px-3 text-[12px] leading-none hover:bg-white"
        onClick={() => window.open("https://replit.com/domains", "_blank", "noopener,noreferrer")}
      >
        <span className="mr-2 text-[16px] leading-none">+</span>
        Buy a new domain
        <span className="ml-2 rounded-[4px] bg-[#d8e6ff] px-1.5 py-0.5 text-[11px] text-[#006adc]">Beta</span>
      </button>
    </div>
  )
}

function LogsTab({
  logs,
  deploymentId,
  loading,
}: {
  logs: PublishingLogEntry[]
  deploymentId: string
  loading: boolean
}) {
  const [query, setQuery] = React.useState("")
  const [errorsOnly, setErrorsOnly] = React.useState(false)
  const [wrap, setWrap] = React.useState(false)
  const [colors, setColors] = React.useState(true)
  const [collapsed, setCollapsed] = React.useState(false)
  const [ascending, setAscending] = React.useState(true)

  const filteredLogs = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = logs.filter((entry) => {
      if (errorsOnly && entry.severity !== "error") return false
      if (!q) return true
      return `${entry.time} ${entry.deployment} ${entry.source} ${entry.log}`.toLowerCase().includes(q)
    })
    return ascending ? rows : [...rows].reverse()
  }, [ascending, errorsOnly, logs, query])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#f7f6f2]">
      <div className="flex h-[49px] shrink-0 items-center gap-8 border-b border-[#d8d6cf] px-[10px]">
        <div className="relative min-w-0 flex-1">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            className="h-8 w-full rounded-[6px] border border-[#d8d6cf] bg-white pl-2 pr-9 text-[14px] outline-none focus:border-[#9b9890]"
          />
          <Search className="absolute right-2 top-2 h-4 w-4 text-[#1f1f1f]" strokeWidth={1.7} />
        </div>
        <button
          type="button"
          className="flex h-8 items-center gap-2 rounded-[6px] bg-[#f0efeb] px-3 text-[13px]"
          onClick={() => setErrorsOnly((value) => !value)}
        >
          <span
            className={cn(
              "h-5 w-5 rounded-[6px] border border-[#d8d6cf]",
              errorsOnly && "border-[#188038] bg-[#188038]",
            )}
          />
          Errors only
        </button>
        <button
          type="button"
          className="flex h-8 items-center gap-2 rounded-[6px] bg-[#f0efeb] px-3 text-[13px]"
          onClick={() => setAscending((value) => !value)}
        >
          Date
          <ChevronDown className={cn("h-4 w-4 transition-transform", !ascending && "rotate-180")} strokeWidth={1.5} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="min-w-[1120px]">
          <div className="grid h-[22px] grid-cols-[34px_174px_104px_58px_minmax(760px,1fr)] items-center border-b border-[#d8d6cf] bg-[#f3f2ee] font-mono text-[12px] text-[#272727]">
            <div className="pl-[6px]"><span className="block h-5 w-5 rounded-[5px] border border-[#d2cfc7] bg-[#f0efeb]" /></div>
            <div>Time ⓘ</div>
            <div>Deployment</div>
            <div>Source</div>
            <div>Log</div>
          </div>
          {collapsed ? null : filteredLogs.map((entry) => (
            <LogRow key={entry.id} entry={entry} colors={colors} wrap={wrap} />
          ))}
          {filteredLogs.length === 0 || collapsed ? (
            <div className="flex h-32 items-center justify-center border-b border-[#d8d6cf] font-mono text-[12px] text-[#6b6860]">
              {loading ? "Loading logs…" : collapsed ? "Logs collapsed" : `No logs for ${deploymentId}`}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between border-t border-[#d8d6cf] bg-[#f7f6f2] px-2 text-[13px]">
        <div className="flex items-center gap-3">
          <button type="button" className="flex items-center gap-1" onClick={() => setCollapsed((value) => !value)}>
            <span className="text-[16px]">↔</span>
            {collapsed ? "Expand" : "Collapse"}
          </button>
          <button type="button" className="flex items-center gap-1" onClick={() => setWrap((value) => !value)}>
            <span className={cn("h-4 w-4 rounded-[6px] border border-[#d8d6cf]", wrap && "bg-white")}>{wrap ? "✓" : ""}</span>
            ↩ Wrap
          </button>
          <button type="button" className="flex items-center gap-1" onClick={() => setColors((value) => !value)}>
            <span className={cn("flex h-4 w-4 items-center justify-center rounded-full border border-[#d8d6cf]", colors && "bg-white")}>
              {colors ? "✓" : ""}
            </span>
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[#393939] text-[10px]">🎨</span>
            Colors
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#2eaa58]" />
          Live
        </div>
      </div>
    </div>
  )
}

function LogRow({ entry, colors, wrap }: { entry: PublishingLogEntry; colors: boolean; wrap: boolean }) {
  const error = colors && entry.severity === "error"
  return (
    <div
      className={cn(
        "grid min-h-[25px] grid-cols-[34px_174px_104px_58px_minmax(760px,1fr)] items-center border-b border-[#d8d6cf] font-mono text-[12px]",
        error ? "bg-[#d99a95] text-black" : "bg-[#f7f6f2] text-[#1f1f1f]",
      )}
    >
      <div />
      <div className="px-1">{entry.time}</div>
      <div className="px-1">{entry.deployment}</div>
      <div className="px-1">{entry.source}</div>
      <div className={cn("px-1", wrap ? "whitespace-normal break-words py-1" : "truncate whitespace-nowrap")}>{entry.log}</div>
    </div>
  )
}

function DomainsTab({
  state,
  busyAction,
  onAction,
}: {
  state: PublishingConsoleState
  busyAction: PublishingActionId | null
  onAction: (action: PublishingActionId, options?: { domain?: PublishingDomain }) => Promise<void>
}) {
  return (
    <div className="min-h-0 flex-1 bg-[#f7f6f2] pt-[21px]">
      <div className="mx-auto w-[568px] max-w-[calc(100vw-32px)]">
        <div className="flex h-[42px] items-start justify-between">
          <h2 className="pt-[7px] text-[16px] font-semibold leading-none">Domains</h2>
          <div className="flex gap-2">
            <SmallOutlineButton onClick={() => onAction("buy-domain")} disabled={busyAction === "buy-domain"}>
              Buy a new domain
            </SmallOutlineButton>
            <SmallOutlineButton onClick={() => onAction("connect-domain")} disabled={busyAction === "connect-domain"}>
              Connect your own domain
            </SmallOutlineButton>
          </div>
        </div>

        <div className="mt-[14px] overflow-hidden rounded-[8px] border border-[#d8d6cf] bg-[#f0efeb]">
          <div className="grid h-[37px] grid-cols-[1fr_256px_88px] items-center border-b border-[#d8d6cf] px-3 text-[12px] text-[#2f2f2f]">
            <span>Name</span>
            <span>Registered With</span>
            <span />
          </div>
          {state.domains.map((domain, index) => (
            <div
              key={domain.host}
              className={cn(
                "grid min-h-[58px] grid-cols-[1fr_256px_88px] items-center px-3 text-[14px]",
                index > 0 && "border-t border-[#d8d6cf]",
              )}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{domain.host}</span>
                  {domain.warning ? <TriangleAlert className="h-3.5 w-3.5 text-[#ff7a00]" strokeWidth={1.8} /> : null}
                </div>
                {domain.verified ? (
                  <div className="mt-2 flex items-center gap-2 text-[12px] text-[#666]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#35b56a]" />
                    Verified
                  </div>
                ) : null}
              </div>
              <div className="text-[13px] text-[#707682]">{domain.registeredWith}</div>
              <button
                type="button"
                disabled={!domain.manageable || busyAction === "manage-domain"}
                className={cn(
                  "ml-auto inline-flex h-8 items-center gap-1.5 rounded-[6px] px-3 text-[12px]",
                  domain.manageable
                    ? "bg-[#f8f7f4] text-[#303030] hover:bg-white"
                    : "bg-[#e9e8e3] text-[#999] opacity-70",
                )}
                onClick={() => onAction("manage-domain", { domain })}
              >
                <Settings className="h-3.5 w-3.5" strokeWidth={1.6} />
                Manage
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ManageTab({
  state,
  busyAction,
  onAction,
  onBadgeChange,
}: {
  state: PublishingConsoleState
  busyAction: PublishingActionId | null
  onAction: (action: PublishingActionId, options?: { silent?: boolean }) => Promise<void>
  onBadgeChange: React.Dispatch<React.SetStateAction<PublishingConsoleState>>
}) {
  const toggleBadge = async () => {
    onBadgeChange((current) => ({ ...current, madeWithReplitBadge: !current.madeWithReplitBadge }))
    await onAction("toggle-badge", { silent: true })
  }

  return (
    <div className="min-h-0 flex-1 bg-[#f7f6f2] pt-[23px]">
      <div className="mx-auto w-[600px] max-w-[calc(100vw-32px)]">
        <h2 className="text-[16px] font-semibold leading-none">Manage published app</h2>
        <div className="mt-[15px]">
          <WideButton icon={Pause} onClick={() => onAction("pause")} disabled={busyAction === "pause"}>
            Pause
          </WideButton>
          <p className="mt-[13px] text-[14px] leading-none text-[#4a4d52]">
            Your billing will continue, but all users will lose access to your app
          </p>
        </div>

        <div className="mt-[27px]">
          <WideButton icon={SlidersHorizontal} onClick={() => onAction("change-deployment-type")}>
            Change deployment type
          </WideButton>
          <p className="mt-[13px] text-[14px] leading-none text-[#4a4d52]">
            To change your deployment type, you will need to unpublish and publish again.
          </p>
        </div>

        <div className="mt-[29px]">
          <WideButton danger icon={Trash2} onClick={() => onAction("shutdown")} disabled={busyAction === "shutdown"}>
            Shut down
          </WideButton>
          <p className="mt-[13px] text-[14px] leading-none text-[#4a4d52]">
            Your published app billing will be canceled, and it will cease to exist
          </p>
        </div>

        <h3 className="mt-[38px] text-[16px] font-semibold leading-none">Display settings</h3>
        <div className="mt-[17px] flex items-start justify-between gap-6">
          <div>
            <div className="text-[14px] leading-none">"Made with Replit" badge</div>
            <p className="mt-[10px] max-w-[505px] text-[12px] leading-[18px] text-[#4e535a]">
              Display a "Made with Replit" referral badge on your published app, when someone signs up using your
              referral link, you earn credits. <a className="text-[#006adc] hover:underline" href="https://replit.com/core" target="_blank" rel="noreferrer">Learn more.</a>
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={state.madeWithReplitBadge}
            className={cn(
              "relative mt-[-2px] h-6 w-[38px] rounded-full transition-colors",
              state.madeWithReplitBadge ? "bg-[#0d7ff9]" : "bg-[#c8c6bd]",
            )}
            onClick={() => void toggleBadge()}
          >
            <span
              className={cn(
                "absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-transform",
                state.madeWithReplitBadge ? "translate-x-[17px]" : "translate-x-[3px]",
              )}
            />
          </button>
        </div>

        <h3 className="mt-[36px] text-[16px] font-semibold leading-none">Publish on the go</h3>
        <WideButton className="mt-[15px]" icon={Smartphone} onClick={() => onAction("install-app")}>
          Install the Replit App
        </WideButton>
      </div>
    </div>
  )
}

function ReplitButton({
  children,
  icon: Icon,
  tone = "secondary",
  disabled,
  onClick,
}: {
  children: React.ReactNode
  icon?: LucideIcon
  tone?: "primary" | "secondary"
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-[6px] px-3 text-[14px] font-medium leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        tone === "primary" ? "bg-[#0d7ff9] text-white hover:bg-[#096fe0]" : "bg-[#efede8] text-[#1f1f1f] hover:bg-[#e7e5df]",
      )}
      onClick={onClick}
    >
      {Icon ? <Icon className="h-4 w-4" strokeWidth={1.7} /> : null}
      {children}
    </button>
  )
}

function SmallOutlineButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="h-8 rounded-[6px] border border-[#d8d6cf] bg-[#fbfaf7] px-3 text-[12px] leading-none hover:bg-white disabled:opacity-60"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function WideButton({
  children,
  icon: Icon,
  danger,
  className,
  disabled,
  onClick,
}: {
  children: React.ReactNode
  icon: LucideIcon
  danger?: boolean
  className?: string
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "flex h-8 w-full items-center justify-center gap-2 rounded-[6px] border text-[14px] leading-none disabled:opacity-60",
        danger ? "border-[#d2cfc7] bg-[#fbfaf7] hover:bg-white" : "border-transparent bg-[#efede8] hover:bg-[#e7e5df]",
        className,
      )}
      onClick={onClick}
    >
      <Icon className="h-4 w-4" strokeWidth={1.7} />
      {children}
    </button>
  )
}

async function copyText(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(`${label} copied`)
  } catch {
    toast.error("No se pudo copiar")
  }
}

function displayUrl(value: string): string {
  return value.replace(/^https?:\/\//i, "").replace(/\/+$/, "")
}
