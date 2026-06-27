"use client"

import { useEffect, useState, type ComponentType, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  BadgeCheck,
  Calendar,
  Camera,
  CheckCircle2,
  CreditCard,
  Crown,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  Shield,
  Sparkles,
  User as UserIcon,
  Zap,
} from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { AuthGuard } from "@/components/auth-guard"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { useAuth } from "@/lib/auth-context-integrated"
import { apiClient } from "@/lib/api"
import { cn } from "@/lib/utils"

type PlanKey = "ENTERPRISE" | "PRO_MAX" | "PRO" | "FREE"

type PlanMeta = {
  label: string
  icon: ComponentType<{ className?: string }>
  description: string
}

type SubscriptionData = {
  status?: string | null
  endDate?: string | null
  stripeSubscription?: {
    status?: string | null
    currentPeriodEnd?: string | null
  } | null
}

const PLAN_META: Record<PlanKey, PlanMeta> = {
  ENTERPRISE: {
    label: "Enterprise",
    icon: Crown,
    description: "Equipo, seguridad y soporte a medida",
  },
  PRO_MAX: {
    label: "Pro Extendido",
    icon: Sparkles,
    description: "Más volumen para uso intensivo",
  },
  PRO: {
    label: "Pro",
    icon: Zap,
    description: "Modelos premium y herramientas avanzadas",
  },
  FREE: {
    label: "Free",
    icon: UserIcon,
    description: "Funciones esenciales para empezar",
  },
}

export default function ProfilePage() {
  return (
    <AuthGuard>
      <ProfileContent />
    </AuthGuard>
  )
}

