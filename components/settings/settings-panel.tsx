"use client"

// ────────────────────────────────────────────────────────────
// SettingsPanel — the full settings experience (nav + content),
// reusable in two shapes:
//   • variant="page"  → the /settings route (full screen, URL-synced)
//   • variant="modal" → a floating Claude-style dialog opened from the
//                       sidebar "Configuración" menu item.
// All section logic + persistence (settings-context auto-save) is shared;
// only the surrounding chrome differs per variant.
// ────────────────────────────────────────────────────────────

import React from "react"
import Link from "next/link"
import { useAuth } from "@/lib/auth-context-integrated"
import { useSettings } from "@/lib/settings-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Card } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { DialogTitle, DialogDescription } from "@/components/ui/dialog"
import {
  ArrowLeft, Sliders, Brain, Bell, Sparkles, Plug, Clock, Database,
  ShieldCheck, UserCircle2, Star, Check, Monitor, Moon, MoonStar, Sun,
  LogOut, Download, Trash2, Github, Globe, Linkedin, Mail,
  ExternalLink, Search as SearchIcon, Camera, Plus,
  AlertTriangle, Laptop} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { apiClient } from "@/lib/api"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { useRouter as useNextRouter } from "next/navigation"
import { LOCALES } from "@/lib/i18n/locales"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { MemorySettingsCard } from "@/components/settings/MemorySettingsCard"
import { McpServersCard } from "@/components/settings/McpServersCard"

// ────────────────────────────────────────────────────────────
// Section registry
// ────────────────────────────────────────────────────────────
export type SectionKey =
  | "general" | "models" | "notifications" | "personalization" | "apps"
  | "schedules" | "data" | "security" | "account"

// Section metadata; labels and descriptions come from next-intl at
// render time so a language switch flips the nav instantly.
const SECTION_KEYS = [
  { key: "general" as const,         icon: Sliders,     keywords: "theme accent font size density language region voice audio accessibility" },
  { key: "models" as const,          icon: Brain,       keywords: "modelo default openai gemini anthropic openrouter favorito" },
  { key: "notifications" as const,   icon: Bell,        keywords: "notificaciones push email toast sonido escritorio horas silenciosas" },
  { key: "personalization" as const, icon: Sparkles,    keywords: "personalizar estilo tono memoria instrucciones voz lienzo busqueda" },
  { key: "apps" as const,            icon: Plug,        keywords: "apps conectores gmail drive calendar slack github notion canva figma whatsapp" },
  { key: "schedules" as const,       icon: Clock,       keywords: "programar schedule cron tarea" },
  { key: "data" as const,            icon: Database,    keywords: "datos privacidad historial archivo borrar exportar descargar politica" },
  { key: "security" as const,        icon: ShieldCheck, keywords: "seguridad mfa 2fa sesion dispositivos contraseña" },
  { key: "account" as const,         icon: UserCircle2, keywords: "cuenta perfil nombre avatar foto constructor gpt sitio linkedin github" },
]

type Variant = "page" | "modal"

