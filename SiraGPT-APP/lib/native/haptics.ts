/**
 * Native haptics wrapper.
 *
 * Resolution order:
 *   1. `@capacitor/haptics` (iOS/Android Taptic Engine + Vibrator)
 *   2. `navigator.vibrate` (Android Chrome web fallback)
 *   3. No-op on platforms without vibration support
 */

export type ImpactStyle = "light" | "medium" | "heavy"
export type NotificationStyle = "success" | "warning" | "error"

function isCapacitorNative(): boolean {
  try {
    const g = globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
    return !!g.Capacitor?.isNativePlatform?.()
  } catch {
    return false
  }
}

async function loadHaptics(): Promise<any | null> {
  if (!isCapacitorNative()) return null
  try {
    const spec = "@capacitor/haptics"
    const mod: any = await import(/* webpackIgnore: true */ spec).catch(() => null)
    return mod ?? null
  } catch {
    return null
  }
}

function webVibrate(pattern: number | number[]): boolean {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      return navigator.vibrate(pattern)
    }
  } catch {
    /* ignore */
  }
  return false
}

const IMPACT_PATTERN: Record<ImpactStyle, number> = {
  light: 10,
  medium: 20,
  heavy: 40,
}

const NOTIF_PATTERN: Record<NotificationStyle, number[]> = {
  success: [10, 60, 10],
  warning: [20, 40, 20],
  error: [40, 50, 40, 50, 40],
}

export async function impact(style: ImpactStyle = "medium"): Promise<void> {
  const mod = await loadHaptics()
  if (mod?.Haptics?.impact && mod?.ImpactStyle) {
    try {
      const StyleEnum = mod.ImpactStyle
      const styleValue =
        style === "light" ? StyleEnum.Light : style === "heavy" ? StyleEnum.Heavy : StyleEnum.Medium
      await mod.Haptics.impact({ style: styleValue })
      return
    } catch {
      /* fall through */
    }
  }
  webVibrate(IMPACT_PATTERN[style])
}

export async function notification(style: NotificationStyle = "success"): Promise<void> {
  const mod = await loadHaptics()
  if (mod?.Haptics?.notification && mod?.NotificationType) {
    try {
      const TypeEnum = mod.NotificationType
      const value =
        style === "warning" ? TypeEnum.Warning : style === "error" ? TypeEnum.Error : TypeEnum.Success
      await mod.Haptics.notification({ type: value })
      return
    } catch {
      /* fall through */
    }
  }
  webVibrate(NOTIF_PATTERN[style])
}

export async function vibrate(durationMs = 30): Promise<void> {
  const mod = await loadHaptics()
  if (mod?.Haptics?.vibrate) {
    try {
      await mod.Haptics.vibrate({ duration: durationMs })
      return
    } catch {
      /* fall through */
    }
  }
  webVibrate(durationMs)
}

export async function selectionStart(): Promise<void> {
  const mod = await loadHaptics()
  if (mod?.Haptics?.selectionStart) {
    try {
      await mod.Haptics.selectionStart()
    } catch {
      /* noop */
    }
  }
}

export async function selectionChanged(): Promise<void> {
  const mod = await loadHaptics()
  if (mod?.Haptics?.selectionChanged) {
    try {
      await mod.Haptics.selectionChanged()
      return
    } catch {
      /* fall through */
    }
  }
  webVibrate(5)
}

export async function selectionEnd(): Promise<void> {
  const mod = await loadHaptics()
  if (mod?.Haptics?.selectionEnd) {
    try {
      await mod.Haptics.selectionEnd()
    } catch {
      /* noop */
    }
  }
}