function ProfileContent() {
  const t = useTranslations("profile")
  const tset = useTranslations("settings")
  const { user, refreshUser } = useAuth()
  const router = useRouter()

  const [profileSaving, setProfileSaving] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [profileData, setProfileData] = useState({ name: user?.name || "" })
  const [passwordData, setPasswordData] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  })
  const [showPassword, setShowPassword] = useState({
    current: false,
    new: false,
    confirm: false,
  })
  const [subscriptionData, setSubscriptionData] = useState<SubscriptionData | null>(null)

  useEffect(() => {
    setProfileData({ name: user?.name || "" })
  }, [user?.name])

  useEffect(() => {
    if (!user) return

    let mounted = true
    setSubscriptionData(null)

    async function loadSubscription() {
      try {
        const data = await apiClient.getSubscriptionInfo()
        if (mounted) setSubscriptionData(data as SubscriptionData)
      } catch (error) {
        console.error("Error fetching subscription data:", error)
        if (mounted) {
          setSubscriptionData({
            status: "active",
            endDate: null,
          })
        }
      }
    }

    loadSubscription()
    return () => {
      mounted = false
    }
  }, [user])

  if (!user) return null

  const planKey = normalizePlan(user.plan)
  const plan = PLAN_META[planKey]
  const PlanIcon = plan.icon

  const displayName = profileData.name.trim() || user.name || user.email?.split("@")[0] || "Usuario"
  const initials = getInitials(user.name || user.email || "U")
  const isProfileDirty = profileData.name.trim() !== (user.name || "").trim()

  const usage = getUsageModel({
    plan: planKey,
    monthlyLimit: Number(user.monthlyLimit ?? 0),
    apiUsage: Number(user.apiUsage ?? 0),
  })
  const usageTone = usage.percent >= 90 ? "danger" : usage.percent >= 70 ? "warn" : "ok"
  const usageUnit = planKey === "FREE" ? "llamadas" : "tokens"

  const rawStatus = (
    subscriptionData?.stripeSubscription?.status ||
    subscriptionData?.status ||
    "active"
  ).toString()
  const status = getSubscriptionStatus(rawStatus)
  const nextBillingSource = subscriptionData?.stripeSubscription?.currentPeriodEnd || subscriptionData?.endDate || null
  const nextBilling = planKey === "FREE"
    ? "Sin facturación"
    : nextBillingSource
      ? formatDate(nextBillingSource)
      : subscriptionData === null
        ? "Cargando..."
        : "No disponible"

  const handleSaveProfile = async () => {
    const nextName = profileData.name.trim()

    if (!nextName) {
      toast.error("El nombre es obligatorio")
      return
    }
    if (!isProfileDirty) {
      toast.info("No hay cambios por guardar")
      return
    }

    setProfileSaving(true)
    try {
      const response = await apiClient.updateUserProfile({ name: nextName })
      if (response) {
        toast.success("Perfil actualizado")
        await refreshUser()
      } else {
        toast.error("No se pudo actualizar el perfil")
      }
    } catch (error: any) {
      console.error("Profile update error:", error?.message || error)
      toast.error(error?.message || "No se pudo actualizar el perfil")
    } finally {
      setProfileSaving(false)
    }
  }

  const handleChangePassword = async () => {
    if (!passwordData.currentPassword || !passwordData.newPassword || !passwordData.confirmPassword) {
      toast.error("Completa todos los campos de contraseña")
      return
    }
    if (passwordData.newPassword !== passwordData.confirmPassword) {
      toast.error("Las contraseñas no coinciden")
      return
    }
    if (passwordData.newPassword.length < 8) {
      toast.error("La contraseña debe tener al menos 8 caracteres")
      return
    }

    setPasswordSaving(true)
    try {
      const response = await apiClient.changePassword({
        currentPassword: passwordData.currentPassword,
        newPassword: passwordData.newPassword,
      })

      if (response.success) {
        setPasswordData({ currentPassword: "", newPassword: "", confirmPassword: "" })
        toast.success("Contraseña actualizada")
      } else {
        toast.error(response.message || "No se pudo actualizar la contraseña")
      }
    } catch (error: any) {
      console.error("Password update error:", error?.message || error)
      toast.error(error?.message || "No se pudo actualizar la contraseña")
    } finally {
      setPasswordSaving(false)
    }
  }

  return (
    <main className="min-h-screen bg-[#f7f7f8] text-neutral-950">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button asChild variant="ghost" size="sm" className="h-10 rounded-md px-3 text-neutral-600 hover:bg-white hover:text-neutral-950">
            <Link href="/chat">
              <ArrowLeft className="h-4 w-4" />
              {tset("backToChat")}
            </Link>
          </Button>

          <div className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-600 shadow-sm">
            <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
            {t("synced")}
          </div>
        </div>

        <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
          <div className="h-1 w-full bg-[#FF0000]" aria-hidden />
          <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:p-7">
            <div className="flex min-w-0 flex-col gap-5 sm:flex-row sm:items-center">
              <div className="relative w-fit shrink-0">
                <Avatar className="h-24 w-24 border-4 border-white shadow-[0_0_0_2px_rgba(255,0,0,0.22),0_16px_32px_-20px_rgba(255,0,0,0.75)]">
                  <AvatarImage src={user.avatar || undefined} />
                  <AvatarFallback className="bg-[#FF0000] text-4xl font-semibold text-white">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <button
                  type="button"
                  title="Cambiar foto"
                  aria-label="Cambiar foto"
                  className="absolute -bottom-1 -right-1 grid h-9 w-9 place-items-center rounded-md bg-neutral-950 text-white shadow-lg transition hover:bg-[#FF0000] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF0000]/30 focus-visible:ring-offset-2"
                >
                  <Camera className="h-4 w-4" />
                </button>
              </div>

              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <h1 className="break-words text-3xl font-semibold tracking-normal text-neutral-950 sm:text-4xl">
                    {displayName}
                  </h1>
                  <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#FF0000]/20 bg-[#FF0000]/10 px-2.5 text-sm font-medium text-[#CC0000]">
                    <PlanIcon className="h-3.5 w-3.5" />
                    {plan.label}
                  </span>
                  {user.isAdmin && (
                    <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-950 px-2.5 text-sm font-medium text-white">
                      <Shield className="h-3.5 w-3.5" />
                      {t("admin")}
                    </span>
                  )}
                </div>

                <p className="flex min-w-0 items-center gap-2 text-sm text-neutral-600">
                  <Mail className="h-4 w-4 shrink-0 text-neutral-400" />
                  <span className="truncate">{user.email}</span>
                </p>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-600">
                  {t("subtitle")}
                </p>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-3 lg:w-[430px]">
              <SummaryMetric label="Plan" value={plan.label} helper={plan.description} icon={PlanIcon} />
              <SummaryMetric label="Estado" value={status.label} helper={status.helper} icon={BadgeCheck} tone={status.tone} />
              <SummaryMetric label="Uso" value={`${usage.percent}%`} helper={`${usage.remaining.toLocaleString()} ${t("remaining")}`} icon={Activity} />
            </div>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
          <div className="space-y-6">
            <SectionCard
              icon={UserIcon}
              title={t("personalInfo.title")}
              description={t("personalInfo.desc")}
            >
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-sm font-medium text-neutral-800">
                    {t("fullName")}
                  </Label>
                  <Input
                    id="name"
                    value={profileData.name}
                    onChange={(event) => setProfileData({ name: event.target.value })}
                    placeholder={t("fullNamePlaceholder")}
                    className={fieldClassName}
                    autoComplete="name"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email" className="flex items-center gap-1.5 text-sm font-medium text-neutral-800">
                    Email
                    <Lock className="h-3.5 w-3.5 text-neutral-400" />
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    value={user.email}
                    disabled
                    className={cn(fieldClassName, "bg-neutral-50 text-neutral-500 disabled:opacity-100")}
                  />
                  <p className="text-sm leading-5 text-neutral-500">{t("emailImmutable")}</p>
                </div>
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-neutral-100 pt-5 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setProfileData({ name: user.name })}
                  disabled={profileSaving || !isProfileDirty}
                  className="h-11 rounded-md px-4 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950"
                >
                  {t("discard")}
                </Button>
                <Button
                  type="button"
                  onClick={handleSaveProfile}
                  disabled={profileSaving || !isProfileDirty}
                  className={primaryButtonClassName}
                >
                  {profileSaving ? t("saving") : t("save")}
                </Button>
              </div>
            </SectionCard>

            <SectionCard
              icon={KeyRound}
              title={t("security.title")}
              description={t("security.desc")}
            >
              <PasswordField
                id="current-password"
                label={t("currentPassword")}
                value={passwordData.currentPassword}
                onChange={(value) => setPasswordData((previous) => ({ ...previous, currentPassword: value }))}
                visible={showPassword.current}
                onToggle={() => setShowPassword((previous) => ({ ...previous, current: !previous.current }))}
                autoComplete="current-password"
              />

              <div className="grid gap-4 lg:grid-cols-2">
                <PasswordField
                  id="new-password"
                  label={t("newPassword")}
                  value={passwordData.newPassword}
                  onChange={(value) => setPasswordData((previous) => ({ ...previous, newPassword: value }))}
                  visible={showPassword.new}
                  onToggle={() => setShowPassword((previous) => ({ ...previous, new: !previous.new }))}
                  hint={t("minChars")}
                  autoComplete="new-password"
                />
                <PasswordField
                  id="confirm-password"
                  label={t("confirmPassword")}
                  value={passwordData.confirmPassword}
                  onChange={(value) => setPasswordData((previous) => ({ ...previous, confirmPassword: value }))}
                  visible={showPassword.confirm}
                  onToggle={() => setShowPassword((previous) => ({ ...previous, confirm: !previous.confirm }))}
                  autoComplete="new-password"
                />
              </div>

              <div className="flex justify-end border-t border-neutral-100 pt-5">
                <Button
                  type="button"
                  onClick={handleChangePassword}
                  disabled={passwordSaving}
                  className={primaryButtonClassName}
                >
                  {passwordSaving ? t("updatingPassword") : t("updatePassword")}
                </Button>
              </div>
            </SectionCard>
          </div>

          <aside className="space-y-6 xl:sticky xl:top-6 xl:self-start">
            <SectionCard
              icon={CreditCard}
              title={t("subscription.title")}
              description={t("subscription.desc")}
              compact
            >
              <div className="rounded-md border border-[#FF0000]/15 bg-[#FF0000]/[0.04] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-[#FF0000] text-white">
                      <PlanIcon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <p className="font-semibold text-neutral-950">{plan.label}</p>
                      <p className="mt-0.5 text-sm leading-5 text-neutral-600">{plan.description}</p>
                    </div>
                  </div>
                  <span className={cn(
                    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium",
                    status.tone === "ok"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-amber-50 text-amber-700",
                  )}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", status.tone === "ok" ? "bg-emerald-500" : "bg-amber-500")} />
                    {status.label}
                  </span>
                </div>

                <div className="mt-4 flex items-center gap-2 border-t border-[#FF0000]/10 pt-4 text-sm text-neutral-600">
                  <Calendar className="h-4 w-4 text-neutral-400" />
                  <span>{t("nextBilling")}:</span>
                  <span className="font-medium text-neutral-950">{nextBilling}</span>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                className="h-11 w-full rounded-md border-neutral-200 bg-white font-medium hover:border-[#FF0000]/30 hover:bg-[#FF0000]/[0.03] hover:text-[#CC0000]"
                onClick={() => router.push("/billing")}
              >
                {t("manageSubscription")}
              </Button>
            </SectionCard>

            <SectionCard
              icon={Activity}
              title={t("usage.title")}
              description={planKey === "FREE" ? t("usage.subtitleCalls") : t("usage.subtitleTokens")}
              compact
            >
              <div className="space-y-4">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="text-4xl font-semibold tracking-normal text-neutral-950 tabular-nums">
                      {usage.used.toLocaleString()}
                    </p>
                    <p className="mt-1 text-sm text-neutral-500">
                      / {usage.total.toLocaleString()} {usageUnit}
                    </p>
                  </div>
                  <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-right">
                    <p className="text-sm font-medium text-neutral-950 tabular-nums">{usage.percent}%</p>
                    <p className="text-xs text-neutral-500">{t("used")}</p>
                  </div>
                </div>

                <Progress value={usage.percent} className="h-2.5 bg-neutral-100 [&>div]:bg-[#FF0000]" />

                <div className="flex justify-between text-sm text-neutral-500 tabular-nums">
                  <span>{usage.percent}% {t("used")}</span>
                  <span>{usage.remaining.toLocaleString()} {t("remaining")}</span>
                </div>

                {usageTone !== "ok" && (
                  <div className={cn(
                    "flex items-start gap-2 rounded-md border p-3 text-sm leading-5",
                    usageTone === "danger"
                      ? "border-[#FF0000]/20 bg-[#FF0000]/[0.04] text-[#B80000]"
                      : "border-amber-200 bg-amber-50 text-amber-800",
                  )}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {usageTone === "danger"
                        ? "Te queda muy poco cupo este mes. Actualiza tu plan para evitar interrupciones."
                        : "Ya superaste el 70% de tu cupo mensual."}
                    </span>
                  </div>
                )}
              </div>
            </SectionCard>

            {user.isAdmin && (
              <SectionCard
                icon={Shield}
                title="Acceso de administrador"
                description="Privilegios activos"
                compact
              >
                <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" />
                  Cuenta con permisos administrativos
                </div>
                <Button asChild className={primaryButtonClassName}>
                  <Link href="/admin">Abrir panel de admin</Link>
                </Button>
              </SectionCard>
            )}
          </aside>
        </div>
      </div>
    </main>
  )
}

