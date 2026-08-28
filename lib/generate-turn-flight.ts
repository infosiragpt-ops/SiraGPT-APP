/**
 * Single-flight lock for /api/ai/generate.
 *
 * Extra React mounts (/agentes querystring clones, /conexiones, Strict Mode)
 * used to POST the same chat/turn body again. The owner generated; the rest
 * hit duplicate_turn_replay, Caddy aborted the short SSE, and the client
 * retried until Pensando spun forever.
 *
 * Two registries:
 *  - generateStreamFlights: one in-flight POST per chat+idempotencyKey
 *  - addMessageFlights: one addMessage orchestration per chat+turn
 */

export function generateTurnFlightKey(
  chatId?: string | null,
  idempotencyKey?: string | null,
): string | null {
  const chat = typeof chatId === "string" ? chatId.trim() : ""
  const turn = typeof idempotencyKey === "string" ? idempotencyKey.trim() : ""
  if (!chat || !turn) return null
  return `${chat}::${turn}`
}

type FlightRegistry = {
  peek: (key: string | null | undefined) => Promise<unknown> | null
  run<T>(key: string | null | undefined, fn: () => Promise<T>): Promise<T>
  joinOrRun<T>(
    key: string | null | undefined,
    owner: () => Promise<T>,
    follower: () => Promise<T>,
  ): Promise<T>
  reset: () => void
  size: () => number
}

function createFlightRegistry(): FlightRegistry {
  const flights = new Map<string, Promise<unknown>>()

  return {
    peek(key) {
      if (!key) return null
      return flights.get(key) ?? null
    },
    run<T>(key: string | null | undefined, fn: () => Promise<T>): Promise<T> {
      if (!key) return fn()
      const existing = flights.get(key)
      if (existing) return existing as Promise<T>
      const promise = fn().finally(() => {
        if (flights.get(key) === promise) flights.delete(key)
      })
      flights.set(key, promise)
      return promise
    },
    async joinOrRun<T>(
      key: string | null | undefined,
      owner: () => Promise<T>,
      follower: () => Promise<T>,
    ): Promise<T> {
      if (!key) return owner()
      const existing = flights.get(key)
      if (existing) {
        await existing.catch(() => {})
        return follower()
      }
      const promise = owner().finally(() => {
        if (flights.get(key) === promise) flights.delete(key)
      })
      flights.set(key, promise)
      return promise
    },
    reset() {
      flights.clear()
    },
    size() {
      return flights.size
    },
  }
}

export const generateStreamFlights = createFlightRegistry()
export const addMessageFlights = createFlightRegistry()

export function resetGenerateTurnFlights(): void {
  generateStreamFlights.reset()
  addMessageFlights.reset()
}
