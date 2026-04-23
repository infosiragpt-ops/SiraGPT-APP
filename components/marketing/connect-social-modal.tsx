"use client"

/**
 * ConnectSocialModal — opens when the user toggles a social network
 * that isn't yet connected. Explains what the agent will do with
 * that connection and launches the OAuth flow in a popup window.
 *
 * When the backend doesn't have OAuth credentials configured for
 * that platform (env vars missing), the "Conectar" button switches
 * to a disabled "Credenciales no configuradas" state with a helpful
 * message — so the user understands the wiring is incomplete
 * without getting a cryptic 500.
 */

import * as React from "react"
import { toast } from "sonner"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  Facebook, Instagram, Youtube, Linkedin, Music2, ShieldCheck, Sparkles,
  ExternalLink, Loader2,
} from "lucide-react"

import { marketingService, type Platform, type ConnectionsStatus } from "@/lib/marketing-service"

const PLATFORM_COPY: Record<Platform, { label: string; color: string; Icon: any; tagline: string }> = {
  facebook:  { label: "Facebook",  color: "#1877F2", Icon: Facebook,  tagline: "Publicar en tu página de Facebook" },
  instagram: { label: "Instagram", color: "#E4405F", Icon: Instagram, tagline: "Feed + Reels de tu cuenta Business" },
  youtube:   { label: "YouTube",   color: "#FF0000", Icon: Youtube,   tagline: "Shorts y videos en tu canal" },
  tiktok:    { label: "TikTok",    color: "#111111", Icon: Music2,    tagline: "Publicar videos en tu perfil" },
  linkedin:  { label: "LinkedIn",  color: "#0A66C2", Icon: Linkedin,  tagline: "Posts profesionales en tu página" },
}

interface Props {
  platform: Platform | null
  status: ConnectionsStatus | null
  onClose: () => void
  onConnected?: (platform: Platform) => void
}

export function ConnectSocialModal({ platform, status, onClose, onConnected }: Props) {
  const [loading, setLoading] = React.useState(false)
  const meta = platform ? PLATFORM_COPY[platform] : null
  const s = platform && status ? status[platform] : null

  // Poll /connections every ~2s while the popup is open so we detect
  // the OAuth round-trip completing without a manual refresh.
  const pollRef = React.useRef<any>(null)
  const popupRef = React.useRef<Window | null>(null)

  React.useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (popupRef.current) { try { popupRef.current.close() } catch {} }
  }, [])

  async function connect() {
    if (!platform) return
    setLoading(true)
    try {
      const { url } = await marketingService.startConnect(platform)
      // Open OAuth in a popup so the current tab isn't reloaded.
      const w = 560, h = 720
      const left = typeof window !== "undefined" ? (window.screenX + (window.outerWidth - w) / 2) : 0
      const top  = typeof window !== "undefined" ? (window.screenY + (window.outerHeight - h) / 2) : 0
      popupRef.current = window.open(
        url,
        "siragpt-oauth",
        `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`,
      )
      if (!popupRef.current) {
        toast.error("El popup fue bloqueado. Habilítalo en tu navegador e inténtalo de nuevo.")
        setLoading(false)
        return
      }
      // Poll connection status.
      pollRef.current = setInterval(async () => {
        try {
          const data = await marketingService.listConnections()
          if (data.status[platform]?.connected) {
            clearInterval(pollRef.current)
            try { popupRef.current?.close() } catch {}
            onConnected?.(platform)
            setLoading(false)
            onClose()
          }
        } catch {}
      }, 2000)
    } catch (err: any) {
      if (err?.status === 501 || err?.body?.error === "not_configured") {
        toast.error(err?.body?.message || "OAuth no configurado para esta red")
      } else {
        toast.error(err?.message || "No se pudo iniciar la conexión")
      }
      setLoading(false)
    }
  }

  if (!platform || !meta) return null
  const Icon = meta.Icon

  return (
    <Dialog open={!!platform} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div
              className="flex h-11 w-11 items-center justify-center rounded-xl border"
              style={{ borderColor: meta.color + "40", backgroundColor: meta.color + "15", color: meta.color }}
            >
              <Icon className="h-5 w-5" strokeWidth={1.8} />
            </div>
            <div>
              <DialogTitle className="text-[15px] leading-tight">Conectar {meta.label}</DialogTitle>
              <DialogDescription className="text-[12.5px]">{meta.tagline}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <FeatureRow
            Icon={Sparkles}
            title="Entender tu negocio"
            body="Leemos el nombre de tu cuenta, bio, industria y tus últimos posts para generar contenido consistente con tu voz."
          />
          <FeatureRow
            Icon={ShieldCheck}
            title="Publicación segura"
            body="Solo se publican los posts que programas desde siraGPT. Puedes desconectar la cuenta en cualquier momento."
          />
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={onClose} className="sm:w-auto">Cancelar</Button>
          <Button
            onClick={connect}
            disabled={loading || s?.configured === false}
            className="sm:flex-1"
            style={{ backgroundColor: s?.configured === false ? undefined : meta.color }}
          >
            {loading
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Abriendo {meta.label}…</>
              : s?.configured === false
                ? "Credenciales no configuradas"
                : <><ExternalLink className="mr-2 h-4 w-4" />Conectar con {meta.label}</>}
          </Button>
        </DialogFooter>

        {s?.configured === false && (
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            El administrador aún no configuró las credenciales OAuth de {meta.label} en el backend
            (<code className="rounded bg-muted px-1">{platform.toUpperCase()}_CLIENT_ID</code> / <code className="rounded bg-muted px-1">{platform.toUpperCase()}_CLIENT_SECRET</code>).
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function FeatureRow({ Icon, title, body }: { Icon: any; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/50 bg-muted/20 p-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
      <div className="space-y-0.5">
        <div className="text-[13px] font-medium leading-tight">{title}</div>
        <div className="text-[12px] leading-snug text-muted-foreground">{body}</div>
      </div>
    </div>
  )
}