const fieldClassName =
  "h-11 rounded-md border-neutral-200 bg-white text-base text-neutral-950 shadow-none transition placeholder:text-neutral-400 focus-visible:border-[#FF0000] focus-visible:ring-[#FF0000]/20"

const primaryButtonClassName =
  "h-11 rounded-md bg-[#FF0000] px-5 font-medium text-white shadow-sm shadow-[#FF0000]/20 transition hover:bg-[#E60000] focus-visible:ring-[#FF0000]/30 disabled:bg-neutral-200 disabled:text-neutral-500 disabled:shadow-none"

function SectionCard({
  icon: Icon,
  title,
  description,
  compact = false,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
  compact?: boolean
  children: ReactNode
}) {
  return (
    <Card className="overflow-hidden rounded-lg border-neutral-200 bg-white shadow-sm">
      <CardHeader className={cn("flex-row items-start gap-3 space-y-0 border-b border-neutral-100", compact ? "p-5" : "p-5 sm:p-6")}>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-[#FF0000]/10 text-[#FF0000]">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <CardTitle className="text-xl font-semibold leading-7 tracking-normal text-neutral-950">
            {title}
          </CardTitle>
          <CardDescription className="mt-1 text-sm leading-5 text-neutral-500">
            {description}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className={cn("space-y-5", compact ? "p-5" : "p-5 sm:p-6")}>
        {children}
      </CardContent>
    </Card>
  )
}

function SummaryMetric({
  label,
  value,
  helper,
  icon: Icon,
  tone = "neutral",
}: {
  label: string
  value: string
  helper: string
  icon: ComponentType<{ className?: string }>
  tone?: "neutral" | "ok" | "warn"
}) {
  return (
    <div className="min-w-0 rounded-md border border-neutral-200 bg-neutral-50 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase text-neutral-500">
        <Icon className={cn("h-3.5 w-3.5", tone === "ok" ? "text-emerald-600" : tone === "warn" ? "text-amber-600" : "text-[#FF0000]")} />
        {label}
      </div>
      <p className="truncate text-sm font-semibold text-neutral-950">{value}</p>
      <p className="mt-1 line-clamp-2 text-xs leading-4 text-neutral-500">{helper}</p>
    </div>
  )
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  visible,
  onToggle,
  hint,
  autoComplete,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  visible: boolean
  onToggle: () => void
  hint?: string
  autoComplete?: string
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-medium text-neutral-800">
        {label}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn(fieldClassName, "pr-12")}
          autoComplete={autoComplete}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1/2 h-9 w-9 -translate-y-1/2 rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-950"
          onClick={onToggle}
          aria-label={visible ? "Ocultar contraseña" : "Mostrar contraseña"}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
      </div>
      {hint && <p className="text-sm leading-5 text-neutral-500">{hint}</p>}
    </div>
  )
}

