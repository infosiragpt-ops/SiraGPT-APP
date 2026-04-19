import { cookies, headers } from "next/headers"
import { getRequestConfig } from "next-intl/server"
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, FALLBACK_LOCALE, isSupportedLocale } from "./locales"

export const LOCALE_COOKIE = "NEXT_LOCALE"

/**
 * Resolves the per-request locale for next-intl.
 *
 * Precedence:
 *   1. NEXT_LOCALE cookie (set by the middleware or the language picker).
 *   2. First supported code from Accept-Language.
 *   3. DEFAULT_LOCALE (es).
 *
 * Messages for missing keys fall back to the English bundle so the UI
 * never renders a raw key — shipping a locale with incomplete coverage
 * just shows English for the missing strings.
 */
export default getRequestConfig(async () => {
  const cookieStore = cookies()
  const headerStore = headers()

  let locale: string | undefined = cookieStore.get(LOCALE_COOKIE)?.value
  if (!isSupportedLocale(locale)) {
    const accept = headerStore.get("accept-language") || ""
    locale = pickFromAcceptLanguage(accept) || DEFAULT_LOCALE
  }
  if (!isSupportedLocale(locale)) locale = DEFAULT_LOCALE

  // Load the resolved locale, plus the English fallback. Shallow-merge
  // so any missing key in the resolved bundle renders the English copy.
  const [primary, fallback] = await Promise.all([
    loadMessages(locale!),
    locale !== FALLBACK_LOCALE ? loadMessages(FALLBACK_LOCALE) : Promise.resolve({}),
  ])
  const messages = mergeDeep(fallback as any, primary as any)

  return { locale: locale!, messages }
})

async function loadMessages(code: string): Promise<Record<string, any>> {
  try {
    return (await import(`../../messages/${code}.json`)).default
  } catch {
    return {}
  }
}

function pickFromAcceptLanguage(accept: string): string | undefined {
  if (!accept) return undefined
  // Very small parser — avoids pulling negotiator here (the middleware
  // already handles full negotiation). We just walk the q-ordered list
  // and grab the first 2-letter prefix we support.
  const tags = accept.split(",").map((s) => {
    const [t, ...rest] = s.trim().split(";")
    const q = rest.find((r) => r.trim().startsWith("q="))
    return { tag: t.trim(), q: q ? parseFloat(q.split("=")[1]) : 1 }
  }).sort((a, b) => b.q - a.q)
  for (const { tag } of tags) {
    const short = tag.toLowerCase().slice(0, 2)
    if (SUPPORTED_LOCALES.includes(short)) return short
  }
  return undefined
}

function mergeDeep<T extends Record<string, any>>(target: T, source: Partial<T> | undefined): T {
  if (!source) return target
  const isObj = (x: any) => x && typeof x === "object" && !Array.isArray(x)
  if (!isObj(target) || !isObj(source)) return (source as T) ?? target
  const out: any = { ...target }
  for (const k of Object.keys(source)) {
    const sv = (source as any)[k]
    const tv = (target as any)[k]
    if (isObj(sv) && isObj(tv)) out[k] = mergeDeep(tv, sv)
    else if (sv !== undefined) out[k] = sv
  }
  return out as T
}
