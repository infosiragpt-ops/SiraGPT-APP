/**
 * Persists the user's model + provider choice across sessions.
 * Internal logic only — no UI changes.
 */

const STORAGE_KEY = "siragpt:selected-model-v1"

export type PersistedModelSelection = {
  model: string
  provider: string
  updatedAt: number
}

export function loadPersistedModelSelection(): PersistedModelSelection | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedModelSelection
    if (!parsed?.model || !parsed?.provider) return null
    return parsed
  } catch {
    return null
  }
}

export function savePersistedModelSelection(model: string, provider: string): void {
  if (typeof window === "undefined" || !model || !provider) return
  try {
    const payload: PersistedModelSelection = {
      model,
      provider,
      updatedAt: Date.now(),
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // quota / private mode — ignore
  }
}

export function pickModelFromCatalog(
  models: Array<{ name: string; provider: string }>,
  persisted: PersistedModelSelection | null,
): { model: string; provider: string } | null {
  if (!models.length) return null

  if (persisted) {
    const match = models.find((m) => m.name === persisted.model)
    if (match) {
      return { model: match.name, provider: match.provider || persisted.provider }
    }
  }

  return { model: models[0].name, provider: models[0].provider }
}
