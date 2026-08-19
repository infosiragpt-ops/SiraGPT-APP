"use client"

import * as React from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, LogIn, MailCheck, UserPlus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { apiClient } from "@/lib/api"
import { useAuth } from "@/lib/auth-context-integrated"

type InviteState = "checking" | "redirecting" | "accepting" | "accepted" | "verification" | "error"

function safeReturnPath(raw: string | null) {
  if (!raw) return "/chat"
  try {
    const baseOrigin = typeof window !== "undefined" ? window.location.origin : "https://siragpt.com"
    const url = new URL(raw, baseOrigin)
    if (url.origin !== baseOrigin) return "/chat"
    if (url.pathname.startsWith("/api") || url.pathname.startsWith("/auth")) return "/chat"
    return `${url.pathname}${url.search}${url.hash}` || "/chat"
  } catch (_error) {
    return "/chat"
  }
}

function OrganizationInvitationPageContent() {
  const params = useParams<{ token?: string | string[] }>()
  const searchParams = useSearchParams()
  const router = useRouter()
  const { user, isLoading } = useAuth()
  const [state, setState] = React.useState<InviteState>("checking")
  const [error, setError] = React.useState("")
  const acceptStartedRef = React.useRef(false)

  const token = React.useMemo(() => {
    const raw = params?.token
    return Array.isArray(raw) ? raw[0] || "" : raw || ""
  }, [params])

  const search = searchParams.toString()
  const nextPath = React.useMemo(() => safeReturnPath(searchParams.get("next")), [searchParams])

  React.useEffect(() => {
    if (isLoading) return

    if (!token || token.length < 16) {
      setState("error")
      setError("La invitación no es válida o está incompleta.")
      return
    }

    if (!user) {
      setState("redirecting")
      const currentPath = `/orgs/invitation/${encodeURIComponent(token)}${search ? `?${search}` : ""}`
      router.replace(`/auth/login?next=${encodeURIComponent(currentPath)}`)
      return
    }

    if (acceptStartedRef.current) return
    acceptStartedRef.current = true
    setState("accepting")

    apiClient.acceptOrganizationInvitation(token)
      .then((result) => {
        if (result?.needs_verification) {
          setState("verification")
          return
        }

        setState("accepted")
        const orgName = result?.organization?.name || "tu equipo"
        toast.success(`Te uniste a ${orgName}.`)
        window.setTimeout(() => {
          router.replace(nextPath)
        }, 900)
      })
      .catch((err) => {
        const message = err?.message || "No pudimos aceptar esta invitación."
        setState("error")
        setError(message)
      })
  }, [isLoading, nextPath, router, search, token, user])

  const isBusy = state === "checking" || state === "redirecting" || state === "accepting"
  const title =
    state === "accepted"
      ? "Invitación aceptada"
      : state === "verification"
        ? "Verifica tu correo"
        : state === "error"
          ? "No se pudo aceptar"
      : "Aceptando invitación"

  const description =
    state === "accepted"
      ? "Tu acceso al equipo ya quedó activo en SiraGPT."
      : state === "verification"
        ? "Antes de unirte al equipo necesitamos confirmar que este correo te pertenece."
        : state === "error"
          ? error
          : state === "redirecting"
            ? "Inicia sesión con el correo invitado para continuar."
            : "Estamos validando el enlace y preparando tu acceso."

  return (
    <main className="flex min-h-[100svh] items-center justify-center bg-neutral-50 px-4 py-8 text-neutral-950">
      <Card className="w-full max-w-md border-neutral-200 bg-white shadow-[0_24px_64px_-20px_rgba(15,23,42,0.24)]">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 text-[#FF0000] ring-1 ring-red-100">
            {state === "accepted" ? (
              <CheckCircle2 className="h-7 w-7" />
            ) : state === "verification" ? (
              <MailCheck className="h-7 w-7" />
            ) : state === "error" ? (
              <AlertTriangle className="h-7 w-7" />
            ) : state === "redirecting" ? (
              <LogIn className="h-7 w-7" />
            ) : (
              <UserPlus className="h-7 w-7" />
            )}
          </div>
          <CardTitle className="text-2xl font-semibold tracking-normal text-neutral-950">
            {title}
          </CardTitle>
          <CardDescription className="text-neutral-600">
            {description}
          </CardDescription>
        </CardHeader>

        <CardContent>
          {isBusy && (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
              <Loader2 className="h-4 w-4 animate-spin text-[#FF0000]" />
              Procesando invitación
            </div>
          )}
        </CardContent>

        <CardFooter className="flex flex-col gap-2">
          {state === "accepted" && (
            <Button
              type="button"
              className="w-full gap-2 bg-[#FF0000] text-white hover:bg-[#d90000]"
              onClick={() => router.replace(nextPath)}
            >
              Entrar a SiraGPT
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
          {state === "verification" && (
            <Button
              type="button"
              className="w-full bg-[#FF0000] text-white hover:bg-[#d90000]"
              onClick={() => router.replace("/chat")}
            >
              Ir a SiraGPT
            </Button>
          )}
          {state === "error" && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => router.replace("/chat")}
            >
              Volver a SiraGPT
            </Button>
          )}
        </CardFooter>
      </Card>
    </main>
  )
}

export default function OrganizationInvitationPage() {
  return (
    <React.Suspense fallback={null}>
      <OrganizationInvitationPageContent />
    </React.Suspense>
  )
}
