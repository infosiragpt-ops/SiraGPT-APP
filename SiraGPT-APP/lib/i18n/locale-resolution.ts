export type HeaderSource = Headers | Record<string, string | undefined>

function readHeader(source: HeaderSource, name: string): string | undefined {
  if (source instanceof Headers) {
    return source.get(name) ?? undefined
  }

  const exact = source[name]
  if (exact) return exact

  const lower = name.toLowerCase()
  const match = Object.entries(source).find(([key]) => key.toLowerCase() === lower)
  return match?.[1]
}

export function pickLocaleFromAcceptLanguage(
  accept: string,
  supportedLocales: readonly string[]
): string | undefined {
  if (!accept) return undefined

  const tags = accept
    .split(",")
    .map((entry) => {
      const [tag, ...params] = entry.trim().split(";")
      const qParam = params.find((param) => param.trim().startsWith("q="))
      return {
        tag: tag.trim().toLowerCase(),
        q: qParam ? Number.parseFloat(qParam.split("=")[1]) : 1,
      }
    })
    .filter(({ tag, q }) => tag && Number.isFinite(q))
    .sort((a, b) => b.q - a.q)

  for (const { tag } of tags) {
    const short = tag.slice(0, 2)
    if (supportedLocales.includes(short)) return short
  }

  return undefined
}

export function countryCodeFromHeaders(headers: HeaderSource): string | undefined {
  const candidates = [
    'x-vercel-ip-country',
    'cf-ipcountry',
    'cloudfront-viewer-country',
    'x-country-code',
    'x-country',
  ]

  for (const header of candidates) {
    const value = readHeader(headers, header)?.trim()
    if (value && value.length >= 2) return value.toUpperCase()
  }

  return undefined
}
