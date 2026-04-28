"use client"

/**
 * CreatePanel — the left-side column on /design. Tabs (Prototype,
 * Slide deck, From template, Other) swap the form; each form
 * submits to designService.create() and navigates to /design/[id]
 * for the canvas experience.
 *
 * Mirrors Claude Design's layout but branded as siraGPT. The
 * "From template" tab is intentionally inert right now — templates
 * need a library to pick from, which is a follow-up; we keep the
 * tab so the UI matches reference screenshots while marking the
 * button as disabled.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { Plus, Palette, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  designService, type DesignKind, type DesignFidelity,
} from "@/lib/design-service"

type TabKey = "prototype" | "slide_deck" | "template" | "other"

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "prototype",  label: "Prototype" },
  { key: "slide_deck", label: "Slide deck" },
  { key: "template",   label: "From template" },
  { key: "other",      label: "Other" },
]

export function CreatePanel() {
  const router = useRouter()
  const [tab, setTab] = React.useState<TabKey>("prototype")
  const [name, setName] = React.useState("")
  const [fidelity, setFidelity] = React.useState<DesignFidelity>("high")
  const [speakerNotes, setSpeakerNotes] = React.useState(false)
  const [creating, setCreating] = React.useState(false)

  async function submit() {
    if (!name.trim()) { toast.error("Project name required"); return }
    if (tab === "template") {
      toast.info("Plantillas · próximamente")
      return
    }
    setCreating(true)
    try {
      const kind: DesignKind =
        tab === "prototype"  ? "prototype"  :
        tab === "slide_deck" ? "slide_deck" :
        "other"
      const design = await designService.create({
        name: name.trim(),
        kind,
        fidelity: kind === "prototype" ? fidelity : undefined,
        speakerNotes: kind === "slide_deck" ? speakerNotes : undefined,
      })
      router.push(`/design/${design.id}`)
    } catch (err: any) {
      toast.error(err?.message || "Could not create design")
      setCreating(false)
    }
  }

  return (
    <div className="w-full lg:w-80 shrink-0 space-y-4">
      {/* Brand header */}
      <header className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#C05621]/12 text-[#C05621]">
          <Palette className="h-4 w-4" />
        </div>
        <div className="leading-tight">
          <div className="flex items-center gap-2">
            <span className="text-lg font-serif tracking-tight">siraGPT Diseño</span>
            <span className="text-[10px] uppercase tracking-wider rounded-md border border-border/60 px-1.5 py-0.5 text-muted-foreground">
              Research preview
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">by siraGPT Labs</div>
        </div>
      </header>

      {/* Tabs */}
      <div className="rounded-xl border border-border/60 bg-card">
        <nav className="flex gap-4 px-4 pt-3 text-sm border-b border-border/60">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "relative pb-3 transition-colors",
                tab === t.key ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              <span
                className={cn(
                  "absolute inset-x-0 -bottom-px h-0.5 origin-center bg-foreground transition-transform duration-150 ease-out",
                  tab === t.key ? "scale-x-100" : "scale-x-0",
                )}
              />
            </button>
          ))}
        </nav>

        <div className="p-4 space-y-3">
          <h2 className="text-sm font-semibold">
            {tab === "prototype"  && "New prototype"}
            {tab === "slide_deck" && "New slide deck"}
            {tab === "template"   && "Start from a template"}
            {tab === "other"      && "New project"}
          </h2>

          <div>
            <Label htmlFor="dz-name" className="text-xs">Project name</Label>
            <Input
              id="dz-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              maxLength={120}
              disabled={creating}
              className="mt-1 h-9 text-sm"
              onKeyDown={(e) => { if (e.key === "Enter") submit() }}
            />
          </div>

          {tab === "prototype" && (
            <FidelityPicker value={fidelity} onChange={setFidelity} disabled={creating} />
          )}

          {tab === "slide_deck" && (
            <div className="flex items-start justify-between gap-3 py-1">
              <div className="leading-tight">
                <div className="text-xs font-medium">Use speaker notes</div>
                <div className="text-[11px] text-muted-foreground">Less text on slides</div>
              </div>
              <Switch checked={speakerNotes} onCheckedChange={setSpeakerNotes} disabled={creating} />
            </div>
          )}

          {tab === "template" && (
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
              <div className="flex items-start gap-2">
                <span className="mt-1 h-2 w-2 rounded-full bg-muted-foreground/40" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">Animation</div>
                  <div className="text-[11px] text-muted-foreground">Timeline-based motion design</div>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">
                La librería de plantillas llegará pronto.
              </p>
            </div>
          )}

          <Button
            onClick={submit}
            disabled={creating || (tab !== "template" && !name.trim())}
            className={cn(
              "w-full gap-1.5 mt-1",
              tab === "template" && "opacity-50 cursor-not-allowed",
            )}
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {tab === "template" ? "Create from template" : "Create"}
          </Button>

          <p className="text-[11px] text-muted-foreground text-center pt-1">
            Only you can see your project by default.
          </p>
        </div>
      </div>

      {/* Design-system card (stub) */}
      <div className="rounded-xl border border-border/60 bg-card p-4">
        <p className="text-xs leading-relaxed text-foreground/80">
          Create a design system so anyone can create good-looking designs and assets.
        </p>
        <Button
          onClick={() => toast.info("Design systems · próximamente")}
          className="mt-3 w-full bg-[#C05621] hover:bg-[#A8481C] text-white"
        >
          Set up design system
        </Button>
      </div>

      {/* Footer pills */}
      <div className="flex flex-wrap gap-1.5">
        <FooterPill
          onClick={() => router.push("/design/docs")}
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 11h8M8 15h5" /></svg>}
        >
          Docs
        </FooterPill>
        <FooterPill
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3"><circle cx="12" cy="8" r="3" /><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" /></svg>}
        >
          My organization
        </FooterPill>
      </div>
    </div>
  )
}

