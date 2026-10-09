/** Serialize model saves per chat; only the latest user choice may settle UI. */
export function createModelSelectionWriter<T>() {
  const scopes = new Map<string, { version: number; confirmed: T; tail: Promise<void> }>()
  return async function save(input: {
    scope: string
    previous: T
    next: T
    persist: (value: T) => Promise<unknown>
    confirmed: (value: T) => void
    failed: (rollback: T) => void
  }): Promise<boolean> {
    let state = scopes.get(input.scope)
    if (!state) {
      state = { version: 0, confirmed: input.previous, tail: Promise.resolve() }
      scopes.set(input.scope, state)
    }
    const version = ++state.version
    let ok = false
    const task = state.tail.then(async () => {
      try {
        await input.persist(input.next)
        state.confirmed = input.next
        ok = true
        if (state.version === version) input.confirmed(input.next)
      } catch {
        if (state.version === version) input.failed(state.confirmed)
      } finally {
        // A reopened chat can have changed elsewhere after our last save.
        // Its next idle transaction must roll back to that fresh selection.
        if (state.version === version) scopes.delete(input.scope)
      }
    })
    state.tail = task
    await task
    return ok
  }
}
