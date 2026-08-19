type ImageGenerationRecoveryOptions = {
  nowMs?: number
  userAborted?: boolean
}

function getErrorStatus(error: any): number | null {
  const status = Number(error?.status ?? error?.statusCode)
  return Number.isFinite(status) && status > 0 ? status : null
}

function getErrorText(error: any): string {
  return [
    error?.message,
    error?.name,
    error?.code,
    error?.cause?.code,
    error?.cause?.message,
    error?.errorData?.code,
    error?.errorData?.error,
    error?.errorData?.message,
  ]
    .filter(Boolean)
    .join(" ")
}

export function shouldRecoverImageGenerationViaPolling(
  error: any,
  startedAtMs: number,
  options: ImageGenerationRecoveryOptions = {},
): boolean {
  if (options.userAborted || error?.name === "AbortError") return false

  const status = getErrorStatus(error)
  const elapsedMs = Math.max(0, (options.nowMs ?? Date.now()) - startedAtMs)
  const text = getErrorText(error)
  const code = String(error?.code || error?.errorData?.code || "")

  // Functional backend failures should surface directly. They are not
  // transport cuts, and polling would hide the real actionable error.
  if (code && !/ECONN|ETIMEDOUT|ERR_NETWORK|ERR_EMPTY_RESPONSE/i.test(code)) {
    return false
  }

  const looksLikeTransportCut =
    /ECONNRESET|ECONNABORTED|ERR_NETWORK|ERR_EMPTY_RESPONSE|socket|network|failed to fetch|fetch failed|load failed|proxy|internal server error|request timed out|aborted/i.test(text)

  if (!status) {
    return !code || looksLikeTransportCut
  }

  // Next/Replit/mobile proxies can return 5xx/408 after the 30s edge limit
  // even though the backend continues and persists the image into the chat.
  if (status === 408 || (status >= 500 && status <= 599)) {
    return elapsedMs >= 25_000 || looksLikeTransportCut
  }

  return false
}
