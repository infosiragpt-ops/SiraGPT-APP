/**
 * Native clipboard wrapper.
 *
 * Resolution order:
 *   1. `@capacitor/clipboard` (Capacitor native)
 *   2. `navigator.clipboard` (browser async API)
 *   3. `document.execCommand('copy')` legacy fallback (best-effort)
 */

export type ClipboardWriteOptions = {
  string?: string
  url?: string
  label?: string
}

export type ClipboardReadResult = {
  ok: boolean
  value: string
  via: "capacitor" | "web" | "noop"
  error?: string
}

export type ClipboardWriteResult = {
  ok: boolean
  via: "capacitor" | "web" | "legacy" | "noop"
  error?: string
}

function isCapacitorNative(): boolean {
  try {
    const g = globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
    return !!g.Capacitor?.isNativePlatform?.()
  } catch {
    return false
  }
}

async function loadCapacitor(): Promise<any | null> {
  if (!isCapacitorNative()) return null
  try {
    const spec = "@capacitor/clipboard"
    const mod: any = await import(/* webpackIgnore: true */ spec).catch(() => null)
    return mod?.Clipboard ?? null
  } catch {
    return null
  }
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "")
}

function isClipboardPermissionDenied(err: unknown): boolean {
  const name = err && typeof err === "object" && "name" in err
    ? String((err as { name?: unknown }).name || "")
    : ""
  const message = getErrorMessage(err)
  return name === "NotAllowedError"
    || /write permission denied|permission denied|not allowed/i.test(message)
}

export async function writeText(value: string): Promise<ClipboardWriteResult> {
  return write({ string: value })
}

export async function write(opts: ClipboardWriteOptions): Promise<ClipboardWriteResult> {
  const value = opts.string ?? opts.url ?? ""
  const cap = await loadCapacitor()
  if (cap?.write) {
    try {
      await cap.write({ string: opts.string, url: opts.url, label: opts.label })
      return { ok: true, via: "capacitor" }
    } catch (err) {
      // fall through to web
      // eslint-disable-next-line no-console
      console.warn("[lib/native/clipboard] capacitor write failed, falling back", err)
    }
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return { ok: true, via: "web" }
    } catch (err) {
      // fall through to legacy
      if (!isClipboardPermissionDenied(err)) {
        // eslint-disable-next-line no-console
        console.warn("[lib/native/clipboard] navigator.clipboard failed, falling back", getErrorMessage(err))
      }
    }
  }

  if (typeof document !== "undefined" && typeof document.execCommand === "function") {
    try {
      const el = document.createElement("textarea")
      el.value = value
      el.setAttribute("readonly", "")
      el.style.position = "fixed"
      el.style.opacity = "0"
      document.body.appendChild(el)
      el.select()
      const ok = document.execCommand("copy")
      document.body.removeChild(el)
      if (ok) return { ok: true, via: "legacy" }
    } catch (err) {
      return { ok: false, via: "legacy", error: err instanceof Error ? err.message : String(err) }
    }
  }

  return { ok: false, via: "noop", error: "no clipboard mechanism available" }
}

export async function readText(): Promise<ClipboardReadResult> {
  const cap = await loadCapacitor()
  if (cap?.read) {
    try {
      const result = await cap.read()
      return { ok: true, value: String(result?.value ?? ""), via: "capacitor" }
    } catch (err) {
      // fall through
      // eslint-disable-next-line no-console
      console.warn("[lib/native/clipboard] capacitor read failed, falling back", err)
    }
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    try {
      const value = await navigator.clipboard.readText()
      return { ok: true, value, via: "web" }
    } catch (err) {
      return { ok: false, value: "", via: "web", error: err instanceof Error ? err.message : String(err) }
    }
  }

  return { ok: false, value: "", via: "noop", error: "clipboard read not supported" }
}
