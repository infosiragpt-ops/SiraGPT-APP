"use client"

import * as React from "react"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, Check, Eye, EyeOff} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { useAuth } from "@/lib/auth-context-integrated"
import { getNormalizedApiBaseUrl } from "@/lib/api"
import { useBackendReady } from "@/lib/use-backend-ready"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
export default function LoginPage() {
  const t = useTranslations("auth")
  const [showPassword, setShowPassword] = React.useState(false)
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [isLoading, setIsLoading] = React.useState(false)
  const [emailError, setEmailError] = React.useState<string | null>(null)
  const [passwordError, setPasswordError] = React.useState<string | null>(null)
  const [googleLoading, setGoogleLoading] = React.useState(false)

  const { login, user } = useAuth()
  const router = useRouter()

  // Prefetch the post-login destination so the jump to /chat after a
  // successful sign-in is instant instead of waiting on the (large) chat
  // bundle to download at navigation time.
  React.useEffect(() => {
    try { router.prefetch("/chat") } catch { /* prefetch is best-effort */ }
  }, [router])

  // Right after a publish the backend is still booting (~90s) while the
  // frontend is already live, so any /api/* call (including the Google OAuth
  // redirect) returns a raw "Internal Server Error". Track backend readiness
  // and, if the user acts during that window, queue the action and run it
  // automatically once the backend answers instead of failing.
  const backendState = useBackendReady()
  const [pendingAction, setPendingAction] = React.useState<null | "google" | "email">(null)

  const goToGoogle = React.useCallback(() => {
    window.location.href = `${getNormalizedApiBaseUrl()}/auth/google`
  }, [])

  // Surface the `?error=…` query the auth/callback page may pass on
  // a failed OAuth round-trip ("La sesión es inválida o expiró",
  // "Error de autenticación", etc.) so the user gets a clear toast
  // explaining why they're back on the login form instead of /chat.
  // Known short codes (auth_failed, db_unavailable) get a friendly
  // Spanish message; anything else falls through as-is so the
  // auth/callback page can still pass a custom message string.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const errorMsg = params.get("error")
    if (errorMsg) {
      const friendly: Record<string, string> = {
        auth_failed:
          "No pudimos completar el inicio de sesión con Google. Inténtalo de nuevo.",
        db_unavailable:
          "Estamos teniendo problemas para conectar con la base de datos. Inténtalo de nuevo en unos segundos.",
      }
      toast.error(friendly[errorMsg] ?? errorMsg)
      // Clean the URL so a refresh doesn't re-toast the same error
      params.delete("error")
      const cleaned = params.toString()
      const target = window.location.pathname + (cleaned ? `?${cleaned}` : "")
      window.history.replaceState(null, "", target)
    }
  }, [])

  const handleBack = () => {
    if (window.history.length > 1) {
      router.back()
      return
    }

    router.push("/auth")
  }

  // Redirect if already logged in
  React.useEffect(() => {
    if (user) {
      router.push("/chat")
    }
  }, [user, router])

  const runLogin = React.useCallback(async () => {
    setIsLoading(true)

    try {
      const success = await login(email.trim(), password)
      if (success) {
        toast.success(t("signIn"))
        // Explicit redirect — don't rely solely on the useEffect that
        // watches `user`. In dev mode, state updates can race with the
        // setIsLoading(false) and leave the user stuck on the login
        // screen even though the auth context has the user. A direct
        // push guarantees navigation immediately after a successful
        // login, regardless of when the AuthContext re-renders.
        router.push("/chat")
      } else {
        toast.error(t("invalidCreds"))
      }
    } catch (error) {
      toast.error(t("invalidCreds"))
    } finally {
      setIsLoading(false)
    }
  }, [email, password, login, router, t])

  // Lightweight client-side validation so users get immediate, field-level
  // feedback instead of a round-trip that returns a generic "invalid
  // credentials" toast. Keeps the same lenient contract as the backend
  // (any non-empty password is allowed — legacy accounts may have weak ones).
  const validateForm = React.useCallback(() => {
    let ok = true
    const trimmedEmail = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setEmailError(t("emailInvalid"))
      ok = false
    } else {
      setEmailError(null)
    }
    if (!password) {
      setPasswordError(t("passwordRequired"))
      ok = false
    } else {
      setPasswordError(null)
    }
    return ok
  }, [email, password, t])

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateForm()) return
    // If the backend is still warming up after a publish, queue the login and
    // let the effect below fire it once the backend is ready, rather than
    // showing a misleading "invalid credentials" error from a 500.
    if (backendState !== "ready") {
      setPendingAction("email")
      return
    }
    void runLogin()
  }

  const handleGoogle = () => {
    setGoogleLoading(true)
    if (backendState === "ready") {
      goToGoogle()
      return
    }
    // Warming up: queue the redirect; the effect runs it once ready.
    setPendingAction("google")
  }

  // Once the backend reports ready, flush any action the user queued while it
  // was still booting.
  React.useEffect(() => {
    if (backendState !== "ready" || !pendingAction) return
    const action = pendingAction
    setPendingAction(null)
    if (action === "google") {
      goToGoogle()
    } else if (action === "email") {
      void runLogin()
    }
  }, [backendState, pendingAction, goToGoogle, runLogin])

  const isWarming = backendState === "warming" || (backendState !== "ready" && pendingAction !== null)

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
        data-testid="login-card"
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
              data-testid="login-back-button"
            >
              <ArrowLeft className="h-4 w-4" />
              Volver
            </Button>
            <div
              data-testid="login-logo"
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
            {t("welcomeBack")}
          </CardTitle>
          <CardDescription className="text-neutral-600">{t("tagline")}</CardDescription>
        </CardHeader>

        <CardContent>
          {isWarming && (
            <div
              role="status"
              aria-live="polite"
              data-testid="login-server-warming"
              className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"
            >
              <ThinkingIndicator size="sm" />
              <span>{t("serverWarming")}</span>
            </div>
          )}

          {/* Social-first: Google sign-in is the primary path, above the form. */}
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
            {pendingAction === "google" ? t("serverWarmingButton") : t("continueWithGoogle")}
          </Button>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <Separator className="w-full" />
            </div>
            <div className="relative flex justify-center text-xs uppercase tracking-wider">
              <span className="bg-white px-2 text-neutral-500">{t("orWithEmail")}</span>
            </div>
          </div>

          <form onSubmit={handleLogin} noValidate className="space-y-4">
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
                value={email}
                onChange={(e) => { setEmail(e.target.value); if (emailError) setEmailError(null) }}
                required
                disabled={isLoading}
                aria-invalid={emailError ? true : undefined}
                aria-describedby={emailError ? "email-error" : undefined}
                className={`${fieldClassName}${emailError ? " border-red-400" : ""}`}
              />
              {emailError && (
                <p id="email-error" role="alert" className="text-sm text-red-600">
                  {emailError}
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
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={t("passwordPlaceholder")}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); if (passwordError) setPasswordError(null) }}
                  required
                  disabled={isLoading}
                  aria-invalid={passwordError ? true : undefined}
                  aria-describedby={passwordError ? "password-error" : undefined}
                  className={`${fieldClassName} pr-11${passwordError ? " border-red-400" : ""}`}
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
              {passwordError && (
                <p id="password-error" role="alert" className="text-sm text-red-600">
                  {passwordError}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between">
              <Link
                href="/auth/forgot-password"
                className="text-sm text-neutral-600 underline-offset-4 hover:text-neutral-900 hover:underline"
              >
                {t("forgotPassword")}
              </Link>
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
                t("signIn")
              )}
            </Button>
          </form>
        </CardContent>

        <CardFooter className="justify-center text-center">
          <p className="text-sm text-neutral-600">
            {t("noAccount")}{" "}
            <Link
              href="/auth/register"
              className="font-semibold text-neutral-900 underline decoration-neutral-900/30 underline-offset-4 transition-colors hover:decoration-neutral-900"
            >
              {t("signUp")}
            </Link>
          </p>
        </CardFooter>
      </Card>
      </main>
    </div>
  )
}