function normalizePlan(plan?: string | null): PlanKey {
  if (plan === "ENTERPRISE" || plan === "PRO_MAX" || plan === "PRO" || plan === "FREE") {
    return plan
  }
  return "FREE"
}

function getInitials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

function getUsageModel({
  plan,
  monthlyLimit,
  apiUsage,
}: {
  plan: PlanKey
  monthlyLimit: number
  apiUsage: number
}) {
  const total = plan === "FREE" ? 3 : Math.max(0, monthlyLimit)
  const used = plan === "FREE" ? Math.max(0, total - monthlyLimit) : Math.max(0, apiUsage)
  const remaining = Math.max(0, total - used)
  const percent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0

  return { total, used, remaining, percent }
}

function getSubscriptionStatus(status: string) {
  const normalized = status.toLowerCase()

  if (normalized === "active") {
    return { label: "Activo", helper: "Cuenta sincronizada", tone: "ok" as const }
  }
  if (normalized === "trialing") {
    return { label: "Prueba", helper: "Periodo de prueba activo", tone: "ok" as const }
  }
  if (normalized === "past_due") {
    return { label: "Pago pendiente", helper: "Revisa tu facturación", tone: "warn" as const }
  }
  if (normalized === "canceled" || normalized === "cancelled") {
    return { label: "Cancelado", helper: "Suscripción sin renovar", tone: "warn" as const }
  }

  return {
    label: normalized.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase()),
    helper: "Estado de suscripción",
    tone: "warn" as const,
  }
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "No disponible"

  return new Intl.DateTimeFormat("es", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date)
}
