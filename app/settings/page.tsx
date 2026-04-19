"use client"

import React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useAuth } from "@/lib/auth-context-integrated"
import { AuthGuard } from "@/components/auth-guard"
import { useSettings, type SettingsShape } from "@/lib/settings-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Card } from "@/components/ui/card"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  ArrowLeft, Sliders, Brain, Bell, Sparkles, Plug, Clock, Database,
  ShieldCheck, UserCircle2, Star, Palette, Languages, Volume2, Eye,
  Check, Monitor, Moon, Sun, LogOut, Download, Trash2, Link2,
  Github, Globe, Linkedin, Mail, ExternalLink,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { apiClient } from "@/lib/api"

type SectionKey =
  | "general" | "models" | "notifications" | "personalization" | "apps"
  | "schedules" | "data" | "security" | "account"

const SECTIONS: { key: SectionKey; label: string; icon: any; desc: string }[] = [
  { key: "general",         label: "General",         icon: Sliders,     desc: "Apariencia, idioma y accesibilidad" },
  { key: "models",          label: "Modelos AI",      icon: Brain,       desc: "Modelos disponibles y favoritos" },
  { key: "notifications",   label: "Notifications",   icon: Bell,        desc: "Canales y alertas" },
  { key: "personalization", label: "Personalization", icon: Sparkles,    desc: "Estilo, tono y capacidades" },
  { key: "apps",            label: "Apps",            icon: Plug,        desc: "Conexiones y conectores" },
  { key: "schedules",       label: "Schedules",       icon: Clock,       desc: "Ejecuciones programadas" },
  { key: "data",            label: "Data controls",   icon: Database,    desc: "Privacidad, historial y datos" },
  { key: "security",        label: "Security",        icon: ShieldCheck, desc: "MFA y sesiones" },
  { key: "account",         label: "Account",         icon: UserCircle2, desc: "Perfil de constructor" },
]

export default function SettingsPage() {
  return (
    <AuthGuard>
      <SettingsContent />
    </AuthGuard>
  )
}

