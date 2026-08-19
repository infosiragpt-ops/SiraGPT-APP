export interface ClientSentryConfigInput {
  dsn?: string
  environment?: string
  release?: string
  tracesSampleRate?: string
  replaySessionSampleRate?: string
  replayOnErrorSampleRate?: string
}

export interface ClientSentryConfig {
  dsn: string
  environment: string
  release?: string
  tracesSampleRate: number
  replaysSessionSampleRate: number
  replaysOnErrorSampleRate: number
  sendDefaultPii: false
}

export function clampSampleRate(value: string | undefined, fallback = 0): number {
  const parsed = Number.parseFloat(value || "")
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(1, Math.max(0, parsed))
}

export function resolveClientSentryConfig(input: ClientSentryConfigInput): ClientSentryConfig | null {
  const dsn = input.dsn?.trim()
  if (!dsn) return null

  return {
    dsn,
    environment: input.environment || process.env.NODE_ENV || "development",
    release: input.release || undefined,
    tracesSampleRate: clampSampleRate(input.tracesSampleRate, 0),
    replaysSessionSampleRate: clampSampleRate(input.replaySessionSampleRate, 0),
    replaysOnErrorSampleRate: clampSampleRate(input.replayOnErrorSampleRate, 0),
    sendDefaultPii: false,
  }
}
