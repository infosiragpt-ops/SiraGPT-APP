import { cookies, headers } from "next/headers"
import { getRequestConfig } from "next-intl/server"
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, FALLBACK_LOCALE, isSupportedLocale } from "./locales"
import { pickLocaleFromAcceptLanguage } from "./locale-resolution"

export const LOCALE_COOKIE = "NEXT_LOCALE"

type Messages = Record<string, any>

const MESSAGE_LOADERS: Record<string, () => Promise<Messages>> = {
  am: () => import("../../messages/am.json").then((module) => module.default as Messages),
  ar: () => import("../../messages/ar.json").then((module) => module.default as Messages),
  az: () => import("../../messages/az.json").then((module) => module.default as Messages),
  bg: () => import("../../messages/bg.json").then((module) => module.default as Messages),
  bn: () => import("../../messages/bn.json").then((module) => module.default as Messages),
  cs: () => import("../../messages/cs.json").then((module) => module.default as Messages),
  da: () => import("../../messages/da.json").then((module) => module.default as Messages),
  de: () => import("../../messages/de.json").then((module) => module.default as Messages),
  el: () => import("../../messages/el.json").then((module) => module.default as Messages),
  en: () => import("../../messages/en.json").then((module) => module.default as Messages),
  es: () => import("../../messages/es.json").then((module) => module.default as Messages),
  et: () => import("../../messages/et.json").then((module) => module.default as Messages),
  fa: () => import("../../messages/fa.json").then((module) => module.default as Messages),
  fi: () => import("../../messages/fi.json").then((module) => module.default as Messages),
  fr: () => import("../../messages/fr.json").then((module) => module.default as Messages),
  gu: () => import("../../messages/gu.json").then((module) => module.default as Messages),
  he: () => import("../../messages/he.json").then((module) => module.default as Messages),
  hi: () => import("../../messages/hi.json").then((module) => module.default as Messages),
  hr: () => import("../../messages/hr.json").then((module) => module.default as Messages),
  hu: () => import("../../messages/hu.json").then((module) => module.default as Messages),
  id: () => import("../../messages/id.json").then((module) => module.default as Messages),
  it: () => import("../../messages/it.json").then((module) => module.default as Messages),
  ja: () => import("../../messages/ja.json").then((module) => module.default as Messages),
  ka: () => import("../../messages/ka.json").then((module) => module.default as Messages),
  kk: () => import("../../messages/kk.json").then((module) => module.default as Messages),
  km: () => import("../../messages/km.json").then((module) => module.default as Messages),
  kn: () => import("../../messages/kn.json").then((module) => module.default as Messages),
  ko: () => import("../../messages/ko.json").then((module) => module.default as Messages),
  lo: () => import("../../messages/lo.json").then((module) => module.default as Messages),
  lt: () => import("../../messages/lt.json").then((module) => module.default as Messages),
  lv: () => import("../../messages/lv.json").then((module) => module.default as Messages),
  ml: () => import("../../messages/ml.json").then((module) => module.default as Messages),
  mn: () => import("../../messages/mn.json").then((module) => module.default as Messages),
  mr: () => import("../../messages/mr.json").then((module) => module.default as Messages),
  ms: () => import("../../messages/ms.json").then((module) => module.default as Messages),
  my: () => import("../../messages/my.json").then((module) => module.default as Messages),
  ne: () => import("../../messages/ne.json").then((module) => module.default as Messages),
  nl: () => import("../../messages/nl.json").then((module) => module.default as Messages),
  no: () => import("../../messages/no.json").then((module) => module.default as Messages),
  pl: () => import("../../messages/pl.json").then((module) => module.default as Messages),
  ps: () => import("../../messages/ps.json").then((module) => module.default as Messages),
  pt: () => import("../../messages/pt.json").then((module) => module.default as Messages),
  ro: () => import("../../messages/ro.json").then((module) => module.default as Messages),
  ru: () => import("../../messages/ru.json").then((module) => module.default as Messages),
  si: () => import("../../messages/si.json").then((module) => module.default as Messages),
  sk: () => import("../../messages/sk.json").then((module) => module.default as Messages),
  sl: () => import("../../messages/sl.json").then((module) => module.default as Messages),
  sv: () => import("../../messages/sv.json").then((module) => module.default as Messages),
  sw: () => import("../../messages/sw.json").then((module) => module.default as Messages),
  ta: () => import("../../messages/ta.json").then((module) => module.default as Messages),
  te: () => import("../../messages/te.json").then((module) => module.default as Messages),
  th: () => import("../../messages/th.json").then((module) => module.default as Messages),
  tl: () => import("../../messages/tl.json").then((module) => module.default as Messages),
  tr: () => import("../../messages/tr.json").then((module) => module.default as Messages),
  uk: () => import("../../messages/uk.json").then((module) => module.default as Messages),
  ur: () => import("../../messages/ur.json").then((module) => module.default as Messages),
  uz: () => import("../../messages/uz.json").then((module) => module.default as Messages),
  vi: () => import("../../messages/vi.json").then((module) => module.default as Messages),
  zh: () => import("../../messages/zh.json").then((module) => module.default as Messages),
}

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
  const cookieStore = await cookies()
  const headerStore = await headers()

  let locale: string | undefined = cookieStore.get(LOCALE_COOKIE)?.value
  if (!isSupportedLocale(locale)) {
    const accept = headerStore.get("accept-language") || ""
    locale = pickLocaleFromAcceptLanguage(accept, SUPPORTED_LOCALES) || DEFAULT_LOCALE
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

async function loadMessages(code: string): Promise<Messages> {
  const loader = MESSAGE_LOADERS[code]
  if (!loader) return {}

  try {
    return await loader()
  } catch {
    return {}
  }
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
