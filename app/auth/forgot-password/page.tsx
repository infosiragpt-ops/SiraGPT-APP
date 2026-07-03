"use client"

import * as React from "react"
import Image from "next/image"
import Link from "next/link"
import { ArrowLeft, Mail, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { getNormalizedApiBaseUrl } from "@/lib/api"
import { useBackendReady } from "@/lib/use-backend-ready"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

function ForgotPasswordPageContent() {
  const t = useTranslations("auth")
  const [email, setEmail] = React.useState("")
  const [isLoading, setIsLoading] = React.useState(false)
  const [sent, setSent] = React.useState(false)
  const [emailError, setEmailError] = React.useState<string | null>(null)

  const backendState = useBackendReady()

  const validateEmail = React.useCallback(() => {
    const trimmed = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailError(t("emailInvalid"))
      return false
    }
    setEmailError(null)
    return true
  }, [email, t])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateEmail()) return
    if (backendState === "warming") return

    setIsLoading(true)
    try {
      const res = await fetch(`${getNormalizedApiBaseUrl()}/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      })
      if (res.ok) {
        setSent(true)
        toast.success(t("resetLinkSent"))
      } else {
        toast.error(t("resetRequestFailed"))
      }
    } catch {
      toast.error(t("resetRequestFailed"))
    } finally {
      setIsLoading(false)
    }
  }

  const handleBack = () => {
    window.history.length > 1 ? window.history.back() : (window.location.href = "/auth/login")
  }

  const fieldClassName =
    "border-neutral-300 bg-white text-neutral-900 placeholder:text-neutral-500 focus-visible:border-neutral-900 focus-visible:ring-neutral-900/15"

  return (
    <div className="flex min-h-[100svh] bg-neutral-50 text-neutral-950 sm:min-h-screen" style={{ colorScheme: "light" }}>
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
        <div className="relative">
          <h2 className="max-w-md text-4xl font-semibold leading-[1.15] tracking-tight">
            {t("forgotPasswordTitle")}
          </h2>
        </div>
        <div className="relative text-sm text-white/50">{t("brandFooter")}</div>
      </aside>

      <main className="flex w-full flex-col items-center justify-center overflow-y-auto px-4 py-6 sm:py-10 lg:w-[55%]">
        <Card className="w-full max-w-md border-neutral-200 bg-white text-neutral-950 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.18)]">
          <CardHeader className="px-6 pt-7 text-center sm:px-8 sm:pt-8">
            <div className="mb-5 grid grid-cols-[1fr_auto_1fr] items-center">
              <Button
                type="button"
                variant="ghost"
                onClick={handleBack}
                className="h-9 w-fit gap-1.5 justify-self-start rounded-full border border-neutral-200 bg-white/90 px-3 text-sm font-medium text-neutral-700 shadow-sm backdrop-blur transition hover:bg-neutral-50 hover:text-neutral-950"
                aria-label="Volver atras"
              >
                <ArrowLeft className="h-4 w-4" />
                {t("back")}
              </Button>
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-neutral-200 bg-white">
                <Image src="/sira-gpt.png" alt="" width={40} height={40} className="rounded-lg object-contain" />
              </div>
              <div aria-hidden="true" />
            </div>
            <CardTitle className="text-2xl font-semibold tracking-tight text-neutral-900">
              {t("forgotPassword")}
            </CardTitle>
            <CardDescription className="text-neutral-600">{t("forgotPasswordSubtitle")}</CardDescription>
          </CardHeader>

          <CardContent>
            {sent ? (
              <div className="flex flex-col items-center gap-4 py-6 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-50 ring-1 ring-green-200">
                  <Check className="h-7 w-7 text-green-600" />
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-neutral-900">{t("resetLinkSent")}</p>
                  <p className="text-sm text-neutral-600">{t("resetLinkSentDescription")}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => { setSent(false); setEmail("") }}
                  className="border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100"
                >
                  {t("tryAgain")}
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} noValidate className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-neutral-900">
                    {t("email")}
                  </Label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
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
                      className={`${fieldClassName} pl-10${emailError ? " border-red-400" : ""}`}
                    />
                  </div>
                  {emailError && (
                    <p id="email-error" role="alert" className="text-sm text-red-600">
                      {emailError}
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
                      {t("sending")}
                    </>
                  ) : (
                    t("sendResetLink")
                  )}
                </Button>
              </form>
            )}
          </CardContent>

          <CardFooter className="justify-center text-center">
            <p className="text-sm text-neutral-600">
              <Link
                href="/auth/login"
                className="font-semibold text-neutral-900 underline decoration-neutral-900/30 underline-offset-4 transition-colors hover:decoration-neutral-900"
              >
                {t("backToLogin")}
              </Link>
            </p>
          </CardFooter>
        </Card>
      </main>
    </div>
  )
}

export default function ForgotPasswordPage() {
  return (
    <React.Suspense fallback={null}>
      <ForgotPasswordPageContent />
    </React.Suspense>
  )
}
