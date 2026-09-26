export type OfficeSaveStatus = "saved" | "unsaved" | "saving" | "error"

/** Serializes saves so an older response can never overwrite a newer edit. */
export function createOfficeDraftQueue<T>(options: {
  initial: T
  persist: (value: T, previous: T) => Promise<void>
  onStatus: (status: OfficeSaveStatus) => void
  onSaved?: (value: T) => void
}) {
  let saved = options.initial
  let current = options.initial
  let revision = 0
  let running: Promise<boolean> | null = null
  const equal = (a: T, b: T) => JSON.stringify(a) === JSON.stringify(b)
  return {
    sync(value: T) {
      if (!running && equal(current, saved)) saved = current = value
    },
    change(value: T) {
      current = value
      revision += 1
      options.onStatus(equal(current, saved) ? "saved" : "unsaved")
    },
    get dirty() { return !equal(current, saved) },
    flush(): Promise<boolean> {
      if (running) return running
      if (equal(current, saved)) return Promise.resolve(true)
      running = (async () => {
        while (!equal(current, saved)) {
          const value = current
          const sentRevision = revision
          options.onStatus("saving")
          try {
            await options.persist(value, saved)
          } catch {
            options.onStatus("error")
            return false
          }
          saved = value
          options.onSaved?.(value)
          if (sentRevision === revision) break
        }
        options.onStatus("saved")
        return true
      })().finally(() => { running = null })
      return running
    },
  }
}
