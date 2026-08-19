/**
 * Native share wrapper.
 *
 * Resolution order:
 *   1. `@capacitor/share` (when installed and running inside a Capacitor app)
 *   2. `navigator.share` (Web Share API)
 *   3. Clipboard copy of URL/text as a last-resort fallback
 *
 * The API is identical across platforms so callers don't need to branch.
 */

export type ShareOptions = {
  title?: string
  text?: string
  url?: string
  dialogTitle?: string
}

export type ShareResult = {
  ok: boolean
  /** which path actually handled the share */
  via: "capacitor" | "web-share" | "clipboard" | "noop"
  /** when copy fallback ran, the value that was copied */
  copied?: string
  error?: string
}

function isCapacitorNative(): boolean {
  try {
    const g = globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }
    if (!g.Capacitor) return false
    if (typeof g.Capacitor.isNativePlatform === "function") return Boolean(g.Capacitor.isNativePlatform())
    if (typeof g.Capacitor.getPlatform === "function") return g.Capacitor.getPlatform() !== "web"
    return false
  } catch {
    return false
  }
}

async function tryCapacitorShare(opts: ShareOptions): Promise<ShareResult | null> {
  if (!isCapacitorNative()) return null
  try {
    // Dynamic import so the bundler doesn't choke when the optional dep is absent.
    // Computed specifier prevents TS from trying to resolve types statically.
    const spec = "@capacitor/share"
    const mod: any = await import(/* webpackIgnore: true */ spec).catch(() => null)
    if (!mod?.Share?.share) return null
    await mod.Share.share({
      title: opts.title,
      text: opts.text,
      url: opts.url,
      dialogTitle: opts.dialogTitle ?? opts.title,
    })
    return { ok: true, via: "capacitor" }
  } catch (err) {
    return { ok: false, via: "capacitor", error: err instanceof Error ? err.message : String(err) }
  }
}

async function tryWebShare(opts: ShareOptions): Promise<ShareResult | null> {
  if (typeof navigator === "undefined" || typeof (navigator as Navigator).share !== "function") return null
  try {
    await (navigator as Navigator).share({ title: opts.title, text: opts.text, url: opts.url })
    return { ok: true, via: "web-share" }
  } catch (err) {
    // User-cancel is not a hard failure — surface as ok:false but keep via stable
    return { ok: false, via: "web-share", error: err instanceof Error ? err.message : String(err) }
  }
}

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    /* fall through */
  }
  return false
}

export async function share(opts: ShareOptions): Promise<ShareResult> {
  const cap = await tryCapacitorShare(opts)
  if (cap && cap.ok) return cap

  const web = await tryWebShare(opts)
  if (web && web.ok) return web

  const payload = [opts.title, opts.text, opts.url].filter(Boolean).join("\n")
  if (payload) {
    const copied = await copyToClipboard(payload)
    if (copied) return { ok: true, via: "clipboard", copied: payload }
  }

  return { ok: false, via: "noop", error: "no share mechanism available" }
}

export async function canShare(): Promise<boolean> {
  if (isCapacitorNative()) return true
  if (typeof navigator !== "undefined" && typeof (navigator as Navigator).share === "function") return true
  if (typeof navigator !== "undefined" && !!navigator.clipboard?.writeText) return true
  return false
}