export function SettingsPanel({
  variant = "page",
  initialSection = "general",
  onSectionChange,
}: {
  variant?: Variant
  initialSection?: SectionKey
  onSectionChange?: (s: SectionKey) => void
}) {
  const t = useTranslations("settings")
  const { user } = useAuth()
  const [section, setSection] = React.useState<SectionKey>(initialSection)
  const [query, setQuery] = React.useState("")

  // Compose sections from key + i18n labels so a language swap flips
  // the nav instantly without re-mounting.
  const SECTIONS = React.useMemo(() =>
    SECTION_KEYS.map((s) => ({
      key: s.key,
      icon: s.icon,
      keywords: s.keywords,
      label: t(`sections.${s.key}.label`),
      desc: t(`sections.${s.key}.desc`),
    })),
    [t],
  )

  const changeSection = React.useCallback((s: SectionKey) => {
    setSection(s)
    onSectionChange?.(s)
  }, [onSectionChange])

  if (!user) return null

  const filteredSections = query.trim()
    ? SECTIONS.filter((s) => {
        const q = query.trim().toLowerCase()
        return s.label.toLowerCase().includes(q)
          || s.desc.toLowerCase().includes(q)
          || s.keywords.toLowerCase().includes(q)
      })
    : SECTIONS

  // Shared left-nav: search box + section buttons (identical in both variants)
  const nav = (
    <div className="space-y-3">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="pl-9 h-9"
        />
      </div>
      <nav className="flex flex-col gap-1">
        {filteredSections.map((s) => {
          const Icon = s.icon
          const active = s.key === section
          return (
            <button
              key={s.key}
              onClick={() => changeSection(s.key)}
              className={cn(
                "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all duration-150",
                active ? "bg-primary/10 text-primary" : "hover:bg-muted/40",
              )}
            >
              <span className={cn(
                "h-8 w-8 rounded-md grid place-items-center transition-colors shrink-0",
                active ? "bg-primary text-primary-foreground" : "bg-muted text-foreground/70",
              )}>
                <Icon className="h-4 w-4" />
              </span>
              <div className="flex-1 min-w-0">
                <div className={cn("text-sm font-medium truncate", active ? "text-primary" : "text-foreground")}>{s.label}</div>
                <div className="text-xs text-muted-foreground truncate">{s.desc}</div>
              </div>
            </button>
          )
        })}
        {filteredSections.length === 0 && (
          <div className="text-xs text-muted-foreground px-3 py-4">{t("noResults")} · "{query}"</div>
        )}
      </nav>
    </div>
  )

  // Shared content: the active section
  const content = (
    <>
      {section === "general" && <GeneralSection />}
      {section === "models" && <ModelsSection />}
      {section === "notifications" && <NotificationsSection />}
      {section === "personalization" && <PersonalizationSection />}
      {section === "apps" && <AppsSection />}
      {section === "schedules" && <SchedulesSection />}
      {section === "data" && <DataControlsSection />}
      {section === "security" && <SecuritySection />}
      {section === "account" && <AccountSection />}
    </>
  )

  // ── Modal variant — floating Claude-style dialog body ──
  if (variant === "modal") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {/*
          Responsive layout is driven by a scoped <style> with real media
          queries rather than Tailwind md:/lg: utilities. This project ships a
          CURATED (non-JIT) Tailwind build, so freshly-added responsive
          utilities like `md:w-52` / `md:flex-col` aren't guaranteed to exist
          in the compiled CSS (same reason home-page.tsx / settings-dialog.tsx
          inline their dimensions). Raw CSS keeps the breakpoints deterministic.

          On phones the panel is ~360px wide, so the old fixed 208px side rail
          crushed content into a ~150px column. We STACK on mobile — search +
          a horizontally-scrolling strip of section chips on top, content below
          — and switch to the two-pane left-rail layout only at ≥768px.
        */}
        <style
          dangerouslySetInnerHTML={{
            __html: [
              ".set-modal-body{display:flex;flex:1 1 0%;min-height:0;flex-direction:column}",
              ".set-modal-aside{flex-shrink:0;padding:0.75rem;border-bottom:1px solid hsl(var(--border)/0.6)}",
              ".set-modal-nav{display:flex;gap:0.25rem;overflow-x:auto;padding-bottom:0.25rem;-webkit-overflow-scrolling:touch}",
              ".set-nav-item{flex-shrink:0}",
              ".set-nav-textwrap{min-width:0}",
              ".set-nav-label{white-space:nowrap}",
              ".set-nav-desc{display:none}",
              ".set-modal-content{flex:1 1 0%;min-width:0;overflow-y:auto}",
              "@media(min-width:768px){",
              ".set-modal-body{flex-direction:row}",
              ".set-modal-aside{width:13rem;border-bottom:none;border-right:1px solid hsl(var(--border)/0.6);overflow-y:auto}",
              ".set-modal-nav{flex-direction:column;overflow-x:visible;padding-bottom:0}",
              ".set-nav-item{flex-shrink:1}",
              ".set-nav-textwrap{flex:1 1 0%}",
              ".set-nav-label{white-space:normal}",
              ".set-nav-desc{display:block}",
              "}",
              "@media(min-width:1024px){.set-modal-aside{width:15rem}}",
            ].join(""),
          }}
        />
        {/* Header — title + live save status (X close is provided by DialogContent) */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border/60 pr-14">
          <div className="min-w-0">
            <DialogTitle className="text-lg font-semibold tracking-tight">{t("title")}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground mt-0.5">{t("subtitle")}</DialogDescription>
          </div>
          <div className="pt-1 shrink-0"><SaveIndicator /></div>
        </div>
        <div className="set-modal-body">
          <aside className="set-modal-aside">
            <div className="relative mb-3">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("searchPlaceholder")}
                className="pl-9 h-9"
              />
            </div>
            <nav className="set-modal-nav">
              {filteredSections.map((s) => {
                const Icon = s.icon
                const active = s.key === section
                return (
                  <button
                    key={s.key}
                    onClick={() => changeSection(s.key)}
                    className={cn(
                      "set-nav-item group flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors",
                      active ? "bg-primary/10 text-primary" : "hover:bg-muted/40",
                    )}
                  >
                    <span className={cn(
                      "h-8 w-8 rounded-md grid place-items-center transition-colors shrink-0",
                      active ? "bg-primary text-primary-foreground" : "bg-muted text-foreground/70",
                    )}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="set-nav-textwrap">
                      <div className={cn("set-nav-label text-sm font-medium truncate", active ? "text-primary" : "text-foreground")}>{s.label}</div>
                      <div className="set-nav-desc text-xs text-muted-foreground truncate">{s.desc}</div>
                    </div>
                  </button>
                )
              })}
              {filteredSections.length === 0 && (
                <div className="text-xs text-muted-foreground px-3 py-4">{t("noResults")} · "{query}"</div>
              )}
            </nav>
          </aside>
          <section className="set-modal-content p-5 space-y-6">
            {content}
          </section>
        </div>
      </div>
    )
  }

  // ── Page variant — full-screen /settings route ──
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1240px] mx-auto px-4 py-6">
        {/* Top bar — back + save indicator */}
        <div className="flex items-center justify-between mb-6">
          <Link href="/chat">
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
              {t("backToChat")}
            </Button>
          </Link>
          <SaveIndicator />
        </div>

        {/* Page header */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground">{t("subtitle")}</p>
        </div>

        <div className="grid grid-cols-12 gap-6">
          {/* Left nav with built-in search */}
          <aside className="col-span-12 md:col-span-4 lg:col-span-3">
            <div className="sticky top-6">{nav}</div>
          </aside>

          {/* Content */}
          <section className="col-span-12 md:col-span-8 lg:col-span-9 space-y-6">
            {content}
          </section>
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// Save indicator — reads saveStatus from context and renders a
// tight 3-state badge (idle / saving / saved) + a "hace Xs"
// timestamp that self-refreshes every 10s.
// ────────────────────────────────────────────────────────────
function SaveIndicator() {
  const t = useTranslations("settings")
  const { saveStatus, savedAt } = useSettings()
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 10000)
    return () => clearInterval(id)
  }, [])
  void tick

  const agoLabel = React.useMemo(() => {
    if (!savedAt) return null
    const s = Math.max(1, Math.floor((Date.now() - savedAt) / 1000))
    if (s < 60) return `hace ${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `hace ${m} min`
    return `hace ${Math.floor(m / 60)} h`
  }, [savedAt, tick]) // eslint-disable-line react-hooks/exhaustive-deps

  if (saveStatus === 'saving') {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ThinkingIndicator size="xs" />
        {t("saving")}
      </div>
    )
  }
  if (saveStatus === 'error') {
    return (
      <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-3 w-3" />
        {t("offline")}
      </div>
    )
  }
  if (saveStatus === 'saved' || savedAt) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {t("saved")} {agoLabel}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
      {t("autoSync")}
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// Shared primitives
// ────────────────────────────────────────────────────────────

function SectionCard({ title, desc, children, action }: { title: string; desc?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Card className="border-border/60 shadow-sm">
      <div className="p-5 border-b border-border/60 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {desc && <p className="text-sm text-muted-foreground mt-0.5">{desc}</p>}
        </div>
        {action}
      </div>
      <div className="divide-y divide-border/60">{children}</div>
    </Card>
  )
}

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-5">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {desc && <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

function SwitchRow({ title, desc, checked, onChange }: { title: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row title={title} desc={desc}>
      <Switch checked={checked} onCheckedChange={onChange} />
    </Row>
  )
}

/**
 * Interface-language picker with all 60 supported locales by native
 * name. Sets the NEXT_LOCALE cookie (year-long) and reloads so the
 * SSR-rendered messages swap on the next paint. Also mirrors the choice
 * into settings.interfaceLanguage so the backend sees the user's
 * explicit preference on top of the cookie.
 */
function InterfaceLanguageRow() {
  const t = useTranslations("settings.general")
  const { settings, update } = useSettings()
  const router = useNextRouter()

  const onChange = (code: string) => {
    try {
      document.cookie = `NEXT_LOCALE=${code}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
    } catch { /* cookies disabled — provider still reads settings */ }
    update({ interfaceLanguage: code })
    // next-intl's messages are resolved server-side; a hard reload is
    // the only way to swap them instantly without a full <Suspense>
    // refactor. router.refresh() is enough to re-fetch the server tree.
    setTimeout(() => router.refresh(), 50)
  }

  return (
    <Row title={t("interfaceLanguage")}>
      <Select value={settings.interfaceLanguage} onValueChange={onChange}>
        <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
        <SelectContent className="max-h-[360px]">
          {LOCALES.map((l) => (
            <SelectItem key={l.code} value={l.code}>
              {l.name}
              <span className="text-xs text-muted-foreground ml-2">{l.code.toUpperCase()}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  )
}

function SelectRow({ title, desc, value, onChange, options, width = "w-[200px]" }: {
  title: string; desc?: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; width?: string
}) {
  return (
    <Row title={title} desc={desc}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className={width}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Row>
  )
}

// ────────────────────────────────────────────────────────────
// GENERAL — visual pickers for theme, accent, font size, density
// ────────────────────────────────────────────────────────────

const THEME_PREVIEWS = [
  { value: 'light',    label: 'Light',     icon: Sun,      bg: 'bg-white',               ring: 'ring-zinc-300',  dot: 'bg-zinc-900' },
  { value: 'dark',     label: 'Dark',      icon: Moon,     bg: 'bg-zinc-900',            ring: 'ring-zinc-600',  dot: 'bg-white' },
  { value: 'midnight', label: 'Midnight',  icon: MoonStar, bg: 'bg-black',               ring: 'ring-zinc-800',  dot: 'bg-zinc-200' },
  { value: 'system',   label: 'System',    icon: Monitor,  bg: 'bg-gradient-to-br from-white to-zinc-900', ring: 'ring-zinc-400', dot: 'bg-zinc-500' },
] as const

const ACCENT_SWATCHES = [
  { value: 'default', label: 'Default',color: '#18181b' },
  { value: 'blue',    label: 'Blue',   color: '#2563eb' },
  { value: 'green',   label: 'Green',  color: '#16a34a' },
  { value: 'purple',  label: 'Purple', color: '#9333ea' },
  { value: 'orange',  label: 'Orange', color: '#f97316' },
  { value: 'red',     label: 'Red',    color: '#dc2626' },
] as const

const FONT_SIZE_PREVIEWS = [
  { value: 'small',  label: 'Small',  size: 'text-sm',  letter: 'text-base' },
  { value: 'medium', label: 'Medium', size: 'text-base', letter: 'text-lg' },
  { value: 'large',  label: 'Large',  size: 'text-lg',  letter: 'text-xl' },
] as const

const DENSITY_PREVIEWS = [
  { value: 'compact',     label: 'Compact',     gap: 'gap-[3px]', rowH: 'h-1' },
  { value: 'comfortable', label: 'Comfortable', gap: 'gap-[6px]', rowH: 'h-1.5' },
  { value: 'spacious',    label: 'Spacious',    gap: 'gap-[10px]',rowH: 'h-2' },
] as const

// Shared with the header ThemeToggle: "Midnight" is an OLED dark flavour
// tracked by this localStorage flag + the `.midnight` class (CSS scoped to
// `.dark.midnight`); the boot script in app/layout.tsx applies it before
// first paint. Keeping the same mechanism here keeps the settings picker and
// the header toggle perfectly in sync.
const MIDNIGHT_KEY = "sira-theme-midnight"
const MIDNIGHT_EVENT = "sira:midnight"

function readMidnightFlag(): boolean {
  try { return localStorage.getItem(MIDNIGHT_KEY) === "1" } catch { return false }
}

function GeneralSection() {
  const { settings, update } = useSettings()
  const { theme: ntTheme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  const [isMidnight, setIsMidnight] = React.useState(false)
  React.useEffect(() => {
    setMounted(true)
    setIsMidnight(readMidnightFlag())
    // Stay in sync when midnight is toggled from the header ThemeToggle or
    // another tab.
    const sync = () => setIsMidnight(readMidnightFlag())
    const onStorage = (e: StorageEvent) => { if (e.key === MIDNIGHT_KEY) sync() }
    window.addEventListener(MIDNIGHT_EVENT, sync)
    window.addEventListener("storage", onStorage)
    return () => {
      window.removeEventListener(MIDNIGHT_EVENT, sync)
      window.removeEventListener("storage", onStorage)
    }
  }, [])

  // The active card reflects the *live* applied theme (next-themes + the
  // midnight flag), so it updates even when the theme is changed from the
  // header toggle. Falls back to the persisted setting before mount (SSR-safe).
  const activeTheme = !mounted
    ? settings.theme
    : isMidnight ? "midnight" : (ntTheme || settings.theme)

  const pickTheme = (value: string) => {
    const midnight = value === "midnight"
    try {
      if (midnight) localStorage.setItem(MIDNIGHT_KEY, "1")
      else localStorage.removeItem(MIDNIGHT_KEY)
    } catch { /* storage off — class still applies for the session */ }
    document.documentElement.classList.toggle("midnight", midnight)
    try { window.dispatchEvent(new Event(MIDNIGHT_EVENT)) } catch { /* noop */ }
    setIsMidnight(midnight)
    // Midnight is dark + the flag; everything else maps straight through.
    setTheme(midnight ? "dark" : value)
    update({ theme: (midnight ? "dark" : value) as any })
  }

  return (
    <>
      {/* Minimalist top group — mirrors Claude's "General": language, style
          and response speed as three clean rows. All wired to real,
          auto-saved settings. */}
      <SectionCard title="General">
        <InterfaceLanguageRow />
        <SelectRow
          title="Estilo"
          desc="Cómo se comunica siraGPT contigo"
          value={settings.baseStyle}
          onChange={(v) => update({ baseStyle: v as any, preferredTone: v === "default" ? null : v })}
          options={[
            { value: "default", label: "Predeterminado" },
            { value: "formal", label: "Formal" },
            { value: "casual", label: "Casual" },
            { value: "technical", label: "Técnico" },
            { value: "academic", label: "Académico" },
          ]}
        />
        <SelectRow
          title="Velocidad"
          desc="Equilibrio entre rapidez y profundidad de las respuestas"
          value={settings.responseSpeed}
          onChange={(v) => update({ responseSpeed: v as any })}
          options={[
            { value: "fast", label: "Rápida" },
            { value: "normal", label: "Normal" },
            { value: "thorough", label: "Reflexiva" },
          ]}
        />
      </SectionCard>

      <SectionCard title="Display" desc="Apariencia visual de la aplicación">
        {/* Theme — 3 visual cards */}
        <div className="p-5">
          <div className="mb-3">
            <div className="text-sm font-medium">Theme</div>
            <div className="text-xs text-muted-foreground">Claro, oscuro, medianoche o el del sistema</div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {THEME_PREVIEWS.map(({ value, label, icon: Icon, bg, ring, dot }) => {
              const active = activeTheme === value
              return (
                <button
                  key={value}
                  onClick={() => pickTheme(value)}
                  className={cn(
                    "relative rounded-xl border-2 overflow-hidden transition-all",
                    active ? "border-primary ring-2 ring-primary/20" : "border-border hover:border-border/80",
                  )}
                >
                  <div className={cn("h-20 relative", bg, "ring-1", ring)}>
                    <div className="absolute top-2 left-2 h-4 w-4 rounded-full bg-background/90 grid place-items-center">
                      <span className={cn("h-2 w-2 rounded-full", dot)} />
                    </div>
                    <div className="absolute bottom-2 left-2 right-2 space-y-1">
                      <div className="h-1.5 w-2/3 rounded bg-background/40" />
                      <div className="h-1.5 w-1/2 rounded bg-background/25" />
                    </div>
                    {active && (
                      <div className="absolute top-1.5 right-1.5 h-5 w-5 rounded-full bg-primary text-primary-foreground grid place-items-center">
                        <Check className="h-3 w-3" />
                      </div>
                    )}
                  </div>
                  <div className="p-2 flex items-center justify-center gap-1.5 text-xs font-medium">
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Accent — 6 circular swatches */}
        <div className="p-5">
          <div className="mb-3">
            <div className="text-sm font-medium">Accent color</div>
            <div className="text-xs text-muted-foreground">Color primario usado en botones y acentos</div>
          </div>
          <div className="flex flex-wrap gap-3">
            {ACCENT_SWATCHES.map((a) => {
              const active = settings.accent === a.value
              return (
                <button
                  key={a.value}
                  onClick={() => update({ accent: a.value as any })}
                  title={a.label}
                  aria-label={a.label}
                  className={cn(
                    "relative h-10 w-10 rounded-full transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-background",
                    active && "ring-2 ring-offset-2 ring-offset-background ring-foreground",
                  )}
                  style={{ backgroundColor: a.color }}
                >
                  {active && <Check className="h-4 w-4 text-white absolute inset-0 m-auto drop-shadow" />}
                </button>
              )
            })}
          </div>
        </div>

        {/* Font size — 3 cards with visual scale */}
        <div className="p-5">
          <div className="mb-3">
            <div className="text-sm font-medium">Font size</div>
            <div className="text-xs text-muted-foreground">Tamaño base de la tipografía</div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {FONT_SIZE_PREVIEWS.map(({ value, label, size, letter }) => {
              const active = settings.fontSize === value
              return (
                <button
                  key={value}
                  onClick={() => update({ fontSize: value as any })}
                  className={cn(
                    "rounded-xl border-2 p-4 text-center transition-all flex flex-col items-center gap-1",
                    active ? "border-primary ring-2 ring-primary/20" : "border-border hover:border-border/80",
                  )}
                >
                  <span className={cn("font-bold leading-none", letter)}>Aa</span>
                  <span className={cn("text-xs font-medium text-muted-foreground", size)}>{label}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Density — 3 cards with visual row heights */}
        <div className="p-5">
          <div className="mb-3">
            <div className="text-sm font-medium">Density</div>
            <div className="text-xs text-muted-foreground">Espaciado vertical de la UI</div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {DENSITY_PREVIEWS.map(({ value, label, gap, rowH }) => {
              const active = settings.density === value
              return (
                <button
                  key={value}
                  onClick={() => update({ density: value as any })}
                  className={cn(
                    "rounded-xl border-2 p-3 text-left transition-all",
                    active ? "border-primary ring-2 ring-primary/20" : "border-border hover:border-border/80",
                  )}
                >
                  <div className={cn("flex flex-col", gap)}>
                    <div className={cn("rounded bg-muted-foreground/25", rowH, "w-full")} />
                    <div className={cn("rounded bg-muted-foreground/25", rowH, "w-5/6")} />
                    <div className={cn("rounded bg-muted-foreground/25", rowH, "w-4/6")} />
                    <div className={cn("rounded bg-muted-foreground/25", rowH, "w-3/6")} />
                  </div>
                  <div className="text-xs font-medium mt-3 text-center">{label}</div>
                </button>
              )
            })}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Language & region" desc="Formato de fecha, zona horaria e idioma">
        <SelectRow
          title="Spoken language"
          desc="Para reconocimiento de voz"
          value={settings.spokenLanguage}
          onChange={(v) => update({ spokenLanguage: v })}
          options={[
            { value: "auto", label: "Automatic" },
            { value: "es", label: "Español" },
            { value: "en", label: "English" },
            { value: "pt", label: "Português" },
            { value: "fr", label: "Français" },
          ]}
        />
        <SelectRow
          title="Date format"
          value={settings.dateFormat}
          onChange={(v) => update({ dateFormat: v })}
          options={[
            { value: "YYYY-MM-DD", label: "AAAA-MM-DD" },
            { value: "DD/MM/YYYY", label: "DD/MM/YYYY" },
            { value: "MM/DD/YYYY", label: "MM/DD/YYYY" },
          ]}
        />
        <Row title="Time zone" desc="Detectada automáticamente">
          <Input value={settings.timeZone} onChange={(e) => update({ timeZone: e.target.value })} className="w-[240px] h-9" />
        </Row>
        <SelectRow
          title="Time format"
          value={settings.timeFormat}
          onChange={(v) => update({ timeFormat: v as any })}
          options={[{ value: "12h", label: "12-hour" }, { value: "24h", label: "24-hour" }]}
        />
      </SectionCard>

      <SectionCard title="Voz y audio">
        <SelectRow
          title="Voz del asistente"
          value={settings.assistantVoice}
          onChange={(v) => update({ assistantVoice: v })}
          options={[
            { value: "cove", label: "Cove" },
            { value: "sage", label: "Sage" },
            { value: "ember", label: "Ember" },
            { value: "breeze", label: "Breeze" },
          ]}
        />
        <SwitchRow
          title="Reproducir respuestas automáticamente"
          desc="Lee las respuestas en voz alta"
          checked={settings.autoPlayReplies}
          onChange={(v) => update({ autoPlayReplies: v })}
        />
        <SwitchRow
          title="Modo de voz independiente"
          desc="Pantalla completa sin elementos visuales"
          checked={settings.standaloneVoiceMode}
          onChange={(v) => update({ standaloneVoiceMode: v })}
        />
      </SectionCard>

      <SectionCard title="Modelos de IA">
        <SwitchRow
          title="Mostrar modelos adicionales"
          desc="Ver todos los modelos disponibles"
          checked={settings.showAdditionalModels}
          onChange={(v) => update({ showAdditionalModels: v })}
        />
        <SwitchRow
          title="Transmitir respuestas"
          desc="Ver las respuestas mientras se generan"
          checked={settings.streamResponses}
          onChange={(v) => update({ streamResponses: v })}
        />
      </SectionCard>

      <SectionCard title="Accesibilidad">
        <SwitchRow
          title="Atajos de teclado"
          desc="Habilitar navegación con teclado"
          checked={settings.keyboardShortcuts}
          onChange={(v) => update({ keyboardShortcuts: v })}
        />
        <SwitchRow
          title="Reducir movimiento"
          desc="Minimizar animaciones en toda la app"
          checked={settings.reducedMotion}
          onChange={(v) => update({ reducedMotion: v })}
        />
        <SwitchRow
          title="Alto contraste"
          desc="Mejorar visibilidad de elementos"
          checked={settings.highContrast}
          onChange={(v) => update({ highContrast: v })}
        />
      </SectionCard>
    </>
  )
}

// ────────────────────────────────────────────────────────────
// MODELOS AI
// ────────────────────────────────────────────────────────────

function ModelsSection() {
  const { settings, update } = useSettings()
  const [models, setModels] = React.useState<any[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
    const base = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"
    fetch(`${base}/ai/models?type=TEXT`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      .then((r) => r.ok ? r.json() : { models: [] })
      .then((d) => setModels(d.models || []))
      .catch(() => setModels([]))
      .finally(() => setLoading(false))
  }, [])

  const byProvider = React.useMemo(() => {
    const groups: Record<string, any[]> = {}
    for (const m of models) (groups[m.provider || "Other"] ??= []).push(m)
    const order = ["OpenAI", "Anthropic", "Google", "Gemini", "xAI", "OpenRouter"]
    return Object.fromEntries(
      Object.entries(groups).sort(([a], [b]) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b))),
    )
  }, [models])

  const toggleFav = (name: string) => {
    const next = settings.favoriteModels.includes(name)
      ? settings.favoriteModels.filter((x) => x !== name)
      : [...settings.favoriteModels, name]
    update({ favoriteModels: next })
  }

  const current = models.find((m) => m.name === settings.defaultModel) || models[0]

  return (
    <>
      <div className="text-sm text-muted-foreground">
        Explora los modelos disponibles, marca favoritos y configura tu modelo predeterminado.
      </div>

      <SectionCard title="Modelo predeterminado" desc="Se usa cuando abres un chat nuevo">
        <Row title={current?.displayName || "Sin seleccionar"} desc={current?.provider ? `${current.provider} · ${current.name}` : "—"}>
          <Badge variant="secondary" className="gap-1"><Check className="h-3 w-3" />Por defecto</Badge>
        </Row>
      </SectionCard>

      {loading ? (
        <Card className="p-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
          <ThinkingIndicator size="sm" />Cargando modelos…
        </Card>
      ) : (
        Object.entries(byProvider).map(([provider, list]) => (
          <SectionCard key={provider} title={provider} desc={`${list.length} modelo(s)`}>
            {list.slice(0, 60).map((m) => (
              <Row key={m.id} title={m.displayName || m.name} desc={m.description || m.name}>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost" size="icon" className="h-8 w-8"
                    onClick={() => toggleFav(m.name)}
                    title={settings.favoriteModels.includes(m.name) ? "Quitar de favoritos" : "Marcar favorito"}
                  >
                    <Star className={cn("h-4 w-4", settings.favoriteModels.includes(m.name) && "fill-amber-400 text-amber-400")} />
                  </Button>
                  <Button
                    variant={settings.defaultModel === m.name ? "default" : "outline"}
                    size="sm" onClick={() => update({ defaultModel: m.name })} className="h-8"
                  >
                    {settings.defaultModel === m.name ? "Predeterminado" : "Usar"}
                  </Button>
                </div>
              </Row>
            ))}
          </SectionCard>
        ))
      )}
    </>
  )
}

// ────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ────────────────────────────────────────────────────────────

function NotificationsSection() {
  const { settings, update } = useSettings()
  const N = settings.notifications

  // Task 18 — `notifications.appshots_security` lives in the same
  // settings.notifications JSON blob but is NOT part of the FE's typed
  // SettingsShape (it's a backend-only email opt-out flag). We read it
  // directly from the untyped subtree and persist via the narrow
  // PATCH /api/users/me/settings endpoint so we don't accidentally
  // round-trip the whole settings object.
  const appshotsSecurityEmails =
    (settings.notifications as unknown as { appshots_security?: boolean })
      .appshots_security !== false
  const [savingAppshotsPref, setSavingAppshotsPref] = React.useState(false)
  const setAppshotsSecurityEmails = async (next: boolean) => {
    setSavingAppshotsPref(true)
    try {
      // Use apiClient so the Bearer token (`auth-token` in localStorage),
      // CSRF double-submit header and credentials are handled the same
      // way as every other mutating call in the app.
      await apiClient.updateNotificationPreferences({ appshots_security: next })
      // Mirror the new flag into the local settings tree so the toggle
      // reflects state without a re-fetch. Cast through unknown — see
      // comment above about the missing typed key.
      update({
        notifications: {
          ...(N as any),
          appshots_security: next,
        } as any,
      })
      toast.success(
        next
          ? "Te avisaremos cuando se vincule un nuevo dispositivo"
          : "Avisos de seguridad de Appshots silenciados",
      )
    } catch (err) {
      toast.error("No se pudo guardar la preferencia")
    } finally {
      setSavingAppshotsPref(false)
    }
  }

  const requestDesktop = async () => {
    if (!("Notification" in window)) { toast.error("Tu navegador no soporta notificaciones"); return }
    const res = await Notification.requestPermission()
    if (res === "granted") {
      update({ notifications: { ...N, inApp: { ...N.inApp, desktop: true } } })
      toast.success("Notificaciones de escritorio habilitadas")
    } else { toast.error("Permiso denegado") }
  }

  const testNotification = () => {
    toast("Notificación de prueba", { description: "Así se verán tus alertas en siraGPT.", duration: 3500 })
    if (N.inApp.desktop && "Notification" in window && Notification.permission === "granted") {
      new Notification("siraGPT", { body: "Notificación de prueba" })
    }
  }

  return (
    <>
      <div className="text-sm text-muted-foreground">Configura cómo y cuándo recibir notificaciones.</div>

      <SectionCard title="Canales" desc="Cómo te llegan los diferentes tipos de eventos">
        <SelectRow
          title="Respuestas" desc="Cuando un modelo termina de responder"
          value={N.channels.replies}
          onChange={(v) => update({ notifications: { ...N, channels: { ...N.channels, replies: v as any } } })}
          options={[{ value: "off", label: "Desactivado" }, { value: "push", label: "Push" }]}
        />
        <SelectRow
          title="Tareas" desc="Tareas programadas y recordatorios"
          value={N.channels.tasks}
          onChange={(v) => update({ notifications: { ...N, channels: { ...N.channels, tasks: v as any } } })}
          options={[
            { value: "off", label: "Desactivado" }, { value: "push", label: "Push" },
            { value: "email", label: "Email" }, { value: "both", label: "Push + Email" },
          ]}
        />
        <SelectRow
          title="Proyectos" desc="Actualizaciones de proyectos en los que colaboras"
          value={N.channels.projects}
          onChange={(v) => update({ notifications: { ...N, channels: { ...N.channels, projects: v as any } } })}
          options={[{ value: "off", label: "Desactivado" }, { value: "email", label: "Email" }]}
        />
        <SelectRow
          title="Recomendaciones" desc="Novedades y recomendaciones"
          value={N.channels.recommendations}
          onChange={(v) => update({ notifications: { ...N, channels: { ...N.channels, recommendations: v as any } } })}
          options={[
            { value: "off", label: "Desactivado" }, { value: "push", label: "Push" },
            { value: "email", label: "Email" }, { value: "both", label: "Push + Email" },
          ]}
        />
      </SectionCard>

      <SectionCard title="En la app">
        <SwitchRow
          title="Toasts" desc="Mostrar pequeñas alertas en la esquina inferior"
          checked={N.inApp.toasts}
          onChange={(v) => update({ notifications: { ...N, inApp: { ...N.inApp, toasts: v } } })}
        />
        <SwitchRow
          title="Sonido" desc="Alertas sutiles al recibir notificaciones"
          checked={N.inApp.sound}
          onChange={(v) => update({ notifications: { ...N, inApp: { ...N.inApp, sound: v } } })}
        />
        <Row title="Escritorio" desc={N.inApp.desktop ? "Habilitado" : "Sin configurar"}>
          {N.inApp.desktop
            ? <Badge variant="secondary" className="gap-1"><Check className="h-3 w-3" />Activo</Badge>
            : <Button variant="outline" size="sm" onClick={requestDesktop}>Configurar</Button>
          }
        </Row>
        <Row title="Horas silenciosas" desc="No enviar notificaciones push durante este rango">
          <div className="flex items-center gap-2">
            <Input type="time" value={N.quietHoursStart} onChange={(e) => update({ notifications: { ...N, quietHoursStart: e.target.value } })} className="w-[110px] h-9" />
            <span className="text-xs text-muted-foreground">—</span>
            <Input type="time" value={N.quietHoursEnd} onChange={(e) => update({ notifications: { ...N, quietHoursEnd: e.target.value } })} className="w-[110px] h-9" />
          </div>
        </Row>
        <Row title="Probar notificación" desc="Dispara un toast de ejemplo">
          <Button variant="outline" size="sm" onClick={testNotification}>Probar</Button>
        </Row>
      </SectionCard>

      <SectionCard
        title="Seguridad de Appshots"
        desc="Avisos por email cuando se vincula o revoca la extensión de Chrome"
      >
        <SwitchRow
          title="Avisos de seguridad de Appshots"
          desc="Te avisamos por email cuando se vincula un nuevo dispositivo o se revoca uno. Si vinculas la extensión a menudo, puedes silenciarlos. El registro de auditoría sigue grabando el evento."
          checked={appshotsSecurityEmails}
          onChange={(v) => { if (!savingAppshotsPref) setAppshotsSecurityEmails(v) }}
        />
      </SectionCard>
    </>
  )
}

// ────────────────────────────────────────────────────────────
// PERSONALIZATION
// ────────────────────────────────────────────────────────────

function PersonalizationSection() {
  const { settings, update } = useSettings()
  const P = settings.profile
  const C = settings.capabilities

  return (
    <>
      <div className="text-sm text-muted-foreground">Configura el estilo y el tono que siraGPT utiliza al responder. El <strong>estilo</strong> base ahora vive en <em>General</em>.</div>

      <SectionCard title="Instrucciones personalizadas" desc="Se inyectan en cada conversación">
        <div className="p-5 space-y-4">
          <div>
            <div className="text-sm font-medium mb-1">Acerca de ti</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="nickname" className="text-xs text-muted-foreground">Apodo</Label>
                <Input id="nickname" value={P.nickname} onChange={(e) => update({ profile: { ...P, nickname: e.target.value } })} placeholder="Cómo prefieres que te llamen" />
              </div>
              <div>
                <Label htmlFor="occupation" className="text-xs text-muted-foreground">Ocupación</Label>
                <Input id="occupation" value={P.occupation} onChange={(e) => update({ profile: { ...P, occupation: e.target.value } })} placeholder="p. ej. Investigadora, Product Manager" />
              </div>
            </div>
          </div>
          <div>
            <Label htmlFor="about" className="text-xs text-muted-foreground">Más acerca de ti</Label>
            <Textarea id="about" value={P.about} onChange={(e) => update({ profile: { ...P, about: e.target.value.slice(0, 500) } })} maxLength={500} rows={4} placeholder="Intereses, estilo preferido, contexto profesional…" />
            <div className="text-xs text-muted-foreground text-right mt-1">{P.about.length}/500</div>
          </div>
          <div>
            <Label htmlFor="custom" className="text-xs text-muted-foreground">Instrucciones del sistema (avanzado)</Label>
            <Textarea id="custom" value={settings.customInstructions || ""} onChange={(e) => update({ customInstructions: e.target.value })} rows={3} placeholder="Ej: Responde siempre con un resumen ejecutivo antes del detalle." />
          </div>
        </div>
      </SectionCard>

      <MemorySettingsCard />

      <SectionCard title="Capacidades" desc="Qué puede hacer siraGPT por ti">
        <SwitchRow title="Memorias" desc="Permite que siraGPT guarde y use memorias al responder" checked={C.memories} onChange={(v) => update({ capabilities: { ...C, memories: v } })} />
        <SwitchRow title="Consultar historial de grabaciones" desc="Usar transcripciones previas como contexto" checked={C.voiceHistory} onChange={(v) => update({ capabilities: { ...C, voiceHistory: v } })} />
        <SwitchRow title="Búsqueda en la web" desc="Dejar que siraGPT busque automáticamente cuando lo necesite" checked={C.webSearch} onChange={(v) => update({ capabilities: { ...C, webSearch: v } })} />
        <SwitchRow title="Código" desc="Dejar que siraGPT ejecute código con el Intérprete" checked={C.codeInterpreter} onChange={(v) => update({ capabilities: { ...C, codeInterpreter: v } })} />
        <SwitchRow title="Lienzo" desc="Colaborar con siraGPT en texto y código" checked={C.canvas} onChange={(v) => update({ capabilities: { ...C, canvas: v } })} />
        <SwitchRow title="siraGPT Voice" desc="Habilitar el modo de voz" checked={C.voice} onChange={(v) => update({ capabilities: { ...C, voice: v } })} />
        <SwitchRow title="Modo de voz avanzado" desc="Conversaciones más naturales" checked={C.advancedVoice} onChange={(v) => update({ capabilities: { ...C, advancedVoice: v } })} />
        <SwitchRow title="Búsqueda del conector" desc="Buscar en fuentes conectadas (Gmail, Drive, etc.)" checked={C.connectorSearch} onChange={(v) => update({ capabilities: { ...C, connectorSearch: v } })} />
      </SectionCard>
    </>
  )
}

// ────────────────────────────────────────────────────────────
// APPS
// ────────────────────────────────────────────────────────────

type AppCat = "Diseño" | "Comunicación" | "Desarrollo" | "Productividad" | "Control"
const APPS: { id: string; name: string; desc: string; cat: AppCat }[] = [
  { id: "browser_control", name: "Navegador", desc: "Navegación, búsqueda y extracción con IA", cat: "Control" },
  { id: "chrome_control", name: "Chrome", desc: "Automatización segura de Chrome", cat: "Control" },
  { id: "computer_control", name: "Computadora", desc: "Control local mediante Computer Use", cat: "Control" },
  { id: "canva", name: "Canva", desc: "Diseño gráfico y contenido visual", cat: "Diseño" },
  { id: "figma", name: "Figma", desc: "Diseño colaborativo y prototipado", cat: "Diseño" },
  { id: "messenger", name: "Facebook Messenger", desc: "Mensajería de Meta", cat: "Comunicación" },
  { id: "gmail", name: "Gmail", desc: "Enviar, leer y gestionar correos", cat: "Comunicación" },
  { id: "outlook_mail", name: "Outlook Mail", desc: "Correo de Microsoft 365", cat: "Comunicación" },
  { id: "slack", name: "Slack", desc: "Comunicación y mensajería de equipo", cat: "Comunicación" },
  { id: "telegram", name: "Telegram", desc: "Bot de Telegram", cat: "Comunicación" },
  { id: "wechat", name: "WeChat", desc: "Mensajería", cat: "Comunicación" },
  { id: "whatsapp", name: "WhatsApp", desc: "Mensajería personal", cat: "Comunicación" },
  { id: "whatsapp_cloud", name: "WhatsApp Cloud API", desc: "Mensajería empresarial", cat: "Comunicación" },
  { id: "github", name: "GitHub", desc: "Control de versiones y colaboración", cat: "Desarrollo" },
  { id: "gcalendar", name: "Google Calendar", desc: "Sincroniza eventos y gestiona agenda", cat: "Productividad" },
  { id: "gdrive", name: "Google Drive", desc: "Almacenamiento y documentos", cat: "Productividad" },
  { id: "gforms", name: "Google Forms", desc: "Crea y gestiona formularios", cat: "Productividad" },
  { id: "notion", name: "Notion", desc: "Notas, documentación y gestión", cat: "Productividad" },
  { id: "outlook_cal", name: "Outlook Calendar", desc: "Calendario de Microsoft 365", cat: "Productividad" },
]

function AppsSection() {
  const { settings, update } = useSettings()
  const { user } = useAuth()
  const router = useNextRouter()

  const isConnected = (id: string) => {
    if (id === "gmail" && (user as any)?.gmailTokens) return true
    return settings.apps[id]?.connected === true
  }

  const connect = (id: string) => {
    // GitHub is fully wired: take the user to the Replit-style workspace hub
    // where they can sign in, import repos and use version control.
    if (id === "github") {
      router.push("/workspace")
      return
    }
    const name = APPS.find((a) => a.id === id)?.name || id
    toast("Próximamente", { description: `La integración con ${name} estará disponible en breve.` })
    update({ apps: { ...settings.apps, [id]: { connected: false } } })
  }

  const disconnect = (id: string) => {
    update({ apps: { ...settings.apps, [id]: { connected: false } } })
    toast.success("Desconectado")
  }

  const cats: AppCat[] = ["Control", "Diseño", "Comunicación", "Desarrollo", "Productividad"]
  return (
    <>
      <div className="text-sm text-muted-foreground">Conecta y administra las aplicaciones que siraGPT puede usar.</div>
      <McpServersCard />
      {cats.map((cat) => (
        <SectionCard key={cat} title={cat}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-5">
            {APPS.filter((a) => a.cat === cat).map((a) => {
              const connected = isConnected(a.id)
              return (
                <div key={a.id} className="group flex items-center gap-3 rounded-lg border border-border/60 p-3 hover:border-border hover:shadow-sm transition-all">
                  <div className="h-10 w-10 rounded-md bg-muted grid place-items-center text-xs font-semibold shrink-0">
                    {a.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{a.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{a.desc}</div>
                  </div>
                  {connected ? (
                    <div className="flex items-center gap-1">
                      <Badge variant="secondary" className="gap-1 text-emerald-700 dark:text-emerald-400 border-emerald-500/20 bg-emerald-500/10">
                        <Check className="h-3 w-3" />Conectado
                      </Badge>
                      <Button variant="ghost" size="sm" onClick={() => disconnect(a.id)}>Quitar</Button>
                    </div>
                  ) : (
                    <Button size="sm" onClick={() => connect(a.id)}>Conectar</Button>
                  )}
                </div>
              )
            })}
          </div>
        </SectionCard>
      ))}
    </>
  )
}

// ────────────────────────────────────────────────────────────
// SCHEDULES
// ────────────────────────────────────────────────────────────

function SchedulesSection() {
  return (
    <>
      <div className="text-sm text-muted-foreground">siraGPT puede programarse para ejecutarse después de completar una tarea.</div>
      <SectionCard title="Ejecuciones programadas">
        <div className="p-5 text-sm text-muted-foreground">
          Selecciona <strong>Programar</strong> en el menú de <code className="px-1.5 py-0.5 rounded bg-muted text-foreground">⋯</code> en una conversación para configurar ejecuciones futuras.
        </div>
        <Row title="Tareas programadas" desc="Ejecuciones futuras configuradas en tus chats">
          <Button variant="outline" size="sm" onClick={() => toast.info("Sin ejecuciones programadas")}>Administrar</Button>
        </Row>
        <div className="p-6 text-center text-sm text-muted-foreground border-t border-border/60">
          <Clock className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
          No hay ejecuciones programadas. Cuando las configures aparecerán aquí.
        </div>
      </SectionCard>
    </>
  )
}

// ────────────────────────────────────────────────────────────
// DATA CONTROLS — real chat-stats + real export + destructive
//   actions wired to the backend endpoints.
// ────────────────────────────────────────────────────────────

function DataControlsSection() {
  const { settings, update } = useSettings()
  const D = settings.dataControls
  const [stats, setStats] = React.useState<{ total: number; archived: number; deleted: number; shared: number } | null>(null)
  const [exporting, setExporting] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)

  const reload = React.useCallback(() => {
    apiClient.getChatStats().then(setStats).catch(() => setStats(null))
  }, [])
  React.useEffect(reload, [reload])

  const downloadData = async () => {
    setExporting(true)
    try {
      const token = localStorage.getItem("auth-token")
      const base = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"
      const r = await fetch(`${base}/users/data-export`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `siraGPT-export-${Date.now()}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success("Exportación descargada")
    } catch (e: any) {
      toast.error(e?.message || "No se pudo exportar")
    } finally { setExporting(false) }
  }

  const archiveAll = async () => {
    if (!window.confirm("¿Archivar todos tus chats activos?")) return
    setBusy("archive")
    try {
      const r = await apiClient.archiveAllChats()
      toast.success(`${r.archived ?? 0} chat(s) archivado(s)`)
      reload()
    } catch { toast.error("No se pudieron archivar") } finally { setBusy(null) }
  }

  const clearHistory = async () => {
    const first = window.confirm("Esto moverá TODOS tus chats a la papelera (30 días antes del borrado definitivo). ¿Continuar?")
    if (!first) return
    const second = window.confirm("Acción irreversible en la vista principal. ¿Estás realmente seguro?")
    if (!second) return
    setBusy("clear")
    try {
      const r = await apiClient.clearChatHistory()
      toast.success(`${r.deleted ?? 0} chat(s) movido(s) a papelera`)
      reload()
    } catch { toast.error("No se pudo borrar el historial") } finally { setBusy(null) }
  }

  return (
    <>
      <SectionCard title="Privacidad">
        <SwitchRow title="Compartir datos de uso" desc="Ayuda a mejorar el servicio" checked={D.shareUsage} onChange={(v) => update({ dataControls: { ...D, shareUsage: v } })} />
        <SwitchRow title="Seguimiento de análisis" desc="Estadísticas anónimas de uso" checked={D.analytics} onChange={(v) => update({ dataControls: { ...D, analytics: v } })} />
        <SwitchRow title="Datos del navegador remoto" desc="Permite acceso a datos de sesiones de navegación remota" checked={D.remoteBrowserData} onChange={(v) => update({ dataControls: { ...D, remoteBrowserData: v } })} />
      </SectionCard>

      <SectionCard title="Enlaces compartidos">
        <Row title="Enlaces activos" desc="Conversaciones compartidas públicamente">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="tabular-nums">{stats?.shared ?? 0}</Badge>
            <Button variant="outline" size="sm" onClick={() => toast.info(`${stats?.shared ?? 0} enlace(s) activo(s)`)}>Administrar</Button>
          </div>
        </Row>
      </SectionCard>

      <SectionCard title="Historial">
        <SwitchRow title="Guardar historial de chat" desc="Conservar conversaciones anteriores" checked={D.saveChatHistory} onChange={(v) => update({ dataControls: { ...D, saveChatHistory: v } })} />
        <Row title="Chats archivados" desc="Conversaciones fuera de la vista principal">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="tabular-nums">{stats?.archived ?? 0}</Badge>
            <Button variant="outline" size="sm" onClick={() => toast.info(`${stats?.archived ?? 0} chat(s) archivado(s)`)}>Administrar</Button>
          </div>
        </Row>
        <Row title="Chats eliminados" desc="Papelera — se eliminan permanentemente en 30 días">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="tabular-nums">{stats?.deleted ?? 0}</Badge>
            <Button variant="outline" size="sm" onClick={() => toast.info(`${stats?.deleted ?? 0} chat(s) en papelera`)}>Administrar</Button>
          </div>
        </Row>
        <Row title="Archivar todos los chats" desc="Retira todos los chats de la vista principal">
          <Button variant="outline" size="sm" onClick={archiveAll} disabled={busy === "archive"}>
            {busy === "archive" ? <ThinkingIndicator size="sm" /> : "Archivar todo"}
          </Button>
        </Row>
        <Row title="Borrar historial" desc="Acción irreversible — pedirá doble confirmación">
          <Button variant="destructive" size="sm" onClick={clearHistory} disabled={busy === "clear"}>
            {busy === "clear" ? <ThinkingIndicator size="sm" /> : <><Trash2 className="h-4 w-4 mr-1" />Borrar</>}
          </Button>
        </Row>
      </SectionCard>

      <SectionCard title="Tus datos">
        <Row title="Descargar mis datos" desc="Exporta un JSON con tus chats, archivos y configuración">
          <Button variant="outline" size="sm" onClick={downloadData} disabled={exporting}>
            {exporting ? <ThinkingIndicator size="sm" /> : <><Download className="h-4 w-4 mr-1" />Descargar</>}
          </Button>
        </Row>
        <Row title="Política de privacidad" desc="Revisa cómo manejamos tus datos">
          <Link href="/privacy-policy" className="text-sm text-primary hover:underline inline-flex items-center gap-1">
            Ver política <ExternalLink className="h-3 w-3" />
          </Link>
        </Row>
      </SectionCard>
    </>
  )
}

// ────────────────────────────────────────────────────────────
// SECURITY — real sessions + revoke-others + logout
// ────────────────────────────────────────────────────────────

function SecuritySection() {
  const { settings, update } = useSettings()
  const S = settings.security
  const { logout } = useAuth()
  const [sessions, setSessions] = React.useState<{ id: string; createdAt: string; expiresAt: string; current: boolean }[] | null>(null)
  const [revoking, setRevoking] = React.useState(false)

  const reload = React.useCallback(() => {
    apiClient.getUserSessions().then((d) => setSessions(d.sessions || [])).catch(() => setSessions([]))
  }, [])
  React.useEffect(reload, [reload])

  const revokeAll = async () => {
    if (!window.confirm("Cerrar sesión en todos los demás dispositivos revocará todos los tokens salvo el actual. ¿Continuar?")) return
    setRevoking(true)
    try {
      const r = await apiClient.revokeOtherSessions()
      toast.success(`${r.revoked ?? 0} sesión(es) revocadas`)
      reload()
    } catch { toast.error("No se pudo revocar") } finally { setRevoking(false) }
  }

  const others = (sessions || []).filter((s) => !s.current).length

  return (
    <>
      <SectionCard title="Autenticación multifactor" desc="Refuerza la seguridad de tu cuenta">
        <SwitchRow title="Aplicación de autenticación" desc="Usa códigos únicos desde una app de autenticación" checked={S.mfaApp} onChange={(v) => update({ security: { ...S, mfaApp: v } })} />
        <SwitchRow title="Notificaciones push" desc="Aprueba inicios de sesión con notificación push" checked={S.mfaPush} onChange={(v) => update({ security: { ...S, mfaPush: v } })} />
      </SectionCard>

      <SectionCard title="Dispositivos de confianza" desc={sessions ? `${sessions.length} sesión(es) activa(s)` : "Cargando…"}>
        {!sessions ? (
          <div className="p-5 text-sm text-muted-foreground flex items-center gap-2"><ThinkingIndicator size="sm" />Cargando sesiones…</div>
        ) : sessions.length === 0 ? (
          <div className="p-5 text-sm text-muted-foreground">Sin sesiones activas.</div>
        ) : (
          sessions.map((s) => (
            <Row
              key={s.id}
              title={s.current ? "Este dispositivo" : "Otro dispositivo"}
              desc={`Iniciada el ${new Date(s.createdAt).toLocaleString()} · Expira ${new Date(s.expiresAt).toLocaleDateString()}`}
            >
              {s.current ? (
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="gap-1 text-emerald-700 dark:text-emerald-400 border-emerald-500/20 bg-emerald-500/10">
                    <Laptop className="h-3 w-3" />Actual
                  </Badge>
                  <Button variant="outline" size="sm" onClick={() => { logout?.(); toast.success("Sesión cerrada") }}>
                    <LogOut className="h-4 w-4 mr-1" />Salir
                  </Button>
                </div>
              ) : (
                <Badge variant="outline">Otro</Badge>
              )}
            </Row>
          ))
        )}
        {others > 0 && (
          <div className="p-5">
            <Button variant="destructive" size="sm" onClick={revokeAll} disabled={revoking}>
              {revoking ? <ThinkingIndicator size="sm" /> : "Cerrar sesión en todos los demás dispositivos"}
            </Button>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Inicio de sesión seguro con siraGPT" desc="Usa tu cuenta de siraGPT para acceder a apps conectadas">
        <Row title="Single Sign-On (SSO)" desc="Configuración empresarial"><Badge variant="outline">Próximamente</Badge></Row>
      </SectionCard>
    </>
  )
}

// ────────────────────────────────────────────────────────────
// ACCOUNT — real avatar upload via /users/profile
// ────────────────────────────────────────────────────────────

function AccountSection() {
  const { settings, update } = useSettings()
  const { user, refreshUser } = useAuth()
  const B = settings.builderProfile
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = React.useState(false)

  const refs = {
    website: React.useRef<HTMLInputElement | null>(null),
    linkedin: React.useRef<HTMLInputElement | null>(null),
    github: React.useRef<HTMLInputElement | null>(null),
    email: React.useRef<HTMLInputElement | null>(null),
  }

  const onPickFile = () => fileInputRef.current?.click()
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > 2_000_000) { toast.error("La imagen supera los 2MB"); return }
    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null
      if (!dataUrl) return
      setUploading(true)
      try {
        await apiClient.updateUserProfile({ avatar: dataUrl })
        await refreshUser?.()
        toast.success("Foto actualizada")
      } catch { toast.error("No se pudo subir la foto") } finally { setUploading(false) }
    }
    reader.readAsDataURL(f)
  }

  const initials = (user?.name || user?.email || "U")
    .split(/\s+/).filter(Boolean).map((s: string) => s[0]).slice(0, 2).join("").toUpperCase()

  return (
    <>
      <SectionCard title="Foto de perfil">
        <div className="p-5 flex items-center gap-4">
          <Avatar className="h-16 w-16 ring-2 ring-border">
            <AvatarImage src={user?.avatar || undefined} />
            <AvatarFallback className="text-lg">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <div className="text-sm font-medium">Foto pública</div>
            <div className="text-xs text-muted-foreground">JPG o PNG, máximo 2MB. Se muestra en tus GPTs y en tu perfil.</div>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
          <Button variant="outline" size="sm" onClick={onPickFile} disabled={uploading}>
            {uploading ? <ThinkingIndicator size="sm" /> : <><Camera className="h-4 w-4 mr-1" />Subir foto</>}
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Perfil de constructor de GPT" desc="Cómo apareces cuando publicas GPTs">
        <div className="p-5 space-y-4">
          {/* Preview card — reflects the name and avatar live */}
          <div className="rounded-lg border border-border/60 bg-gradient-to-br from-muted/30 to-background p-4 flex items-center gap-3">
            <Avatar className="h-10 w-10">
              <AvatarImage src={user?.avatar || undefined} />
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <div>
              <div className="text-sm font-semibold">GPT de ejemplo</div>
              <div className="text-xs text-muted-foreground">Por <span className="font-medium text-foreground">{B.name || user?.name || "tu nombre"}</span></div>
            </div>
          </div>

          <div>
            <Label htmlFor="builder-name" className="text-xs text-muted-foreground">Nombre</Label>
            <Input id="builder-name" value={B.name} onChange={(e) => update({ builderProfile: { ...B, name: e.target.value } })} placeholder="Tu nombre público" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <LinkField inputRef={refs.website} icon={Globe} label="Sitio web" value={B.website} onChange={(v) => update({ builderProfile: { ...B, website: v } })} placeholder="https://…" />
            <LinkField inputRef={refs.linkedin} icon={Linkedin} label="LinkedIn" value={B.linkedin} onChange={(v) => update({ builderProfile: { ...B, linkedin: v } })} placeholder="https://linkedin.com/in/…" />
            <LinkField inputRef={refs.github} icon={Github} label="GitHub" value={B.github} onChange={(v) => update({ builderProfile: { ...B, github: v } })} placeholder="https://github.com/…" />
            <LinkField inputRef={refs.email} icon={Mail} label="Correo electrónico" value={B.email} onChange={(v) => update({ builderProfile: { ...B, email: v } })} placeholder="contacto@tu-dominio.com" />
          </div>
        </div>
      </SectionCard>
    </>
  )
}

function LinkField({ inputRef, icon: Icon, label, value, onChange, placeholder }: {
  inputRef: React.RefObject<HTMLInputElement>
  icon: any; label: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  const empty = !value
  return (
    <div>
      <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Icon className="h-3 w-3" />{label}
      </Label>
      <div className="flex gap-2">
        <Input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        {empty && (
          <Button variant="ghost" size="sm" onClick={() => inputRef.current?.focus()} className="gap-1">
            <Plus className="h-3.5 w-3.5" />Agregar
          </Button>
        )}
      </div>
    </div>
  )
}
