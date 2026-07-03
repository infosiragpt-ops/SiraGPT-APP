"use client"

import * as React from "react"
import Image from "next/image"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, Check, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { useAuth } from "@/lib/auth-context-integrated"
import { getNormalizedApiBaseUrl } from "@/lib/api"
import { useBackendReady } from "@/lib/use-backend-ready"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

type FieldErrors = {
  name?: string
  email?: string
  password?: string
  confirmPassword?: string
  agreeToTerms?: string
}

function safeAuthRedirect(raw: string | null) {
  const value = String(raw || "").trim()
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/chat"
  try {
    const url = new URL(value, "https://siragpt.local")
    if (url.pathname.startsWith("/api") || url.pathname.startsWith("/auth")) return "/chat"
    return `${url.pathname}${url.search}${url.hash}` || "/chat"
  } catch (_error) {
    return "/chat"
  }
}

function RegisterPageContent() {
  const t = useTranslations("auth")
  const [showPassword, setShowPassword] = React.useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = React.useState(false)
  const [isLoading, setIsLoading] = React.useState(false)
  const [googleLoading, setGoogleLoading] = React.useState(false)
  const [formData, setFormData] = React.useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    agreeToTerms: false,
  })
  const [errors, setErrors] = React.useState<FieldErrors>({})

  const { register, user } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const postRegisterRedirect = React.useMemo(
    () => safeAuthRedirect(searchParams.get("next")),
    [searchParams],
  )
  const loginHref = postRegisterRedirect === "/chat"
    ? "/auth/login"
    : `/auth/login?next=${encodeURIComponent(postRegisterRedirect)}`

  // Prefetch the post-signup destination so the jump is instant.
  React.useEffect(() => {
    try { router.prefetch(postRegisterRedirect) } catch { /* prefetch is best-effort */ }
  }, [postRegisterRedirect, router])

  // Backend may still be booting right after a publish — queue the action and
  // run it once it answers instead of showing a misleading 500 error.
  const backendState = useBackendReady()
  const [pendingAction, setPendingAction] = React.useState<null | "google" | "register">(null)

  const goToGoogle = React.useCallback(() => {
    window.location.href = `${getNormalizedApiBaseUrl()}/auth/google`
  }, [])

  // Redirect if already logged in
  React.useEffect(() => {
    if (user) {
      router.push(postRegisterRedirect)
    }
  }, [postRegisterRedirect, user, router])

  const handleBack = () => {
    if (window.history.length > 1) {
      router.back()
      return
    }
    router.push("/auth")
  }

  const runRegister = React.useCallback(async () => {
    setIsLoading(true)
    try {
      const success = await register(formData.name.trim(), formData.email.trim(), formData.password)
      if (success) {
        toast.success("Cuenta creada con éxito")
        router.push(postRegisterRedirect)
      } else {
        toast.error("No se pudo crear la cuenta. Inténtalo de nuevo.")
      }
    } catch (error) {
      toast.error("No se pudo crear la cuenta. Inténtalo de nuevo.")
    } finally {
      setIsLoading(false)
    }
  }, [formData.name, formData.email, formData.password, postRegisterRedirect, register, router])

  // Inline, field-level validation (mirrors the login page) so users get
  // immediate feedback instead of a sequence of toasts.
  const validateForm = React.useCallback(() => {
    const next: FieldErrors = {}
    if (!formData.name.trim()) next.name = t("nameRequired")
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email.trim())) next.email = t("emailInvalid")
    if (formData.password.length < 6) next.password = t("passwordTooShort")
    if (formData.confirmPassword !== formData.password) next.confirmPassword = t("passwordsNoMatch")
    if (!formData.agreeToTerms) next.agreeToTerms = t("agreeTermsRequired")
    setErrors(next)
    return Object.keys(next).length === 0
  }, [formData, t])

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateForm()) return
    // Defer ONLY during a confirmed post-publish warmup (a real 503 from the
    // readiness route). In "checking" the backend is reachable even while the
    // Next.js dev server is busy compiling a heavy route, so gating on "ready"
    // there would trap the user with a button that silently queues forever.
    if (backendState === "warming") {
      setPendingAction("register")
      return
    }
    void runRegister()
  }

  const handleGoogle = () => {
    setGoogleLoading(true)
    // goToGoogle() is a full-page redirect we cannot catch, so during a
    // confirmed warmup we queue it and let the effect fire it once ready.
    // "checking"/"ready" proceed now — the backend stays reachable mid-compile.
    if (backendState === "warming") {
      setPendingAction("google")
      return
    }
    goToGoogle()
  }

  // Flush a queued action once the backend reports ready.
  React.useEffect(() => {
    if (backendState !== "ready" || !pendingAction) return
    const action = pendingAction
    setPendingAction(null)
    if (action === "google") {
      goToGoogle()
    } else if (action === "register") {
      void runRegister()
    }
  }, [backendState, pendingAction, goToGoogle, runRegister])

  // Only surface the amber "server is starting" banner when the readiness
  // poller has *confirmed* the backend is warming (repeated probe failures).
  // The previous `pendingAction` term also raised it during the sub-second
  // "checking" window before the first probe resolves, so a quick click on a
  // healthy backend flashed the alarming banner for no reason. A queued action
  // is still reflected by the button spinner below.
  const isWarming = backendState === "warming"

  const handleInputChange = (field: keyof typeof formData, value: string | boolean) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => (prev[field as keyof FieldErrors] ? { ...prev, [field]: undefined } : prev))
  }

  const fieldClassName =
    "border-neutral-300 bg-white text-neutral-900 placeholder:text-neutral-500 focus-visible:border-neutral-900 focus-visible:ring-neutral-900/15"

  return (
    <div className="flex min-h-[100svh] bg-neutral-50 text-neutral-950 sm:min-h-screen" style={{ colorScheme: "light" }}>
      {/* Brand panel — premium marketing rail (desktop only) */}
      <aside
        className="relative hidden w-[45%] flex-col justify-between overflow-hidden p-12 text-white lg:flex xl:p-14"
        style={{ backgroundColor: "#0a0a0a", colorScheme: "dark" }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(55% 45% at 12% 12%, rgba(124,58,237,0.28), transparent 70%), radial-gradient(50% 45% at 100% 100%, rgba(79,70,229,0.20), transparent 70%)",
          }}
        />

        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/15 backdrop-blur">
            <Image src="/sira-gpt.png" alt="" width={28} height={28} className="rounded-md object-contain" />
          </div>
          <span className="text-lg font-semibold tracking-tight">SiraGPT</span>
        </div>

        <div className="relative space-y-8">
          <h2 className="max-w-md text-4xl font-semibold leading-[1.15] tracking-tight">
            {t("brandTagline")}
          </h2>
          <ul className="space-y-4">
            {[t("brandFeature1"), t("brandFeature2"), t("brandFeature3")].map((feature) => (
              <li key={feature} className="flex items-start gap-3 text-white/80">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
                  <Check className="h-3.5 w-3.5 text-white" />
                </span>
                <span className="text-[15px] leading-6">{feature}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative text-sm text-white/50">{t("brandFooter")}</div>
      </aside>

      {/* Form panel */}
      <main className="flex w-full flex-col items-center justify-center overflow-y-auto px-4 py-6 sm:py-10 lg:w-[55%]">
      <Card
        data-testid="register-card"
        className="w-full max-w-md border-neutral-200 bg-white text-neutral-950 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.18)]"
      >
        <CardHeader className="px-6 pt-7 text-center sm:px-8 sm:pt-8">
          <div className="mb-5 grid grid-cols-[1fr_auto_1fr] items-center">
            <Button
              type="button"
              variant="ghost"
              onClick={handleBack}
              className="h-9 w-fit gap-1.5 justify-self-start rounded-full border border-neutral-200 bg-white/90 px-3 text-sm font-medium text-neutral-700 shadow-sm backdrop-blur transition hover:bg-neutral-50 hover:text-neutral-950"
              aria-label="Volver atras"
              data-testid="register-back-button"
            >
              <ArrowLeft className="h-4 w-4" />
              Volver
            </Button>
            <div
              data-testid="register-logo"
              className="flex h-14 w-14 items-center justify-center rounded-2xl border border-neutral-200 bg-white"
            >
              <Image
                src="/sira-gpt.png"
                alt=""
                width={40}
                height={40}
                className="rounded-lg object-contain"
              />
            </div>
            <div aria-hidden="true" />
          </div>
          <CardTitle className="text-2xl font-semibold tracking-tight text-neutral-900">
            {t("createYourAccount")}
          </CardTitle>
          <CardDescription className="text-neutral-600">{t("registerTagline")}</CardDescription>
        </CardHeader>

        <CardContent>
          {isWarming && (
            <div
              role="status"
              aria-live="polite"
              data-testid="register-server-warming"
              className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"
            >
              <ThinkingIndicator size="sm" />
              <span>{t("serverWarming")}</span>
            </div>
          )}

          {/* Social-first: Google sign-up is the primary path, above the form. */}
          <Button
            variant="outline"
            type="button"
            disabled={isLoading || googleLoading}
            onClick={handleGoogle}
            className="h-11 w-full border-neutral-300 bg-white font-medium text-neutral-900 hover:bg-neutral-100"
          >
            {(googleLoading || pendingAction === "google") ? (
              <ThinkingIndicator size="sm" className="mr-2" />
            ) : (
              <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
            )}
            {pendingAction === "google" ? t("serverWarmingButton") : t("signUpWithGoogle")}
          </Button>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <Separator className="w-full" />
            </div>
            <div className="relative flex justify-center text-xs uppercase tracking-wider">
              <span className="bg-white px-2 text-neutral-500">{t("orWithEmail")}</span>
            </div>
          </div>

          <form onSubmit={handleRegister} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name" className="text-neutral-900">
                {t("name")}
              </Label>
              <Input
                id="name"
                type="text"
                autoComplete="name"
                placeholder={t("namePlaceholder")}
                value={formData.name}
                onChange={(e) => handleInputChange("name", e.target.value)}
                required
                disabled={isLoading}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? "name-error" : undefined}
                className={`${fieldClassName}${errors.name ? " border-red-400" : ""}`}
              />
              {errors.name && (
                <p id="name-error" role="alert" className="text-sm text-red-600">
                  {errors.name}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="email" className="text-neutral-900">
                {t("email")}
              </Label>
              <Input
                id="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t("emailPlaceholder")}
                value={formData.email}
                onChange={(e) => handleInputChange("email", e.target.value)}
                required
                disabled={isLoading}
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={errors.email ? "email-error" : undefined}
                className={`${fieldClassName}${errors.email ? " border-red-400" : ""}`}
              />
              {errors.email && (
                <p id="email-error" role="alert" className="text-sm text-red-600">
                  {errors.email}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-neutral-900">
                {t("password")}
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder={t("passwordPlaceholder")}
                  value={formData.password}
                  onChange={(e) => handleInputChange("password", e.target.value)}
                  required
                  disabled={isLoading}
                  aria-invalid={errors.password ? true : undefined}
                  aria-describedby={errors.password ? "password-error" : undefined}
                  className={`${fieldClassName} pr-11${errors.password ? " border-red-400" : ""}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 py-2 text-neutral-600 hover:bg-transparent hover:text-neutral-900"
                  onClick={() => setShowPassword(!showPassword)}
                  disabled={isLoading}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {errors.password ? (
                <p id="password-error" role="alert" className="text-sm text-red-600">
                  {errors.password}
                </p>
              ) : (
                <p className="text-xs text-neutral-500">{t("passwordMinHint")}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword" className="text-neutral-900">
                {t("confirmPassword")}
              </Label>
              <div className="relative">
                <Input
                  id="confirmPassword"
                  type={showConfirmPassword ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder={t("passwordPlaceholder")}
                  value={formData.confirmPassword}
                  onChange={(e) => handleInputChange("confirmPassword", e.target.value)}
                  required
                  disabled={isLoading}
                  aria-invalid={errors.confirmPassword ? true : undefined}
                  aria-describedby={errors.confirmPassword ? "confirm-error" : undefined}
                  className={`${fieldClassName} pr-11${errors.confirmPassword ? " border-red-400" : ""}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 py-2 text-neutral-600 hover:bg-transparent hover:text-neutral-900"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  disabled={isLoading}
                >
                  {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {errors.confirmPassword && (
                <p id="confirm-error" role="alert" className="text-sm text-red-600">
                  {errors.confirmPassword}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="terms"
                  checked={formData.agreeToTerms}
                  onCheckedChange={(checked) => handleInputChange("agreeToTerms", checked as boolean)}
                  disabled={isLoading}
                  className="border-neutral-900 data-[state=checked]:bg-neutral-900 data-[state=checked]:text-white"
                />
                <Label htmlFor="terms" className="text-sm text-neutral-700">
                  <span>{t("agreeTermsPrefix")} </span>
                  <Link href="/terms" className="font-medium text-neutral-900 underline decoration-neutral-900/30 underline-offset-4 hover:decoration-neutral-900" target="_blank" rel="noopener noreferrer">
                    {t("agreeTermsLink")}
                  </Link>
                  <span> {t("agreeTermsAnd")} </span>
                  <Link href="/privacy-policy" className="font-medium text-neutral-900 underline decoration-neutral-900/30 underline-offset-4 hover:decoration-neutral-900" target="_blank" rel="noopener noreferrer">
                    {t("agreePrivacyLink")}
                  </Link>
                </Label>
              </div>
              {errors.agreeToTerms && (
                <p role="alert" className="text-sm text-red-600">
                  {errors.agreeToTerms}
                </p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full bg-neutral-900 font-semibold text-white shadow-sm hover:bg-neutral-800"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <ThinkingIndicator size="sm" className="mr-2" />
                  {t("signingIn")}
                </>
              ) : (
                t("signUp")
              )}
            </Button>
          </form>
        </CardContent>

        <CardFooter className="justify-center text-center">
          <p className="text-sm text-neutral-600">
            {t("haveAccount")}{" "}
            <Link
              href={loginHref}
              className="font-semibold text-neutral-900 underline decoration-neutral-900/30 underline-offset-4 transition-colors hover:decoration-neutral-900"
            >
              {t("signIn")}
            </Link>
          </p>
        </CardFooter>
      </Card>
      </main>
    </div>
  )
}

export default function RegisterPage() {
  return (
    <React.Suspense fallback={null}>
      <RegisterPageContent />
    </React.Suspense>
  )
}