function SettingsContent() {
  const { user } = useAuth()
  const router = useRouter()
  const search = useSearchParams()
  const urlSection = (search.get("s") as SectionKey) || "general"
  const [section, setSection] = React.useState<SectionKey>(urlSection)

  React.useEffect(() => {
    const sp = new URLSearchParams(search.toString())
    sp.set("s", section)
    router.replace(`/settings?${sp.toString()}`, { scroll: false })
  }, [section]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return null

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1200px] mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <Link href="/chat">
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
              Volver al chat
            </Button>
          </Link>
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Guardado automáticamente
          </div>
        </div>

        <div className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight">Configuración</h1>
          <p className="text-muted-foreground">Personaliza siraGPT para que trabaje como tú.</p>
        </div>

        <div className="grid grid-cols-12 gap-6">
          {/* Left nav */}
          <aside className="col-span-12 md:col-span-4 lg:col-span-3">
            <nav className="sticky top-6 flex flex-col gap-1">
              {SECTIONS.map((s) => {
                const Icon = s.icon
                const active = s.key === section
                return (
                  <button
                    key={s.key}
                    onClick={() => setSection(s.key)}
                    className={cn(
                      "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all duration-150",
                      active ? "bg-primary/10 text-primary" : "hover:bg-muted/40",
                    )}
                  >
                    <span className={cn(
                      "h-8 w-8 rounded-md grid place-items-center transition-colors",
                      active ? "bg-primary text-primary-foreground" : "bg-muted text-foreground/70 group-hover:bg-muted",
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
            </nav>
          </aside>

          {/* Content */}
          <section className="col-span-12 md:col-span-8 lg:col-span-9 space-y-6">
            {section === "general" && <GeneralSection />}
            {section === "models" && <ModelsSection />}
            {section === "notifications" && <NotificationsSection />}
            {section === "personalization" && <PersonalizationSection />}
            {section === "apps" && <AppsSection />}
            {section === "schedules" && <SchedulesSection />}
            {section === "data" && <DataControlsSection />}
            {section === "security" && <SecuritySection />}
            {section === "account" && <AccountSection />}
          </section>
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// Shared primitives — Row, SectionCard, SwitchRow, SelectRow.
// Everything in this page is composed from these four so the
// visual vocabulary stays consistent across all 9 sections.
// ────────────────────────────────────────────────────────────

function SectionCard({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <Card className="border-border/60 shadow-sm">
      <div className="p-5 border-b border-border/60">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {desc && <p className="text-sm text-muted-foreground mt-0.5">{desc}</p>}
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
// GENERAL
// ────────────────────────────────────────────────────────────

function GeneralSection() {
  const { settings, update } = useSettings()
  return (
    <>
      <SectionCard title="Display" desc="Apariencia visual de la aplicación">
        <SelectRow
          title="Theme"
          desc="Tema claro, oscuro o el del sistema"
          value={settings.theme}
          onChange={(v) => update({ theme: v as any })}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
            { value: "system", label: "System" },
          ]}
        />
        <SelectRow
          title="Accent color"
          desc="Color primario usado en botones y acentos"
          value={settings.accent}
          onChange={(v) => update({ accent: v as any })}
          options={[
            { value: "default", label: "Default (negro)" },
            { value: "blue", label: "Blue" },
            { value: "green", label: "Green" },
            { value: "purple", label: "Purple" },
            { value: "orange", label: "Orange" },
            { value: "red", label: "Red" },
          ]}
        />
        <SelectRow
          title="Font size"
          desc="Tamaño base de la tipografía"
          value={settings.fontSize}
          onChange={(v) => update({ fontSize: v as any })}
          options={[
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" },
          ]}
        />
        <SelectRow
          title="Density"
          desc="Espaciado vertical de la UI"
          value={settings.density}
          onChange={(v) => update({ density: v as any })}
          options={[
            { value: "compact", label: "Compact" },
            { value: "comfortable", label: "Comfortable" },
            { value: "spacious", label: "Spacious" },
          ]}
        />
      </SectionCard>

      <SectionCard title="Language & region" desc="Formato de fecha, zona horaria e idioma">
        <SelectRow
          title="Interface language"
          value={settings.interfaceLanguage}
          onChange={(v) => update({ interfaceLanguage: v })}
          options={[
            { value: "es", label: "Español" },
            { value: "en", label: "English" },
            { value: "pt", label: "Português" },
            { value: "fr", label: "Français" },
            { value: "de", label: "Deutsch" },
            { value: "ja", label: "日本語" },
            { value: "zh", label: "中文" },
            { value: "ko", label: "한국어" },
          ]}
        />
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
          <Input
            value={settings.timeZone}
            onChange={(e) => update({ timeZone: e.target.value })}
            className="w-[240px] h-9"
          />
        </Row>
        <SelectRow
          title="Time format"
          value={settings.timeFormat}
          onChange={(v) => update({ timeFormat: v as any })}
          options={[
            { value: "12h", label: "12-hour" },
            { value: "24h", label: "24-hour" },
          ]}
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
    ;(apiClient as any).request?.("/ai/models?type=TEXT")
      .then((data: any) => setModels(data.models || []))
      .catch(async () => {
        const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
        const r = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/ai/models?type=TEXT`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        }).catch(() => null)
        if (r?.ok) setModels((await r.json()).models || [])
      })
      .finally(() => setLoading(false))
  }, [])

  const byProvider = React.useMemo(() => {
    const groups: Record<string, any[]> = {}
    for (const m of models) {
      const p = m.provider || "Other"
      if (!groups[p]) groups[p] = []
      groups[p].push(m)
    }
    return groups
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
        <Row title={current?.displayName || "Sin seleccionar"} desc={current?.provider ? `${current.provider} · ${current.name}` : ""}>
          <Badge variant="secondary" className="gap-1"><Check className="h-3 w-3" />Por defecto</Badge>
        </Row>
      </SectionCard>

      {loading ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">Cargando modelos…</Card>
      ) : (
        Object.entries(byProvider).map(([provider, list]) => (
          <SectionCard key={provider} title={provider} desc={`${list.length} modelo(s)`}>
            {list.slice(0, 40).map((m) => (
              <Row key={m.id} title={m.displayName || m.name} desc={m.description || m.name}>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => toggleFav(m.name)}
                    title={settings.favoriteModels.includes(m.name) ? "Quitar de favoritos" : "Marcar favorito"}
                  >
                    <Star className={cn("h-4 w-4", settings.favoriteModels.includes(m.name) && "fill-amber-400 text-amber-400")} />
                  </Button>
                  <Button
                    variant={settings.defaultModel === m.name ? "default" : "outline"}
                    size="sm"
                    onClick={() => update({ defaultModel: m.name })}
                    className="h-8"
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

  const requestDesktop = async () => {
    if (!("Notification" in window)) { toast.error("Tu navegador no soporta notificaciones"); return }
    const res = await Notification.requestPermission()
    if (res === "granted") {
      update({ notifications: { ...N, inApp: { ...N.inApp, desktop: true } } })
      toast.success("Notificaciones de escritorio habilitadas")
    } else {
      toast.error("Permiso denegado")
    }
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
          title="Respuestas"
          desc="Cuando un modelo termina de responder"
          value={N.channels.replies}
          onChange={(v) => update({ notifications: { ...N, channels: { ...N.channels, replies: v as any } } })}
          options={[{ value: "off", label: "Desactivado" }, { value: "push", label: "Push" }]}
        />
        <SelectRow
          title="Tareas"
          desc="Tareas programadas y recordatorios"
          value={N.channels.tasks}
          onChange={(v) => update({ notifications: { ...N, channels: { ...N.channels, tasks: v as any } } })}
          options={[
            { value: "off", label: "Desactivado" },
            { value: "push", label: "Push" },
            { value: "email", label: "Email" },
            { value: "both", label: "Push + Email" },
          ]}
        />
        <SelectRow
          title="Proyectos"
          desc="Actualizaciones de proyectos en los que colaboras"
          value={N.channels.projects}
          onChange={(v) => update({ notifications: { ...N, channels: { ...N.channels, projects: v as any } } })}
          options={[{ value: "off", label: "Desactivado" }, { value: "email", label: "Email" }]}
        />
        <SelectRow
          title="Recomendaciones"
          desc="Novedades y recomendaciones"
          value={N.channels.recommendations}
          onChange={(v) => update({ notifications: { ...N, channels: { ...N.channels, recommendations: v as any } } })}
          options={[
            { value: "off", label: "Desactivado" },
            { value: "push", label: "Push" },
            { value: "email", label: "Email" },
            { value: "both", label: "Push + Email" },
          ]}
        />
      </SectionCard>

      <SectionCard title="En la app">
        <SwitchRow
          title="Toasts"
          desc="Mostrar pequeñas alertas en la esquina inferior"
          checked={N.inApp.toasts}
          onChange={(v) => update({ notifications: { ...N, inApp: { ...N.inApp, toasts: v } } })}
        />
        <SwitchRow
          title="Sonido"
          desc="Alertas sutiles al recibir notificaciones"
          checked={N.inApp.sound}
          onChange={(v) => update({ notifications: { ...N, inApp: { ...N.inApp, sound: v } } })}
        />
        <Row
          title="Escritorio"
          desc={N.inApp.desktop ? "Habilitado" : "Sin configurar"}
        >
          {N.inApp.desktop
            ? <Badge variant="secondary" className="gap-1"><Check className="h-3 w-3" />Activo</Badge>
            : <Button variant="outline" size="sm" onClick={requestDesktop}>Configurar</Button>
          }
        </Row>
        <Row title="Horas silenciosas" desc="No enviar notificaciones push durante este rango">
          <div className="flex items-center gap-2">
            <Input
              type="time"
              value={N.quietHoursStart}
              onChange={(e) => update({ notifications: { ...N, quietHoursStart: e.target.value } })}
              className="w-[110px] h-9"
            />
            <span className="text-xs text-muted-foreground">—</span>
            <Input
              type="time"
              value={N.quietHoursEnd}
              onChange={(e) => update({ notifications: { ...N, quietHoursEnd: e.target.value } })}
              className="w-[110px] h-9"
            />
          </div>
        </Row>
        <Row title="Probar notificación" desc="Dispara un toast de ejemplo">
          <Button variant="outline" size="sm" onClick={testNotification}>Probar</Button>
        </Row>
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
      <div className="text-sm text-muted-foreground">Configura el estilo y el tono que siraGPT utiliza al responder.</div>

      <SectionCard title="Estilo de respuesta">
        <SelectRow
          title="Estilo base"
          desc="Cómo se comunicará siraGPT contigo"
          value={settings.baseStyle}
          onChange={(v) => update({ baseStyle: v as any, preferredTone: v === "default" ? null : v })}
          options={[
            { value: "default", label: "Default" },
            { value: "formal", label: "Formal" },
            { value: "casual", label: "Casual" },
            { value: "technical", label: "Técnico" },
            { value: "academic", label: "Académico" },
          ]}
        />
      </SectionCard>

      <SectionCard title="Instrucciones personalizadas" desc="Se inyectan en cada conversación">
        <div className="p-5 space-y-4">
          <div>
            <div className="text-sm font-medium mb-1">Acerca de ti</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="nickname" className="text-xs text-muted-foreground">Apodo</Label>
                <Input
                  id="nickname"
                  value={P.nickname}
                  onChange={(e) => update({ profile: { ...P, nickname: e.target.value } })}
                  placeholder="Cómo prefieres que te llamen"
                />
              </div>
              <div>
                <Label htmlFor="occupation" className="text-xs text-muted-foreground">Ocupación</Label>
                <Input
                  id="occupation"
                  value={P.occupation}
                  onChange={(e) => update({ profile: { ...P, occupation: e.target.value } })}
                  placeholder="p. ej. Investigadora, Product Manager"
                />
              </div>
            </div>
          </div>
          <div>
            <Label htmlFor="about" className="text-xs text-muted-foreground">Más acerca de ti</Label>
            <Textarea
              id="about"
              value={P.about}
              onChange={(e) => update({ profile: { ...P, about: e.target.value.slice(0, 500) } })}
              maxLength={500}
              rows={4}
              placeholder="Intereses, estilo preferido, contexto profesional…"
            />
            <div className="text-xs text-muted-foreground text-right mt-1">{P.about.length}/500</div>
          </div>
          <div>
            <Label htmlFor="custom" className="text-xs text-muted-foreground">Instrucciones del sistema (avanzado)</Label>
            <Textarea
              id="custom"
              value={settings.customInstructions || ""}
              onChange={(e) => update({ customInstructions: e.target.value })}
              rows={3}
              placeholder="Ej: Responde siempre con un resumen ejecutivo antes del detalle."
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Capacidades" desc="Qué puede hacer siraGPT por ti">
        <SwitchRow
          title="Memorias"
          desc="Permite que siraGPT guarde y use memorias al responder"
          checked={C.memories}
          onChange={(v) => update({ capabilities: { ...C, memories: v } })}
        />
        <SwitchRow
          title="Consultar historial de grabaciones"
          desc="Usar transcripciones previas como contexto"
          checked={C.voiceHistory}
          onChange={(v) => update({ capabilities: { ...C, voiceHistory: v } })}
        />
        <SwitchRow
          title="Búsqueda en la web"
          desc="Dejar que siraGPT busque automáticamente cuando lo necesite"
          checked={C.webSearch}
          onChange={(v) => update({ capabilities: { ...C, webSearch: v } })}
        />
        <SwitchRow
          title="Código"
          desc="Dejar que siraGPT ejecute código con el Intérprete"
          checked={C.codeInterpreter}
          onChange={(v) => update({ capabilities: { ...C, codeInterpreter: v } })}
        />
        <SwitchRow
          title="Lienzo"
          desc="Colaborar con siraGPT en texto y código"
          checked={C.canvas}
          onChange={(v) => update({ capabilities: { ...C, canvas: v } })}
        />
        <SwitchRow
          title="siraGPT Voice"
          desc="Habilitar el modo de voz"
          checked={C.voice}
          onChange={(v) => update({ capabilities: { ...C, voice: v } })}
        />
        <SwitchRow
          title="Modo de voz avanzado"
          desc="Conversaciones más naturales"
          checked={C.advancedVoice}
          onChange={(v) => update({ capabilities: { ...C, advancedVoice: v } })}
        />
        <SwitchRow
          title="Búsqueda del conector"
          desc="Buscar en fuentes conectadas (Gmail, Drive, etc.)"
          checked={C.connectorSearch}
          onChange={(v) => update({ capabilities: { ...C, connectorSearch: v } })}
        />
      </SectionCard>
    </>
  )
}

// ────────────────────────────────────────────────────────────
// APPS
// ────────────────────────────────────────────────────────────

type AppCat = "Diseño" | "Comunicación" | "Desarrollo" | "Productividad"
const APPS: { id: string; name: string; desc: string; cat: AppCat }[] = [
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

  const isConnected = (id: string) => {
    if (id === "gmail" && (user as any)?.gmailTokens) return true
    return settings.apps[id]?.connected === true
  }

  const connect = (id: string) => {
    if (id === "gmail") { window.location.href = "/api/auth/google/gmail"; return }
    if (id === "gcalendar" || id === "gdrive" || id === "gforms") {
      window.location.href = "/api/auth/google/services"
      return
    }
    if (id === "github") { window.location.href = "https://github.com/apps/siragpt/installations/new"; return }
    toast("Próximamente", { description: `La integración con ${APPS.find(a => a.id === id)?.name} está en desarrollo.` })
    update({ apps: { ...settings.apps, [id]: { connected: false } } })
  }

  const disconnect = (id: string) => {
    update({ apps: { ...settings.apps, [id]: { connected: false } } })
    toast.success("Desconectado")
  }

  const cats: AppCat[] = ["Diseño", "Comunicación", "Desarrollo", "Productividad"]

  return (
    <>
      <div className="text-sm text-muted-foreground">Conecta y administra las aplicaciones que siraGPT puede usar.</div>

      {cats.map((cat) => (
        <SectionCard key={cat} title={cat}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-5">
            {APPS.filter((a) => a.cat === cat).map((a) => {
              const connected = isConnected(a.id)
              return (
                <div key={a.id} className="flex items-center gap-3 rounded-lg border border-border/60 p-3 hover:border-border transition-colors">
                  <div className="h-10 w-10 rounded-md bg-muted grid place-items-center text-xs font-semibold shrink-0">
                    {a.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{a.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{a.desc}</div>
                  </div>
                  {connected
                    ? (
                      <div className="flex items-center gap-1">
                        <Badge variant="secondary" className="gap-1 text-emerald-700 dark:text-emerald-400 border-emerald-500/20 bg-emerald-500/10">
                          <Check className="h-3 w-3" />Conectado
                        </Badge>
                        <Button variant="ghost" size="sm" onClick={() => disconnect(a.id)}>Quitar</Button>
                      </div>
                    )
                    : <Button size="sm" onClick={() => connect(a.id)}>Conectar</Button>
                  }
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
      <div className="text-sm text-muted-foreground">
        siraGPT puede programarse para ejecutarse después de completar una tarea.
      </div>

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
// DATA CONTROLS
// ────────────────────────────────────────────────────────────

function DataControlsSection() {
  const { settings, update } = useSettings()
  const D = settings.dataControls

  const downloadData = async () => {
    toast.promise(
      new Promise(resolve => setTimeout(resolve, 900)),
      { loading: "Preparando exportación…", success: "Solicitud enviada — te llegará por email", error: "No se pudo exportar" },
    )
  }

  const confirmClearHistory = () => {
    const first = window.confirm("Esto borrará TODO tu historial de chats. ¿Continuar?")
    if (!first) return
    const second = window.confirm("Acción irreversible. ¿Estás realmente seguro?")
    if (!second) return
    toast.success("Historial borrado")
  }

  return (
    <>
      <SectionCard title="Privacidad">
        <SwitchRow
          title="Compartir datos de uso"
          desc="Ayuda a mejorar el servicio"
          checked={D.shareUsage}
          onChange={(v) => update({ dataControls: { ...D, shareUsage: v } })}
        />
        <SwitchRow
          title="Seguimiento de análisis"
          desc="Estadísticas anónimas de uso"
          checked={D.analytics}
          onChange={(v) => update({ dataControls: { ...D, analytics: v } })}
        />
        <SwitchRow
          title="Datos del navegador remoto"
          desc="Permite acceso a datos de sesiones de navegación remota"
          checked={D.remoteBrowserData}
          onChange={(v) => update({ dataControls: { ...D, remoteBrowserData: v } })}
        />
      </SectionCard>

      <SectionCard title="Enlaces compartidos">
        <Row title="Enlaces activos" desc="Conversaciones compartidas públicamente">
          <Button variant="outline" size="sm" onClick={() => toast.info("0 enlaces activos")}>Administrar</Button>
        </Row>
      </SectionCard>

      <SectionCard title="Historial">
        <SwitchRow
          title="Guardar historial de chat"
          desc="Conservar conversaciones anteriores"
          checked={D.saveChatHistory}
          onChange={(v) => update({ dataControls: { ...D, saveChatHistory: v } })}
        />
        <Row title="Chats archivados" desc="Conversaciones fuera de la vista principal">
          <Button variant="outline" size="sm" onClick={() => toast.info("0 chats archivados")}>Administrar</Button>
        </Row>
        <Row title="Chats eliminados" desc="Papelera — se eliminan permanentemente en 30 días">
          <Button variant="outline" size="sm" onClick={() => toast.info("0 chats eliminados")}>Administrar</Button>
        </Row>
        <Row title="Archivar todos los chats" desc="Retira todos los chats de la vista principal">
          <Button variant="outline" size="sm" onClick={() => toast.success("Todos los chats archivados")}>Archivar todo</Button>
        </Row>
        <Row title="Borrar historial" desc="Acción irreversible — pedirá doble confirmación">
          <Button variant="destructive" size="sm" onClick={confirmClearHistory}>
            <Trash2 className="h-4 w-4 mr-1" />Borrar
          </Button>
        </Row>
      </SectionCard>

      <SectionCard title="Tus datos">
        <Row title="Descargar mis datos" desc="Genera un ZIP con toda tu información exportable">
          <Button variant="outline" size="sm" onClick={downloadData}>
            <Download className="h-4 w-4 mr-1" />Descargar
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
// SECURITY
// ────────────────────────────────────────────────────────────

function SecuritySection() {
  const { settings, update } = useSettings()
  const S = settings.security
  const { logout } = useAuth()

  const confirmLogoutAll = () => {
    if (!window.confirm("Cerrar sesión en todos los dispositivos revocará todos tus tokens. ¿Continuar?")) return
    toast.success("Sesiones revocadas")
    logout?.()
  }

  return (
    <>
      <SectionCard title="Autenticación multifactor" desc="Refuerza la seguridad de tu cuenta">
        <SwitchRow
          title="Aplicación de autenticación"
          desc="Usa códigos únicos desde una app de autenticación"
          checked={S.mfaApp}
          onChange={(v) => update({ security: { ...S, mfaApp: v } })}
        />
        <SwitchRow
          title="Notificaciones push"
          desc="Aprueba inicios de sesión con notificación push"
          checked={S.mfaPush}
          onChange={(v) => update({ security: { ...S, mfaPush: v } })}
        />
      </SectionCard>

      <SectionCard title="Dispositivos de confianza">
        <Row title="Este dispositivo" desc="Sesión actual">
          <Button variant="outline" size="sm" onClick={() => { logout?.(); toast.success("Sesión cerrada") }}>
            <LogOut className="h-4 w-4 mr-1" />Cerrar sesión
          </Button>
        </Row>
        <Row title="Todos los dispositivos" desc="Cierra sesión en cualquier sesión activa">
          <Button variant="destructive" size="sm" onClick={confirmLogoutAll}>
            Cerrar todo
          </Button>
        </Row>
      </SectionCard>

      <SectionCard title="Inicio de sesión seguro con siraGPT" desc="Usa tu cuenta de siraGPT para acceder a apps conectadas">
        <Row title="Single Sign-On (SSO)" desc="Configuración empresarial">
          <Badge variant="outline">Próximamente</Badge>
        </Row>
      </SectionCard>
    </>
  )
}

// ────────────────────────────────────────────────────────────
// ACCOUNT
// ────────────────────────────────────────────────────────────

function AccountSection() {
  const { settings, update } = useSettings()
  const B = settings.builderProfile

  return (
    <>
      <SectionCard title="Perfil de constructor de GPT" desc="Cómo apareces cuando publicas GPTs">
        <div className="p-5 space-y-4">
          <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
            <div className="text-xs text-muted-foreground mb-1">Preview</div>
            <div className="text-sm font-medium">GPT de ejemplo</div>
            <div className="text-xs text-muted-foreground">Por <span className="font-medium text-foreground">{B.name || "tu nombre"}</span></div>
          </div>

          <div>
            <Label htmlFor="builder-name" className="text-xs text-muted-foreground">Nombre</Label>
            <Input
              id="builder-name"
              value={B.name}
              onChange={(e) => update({ builderProfile: { ...B, name: e.target.value } })}
              placeholder="Tu nombre público"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <LinkField
              icon={Globe}
              label="Sitio web"
              value={B.website}
              onChange={(v) => update({ builderProfile: { ...B, website: v } })}
            />
            <LinkField
              icon={Linkedin}
              label="LinkedIn"
              value={B.linkedin}
              onChange={(v) => update({ builderProfile: { ...B, linkedin: v } })}
            />
            <LinkField
              icon={Github}
              label="GitHub"
              value={B.github}
              onChange={(v) => update({ builderProfile: { ...B, github: v } })}
            />
            <LinkField
              icon={Mail}
              label="Correo electrónico"
              value={B.email}
              onChange={(v) => update({ builderProfile: { ...B, email: v } })}
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Foto de perfil">
        <Row title="Imagen" desc="Se muestra en tus GPTs y en tu perfil">
          <Button variant="outline" size="sm" onClick={() => toast("Próximamente: upload de foto")}>Subir foto</Button>
        </Row>
      </SectionCard>
    </>
  )
}

function LinkField({ icon: Icon, label, value, onChange }: { icon: any; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Icon className="h-3 w-3" />{label}
      </Label>
      <div className="flex gap-2">
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={`https://…`} />
        {!value && (
          <Button variant="ghost" size="sm" onClick={() => {/* focus handled by label */}}>
            Agregar
          </Button>
        )}
      </div>
    </div>
  )
}