// ─── Fidelity picker (prototype tab only) ─────────────────────────────────

function FidelityPicker({
  value, onChange, disabled,
}: {
  value: DesignFidelity
  onChange: (v: DesignFidelity) => void
  disabled?: boolean
}) {
  const Card = ({
    v, label, children,
  }: { v: DesignFidelity; label: string; children: React.ReactNode }) => (
    <button
      type="button"
      onClick={() => !disabled && onChange(v)}
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border-2 p-3 transition-all",
        value === v
          ? "border-[#C05621] bg-[#C05621]/5"
          : "border-border/60 hover:border-foreground/30",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <div className="h-16 w-full rounded-md bg-muted flex items-center justify-center overflow-hidden">
        {children}
      </div>
      <span className="text-xs font-medium">{label}</span>
    </button>
  )
  return (
    <div className="grid grid-cols-2 gap-2">
      <Card v="wireframe" label="Wireframe">
        <svg viewBox="0 0 48 32" className="h-full">
          <rect x="3" y="3" width="42" height="3" rx="1" fill="#d4d4d4" />
          <rect x="3" y="9" width="24" height="2" rx="1" fill="#e5e5e5" />
          <rect x="3" y="13" width="18" height="2" rx="1" fill="#e5e5e5" />
          <circle cx="6" cy="21" r="2.5" fill="#e5e5e5" />
          <rect x="11" y="19" width="12" height="2" rx="1" fill="#e5e5e5" />
          <rect x="11" y="23" width="20" height="2" rx="1" fill="#e5e5e5" />
        </svg>
      </Card>
      <Card v="high" label="High fidelity">
        <svg viewBox="0 0 48 32" className="h-full">
          <rect x="3" y="3" width="42" height="3" rx="1" fill="#5A5348" />
          <rect x="3" y="9" width="20" height="2" rx="1" fill="#8C7B66" />
          <rect x="3" y="13" width="15" height="2" rx="1" fill="#C8B89C" />
          <rect x="28" y="9" width="16" height="16" rx="2" fill="#C05621" fillOpacity="0.8" />
          <rect x="3" y="21" width="22" height="4" rx="2" fill="#1A1918" />
        </svg>
      </Card>
    </div>
  )
}

// ─── Footer pill ───────────────────────────────────────────────────────────

function FooterPill({
  onClick, icon, children,
}: {
  onClick?: () => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  const content = (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground bg-muted/50 rounded-full px-2.5 py-1">
      {icon}
      {children}
    </span>
  )
  if (onClick) {
    return (
      <button onClick={onClick} className="hover:opacity-80 transition-opacity">
        {content}
      </button>
    )
  }
  return content
}
