/**
 * locales.ts — single source of truth for every locale siraGPT supports.
 *
 * Add a new language here and it becomes pickable from the Settings →
 * Interface language dropdown, routable via the middleware, and
 * available as a key in messages/. Native names come from CLDR; the
 * `dir` flag drives the <html dir="..."> attribute for RTL scripts.
 */

export type LocaleInfo = {
  code: string
  name: string       // native name (shown in the picker)
  english: string    // English exonym (for internal logs / fallback labels)
  dir: 'ltr' | 'rtl'
}

export const LOCALES: readonly LocaleInfo[] = [
  { code: 'es', name: 'Español',        english: 'Spanish',      dir: 'ltr' },
  { code: 'en', name: 'English',        english: 'English',      dir: 'ltr' },
  { code: 'fr', name: 'Français',       english: 'French',       dir: 'ltr' },
  { code: 'pt', name: 'Português',      english: 'Portuguese',   dir: 'ltr' },
  { code: 'de', name: 'Deutsch',        english: 'German',       dir: 'ltr' },
  { code: 'it', name: 'Italiano',       english: 'Italian',      dir: 'ltr' },
  { code: 'ja', name: '日本語',           english: 'Japanese',     dir: 'ltr' },
  { code: 'zh', name: '中文',             english: 'Chinese',      dir: 'ltr' },
  { code: 'ko', name: '한국어',          english: 'Korean',       dir: 'ltr' },
  { code: 'ar', name: 'العربية',         english: 'Arabic',       dir: 'rtl' },
  { code: 'hi', name: 'हिन्दी',          english: 'Hindi',        dir: 'ltr' },
  { code: 'ru', name: 'Русский',         english: 'Russian',      dir: 'ltr' },
  { code: 'tr', name: 'Türkçe',         english: 'Turkish',      dir: 'ltr' },
  { code: 'pl', name: 'Polski',         english: 'Polish',       dir: 'ltr' },
  { code: 'nl', name: 'Nederlands',     english: 'Dutch',        dir: 'ltr' },
  { code: 'sv', name: 'Svenska',        english: 'Swedish',      dir: 'ltr' },
  { code: 'da', name: 'Dansk',          english: 'Danish',       dir: 'ltr' },
  { code: 'no', name: 'Norsk',          english: 'Norwegian',    dir: 'ltr' },
  { code: 'fi', name: 'Suomi',          english: 'Finnish',      dir: 'ltr' },
  { code: 'el', name: 'Ελληνικά',       english: 'Greek',        dir: 'ltr' },
  { code: 'cs', name: 'Čeština',        english: 'Czech',        dir: 'ltr' },
  { code: 'ro', name: 'Română',         english: 'Romanian',     dir: 'ltr' },
  { code: 'hu', name: 'Magyar',         english: 'Hungarian',    dir: 'ltr' },
  { code: 'uk', name: 'Українська',     english: 'Ukrainian',    dir: 'ltr' },
  { code: 'bg', name: 'Български',      english: 'Bulgarian',    dir: 'ltr' },
  { code: 'hr', name: 'Hrvatski',       english: 'Croatian',     dir: 'ltr' },
  { code: 'sk', name: 'Slovenčina',     english: 'Slovak',       dir: 'ltr' },
  { code: 'sl', name: 'Slovenščina',    english: 'Slovenian',    dir: 'ltr' },
  { code: 'et', name: 'Eesti',          english: 'Estonian',     dir: 'ltr' },
  { code: 'lv', name: 'Latviešu',       english: 'Latvian',      dir: 'ltr' },
  { code: 'lt', name: 'Lietuvių',       english: 'Lithuanian',   dir: 'ltr' },
  { code: 'th', name: 'ไทย',            english: 'Thai',         dir: 'ltr' },
  { code: 'vi', name: 'Tiếng Việt',     english: 'Vietnamese',   dir: 'ltr' },
  { code: 'id', name: 'Bahasa Indonesia',english: 'Indonesian',  dir: 'ltr' },
  { code: 'ms', name: 'Bahasa Melayu',  english: 'Malay',        dir: 'ltr' },
  { code: 'tl', name: 'Filipino',       english: 'Filipino',     dir: 'ltr' },
  { code: 'sw', name: 'Kiswahili',      english: 'Swahili',      dir: 'ltr' },
  { code: 'am', name: 'አማርኛ',           english: 'Amharic',      dir: 'ltr' },
  { code: 'he', name: 'עברית',          english: 'Hebrew',       dir: 'rtl' },
  { code: 'fa', name: 'فارسی',          english: 'Persian',      dir: 'rtl' },
  { code: 'ur', name: 'اردو',           english: 'Urdu',         dir: 'rtl' },
  { code: 'bn', name: 'বাংলা',          english: 'Bengali',      dir: 'ltr' },
  { code: 'ta', name: 'தமிழ்',           english: 'Tamil',        dir: 'ltr' },
  { code: 'te', name: 'తెలుగు',         english: 'Telugu',       dir: 'ltr' },
  { code: 'mr', name: 'मराठी',           english: 'Marathi',      dir: 'ltr' },
  { code: 'gu', name: 'ગુજરાતી',         english: 'Gujarati',     dir: 'ltr' },
  { code: 'kn', name: 'ಕನ್ನಡ',          english: 'Kannada',      dir: 'ltr' },
  { code: 'ml', name: 'മലയാളം',         english: 'Malayalam',    dir: 'ltr' },
  { code: 'si', name: 'සිංහල',          english: 'Sinhala',      dir: 'ltr' },
  { code: 'my', name: 'မြန်မာ',          english: 'Burmese',      dir: 'ltr' },
  { code: 'km', name: 'ខ្មែរ',          english: 'Khmer',        dir: 'ltr' },
  { code: 'lo', name: 'ລາວ',            english: 'Lao',          dir: 'ltr' },
  { code: 'ka', name: 'ქართული',        english: 'Georgian',     dir: 'ltr' },
  { code: 'az', name: 'Azərbaycan',     english: 'Azerbaijani',  dir: 'ltr' },
  { code: 'uz', name: 'Oʻzbekcha',      english: 'Uzbek',        dir: 'ltr' },
  { code: 'kk', name: 'Қазақша',        english: 'Kazakh',       dir: 'ltr' },
  { code: 'mn', name: 'Монгол',         english: 'Mongolian',    dir: 'ltr' },
  { code: 'ne', name: 'नेपाली',          english: 'Nepali',       dir: 'ltr' },
  { code: 'ps', name: 'پښتو',           english: 'Pashto',       dir: 'rtl' },
] as const

export const SUPPORTED_LOCALES: readonly string[] = LOCALES.map((l) => l.code)
export const DEFAULT_LOCALE = 'es'
export const FALLBACK_LOCALE = 'en'

export const RTL_LOCALES = new Set(LOCALES.filter((l) => l.dir === 'rtl').map((l) => l.code))
export const isRTL = (code: string) => RTL_LOCALES.has(code)

export function localeInfo(code: string): LocaleInfo {
  return LOCALES.find((l) => l.code === code) ?? LOCALES[0]
}

export function isSupportedLocale(code: string | null | undefined): boolean {
  return !!code && SUPPORTED_LOCALES.includes(code)
}

/**
 * ISO 3166-1 alpha-2 country code → primary language locale.
 *
 * Covers ~200 UN-recognised countries. When a country has multiple
 * official languages we pick the one most likely to be understood in
 * the online/tech context: India → en (English is the default
 * lingua franca on the web), Singapore → en, etc. Users can override
 * at any time from Settings → Interface language.
 */
export const COUNTRY_TO_LOCALE: Record<string, string> = {
  // Americas
  US: 'en', CA: 'en', MX: 'es', GT: 'es', HN: 'es', SV: 'es', NI: 'es', CR: 'es', PA: 'es',
  CU: 'es', DO: 'es', PR: 'es', JM: 'en', HT: 'fr', TT: 'en', BB: 'en', BS: 'en', BZ: 'en',
  AR: 'es', BR: 'pt', CL: 'es', CO: 'es', EC: 'es', PE: 'es', VE: 'es', UY: 'es', PY: 'es',
  BO: 'es', GY: 'en', SR: 'nl', GF: 'fr',

  // Europe (western/southern)
  ES: 'es', PT: 'pt', FR: 'fr', DE: 'de', IT: 'it', GB: 'en', IE: 'en', NL: 'nl', BE: 'nl',
  LU: 'fr', MC: 'fr', AD: 'es', SM: 'it', VA: 'it', MT: 'en', CH: 'de', AT: 'de', LI: 'de',
  GR: 'el', CY: 'el',

  // Europe (northern)
  SE: 'sv', DK: 'da', NO: 'no', FI: 'fi', IS: 'is' === 'is' ? 'en' : 'en', FO: 'da',

  // Europe (eastern)
  PL: 'pl', CZ: 'cs', SK: 'sk', HU: 'hu', RO: 'ro', BG: 'bg', UA: 'uk', BY: 'ru', MD: 'ro',
  HR: 'hr', SI: 'sl', BA: 'hr', RS: 'sr' === 'sr' ? 'en' : 'en', ME: 'en', MK: 'en', AL: 'en',
  XK: 'en', EE: 'et', LV: 'lv', LT: 'lt', RU: 'ru',

  // MENA
  SA: 'ar', AE: 'ar', KW: 'ar', QA: 'ar', BH: 'ar', OM: 'ar', YE: 'ar', JO: 'ar', LB: 'ar',
  SY: 'ar', IQ: 'ar', EG: 'ar', LY: 'ar', TN: 'ar', DZ: 'ar', MA: 'ar', SD: 'ar', MR: 'ar',
  PS: 'ar', IL: 'he', IR: 'fa', AF: 'ps', TR: 'tr',

  // Sub-Saharan Africa
  NG: 'en', KE: 'sw', TZ: 'sw', UG: 'en', RW: 'en', BI: 'fr', CD: 'fr', CG: 'fr', CM: 'fr',
  CI: 'fr', SN: 'fr', ML: 'fr', BF: 'fr', NE: 'fr', TD: 'fr', GA: 'fr', MG: 'fr', ZA: 'en',
  ZW: 'en', ZM: 'en', MW: 'en', MZ: 'pt', AO: 'pt', ET: 'am', ER: 'am', SO: 'ar', DJ: 'fr',
  GH: 'en', LR: 'en', SL: 'en', GM: 'en', GN: 'fr', GQ: 'es', ST: 'pt', CV: 'pt', TG: 'fr',
  BJ: 'fr', BW: 'en', NA: 'en', SZ: 'en', LS: 'en', SC: 'en', KM: 'ar', MU: 'en',

  // Asia
  CN: 'zh', TW: 'zh', HK: 'zh', MO: 'zh', JP: 'ja', KR: 'ko', KP: 'ko', MN: 'mn',
  IN: 'en', PK: 'ur', BD: 'bn', LK: 'si', NP: 'ne', BT: 'en', MV: 'en',
  TH: 'th', VN: 'vi', ID: 'id', MY: 'ms', SG: 'en', PH: 'tl', LA: 'lo', KH: 'km', MM: 'my',
  TL: 'pt', BN: 'ms',
  KZ: 'kk', UZ: 'uz', TM: 'ru', TJ: 'ru', KG: 'ru', AZ: 'az', AM: 'en', GE: 'ka',

  // Oceania
  AU: 'en', NZ: 'en', PG: 'en', FJ: 'en', SB: 'en', VU: 'en', WS: 'en', TO: 'en', KI: 'en',
  TV: 'en', NR: 'en', PW: 'en', FM: 'en', MH: 'en',
}

/**
 * Map a country code → one of our supported locales. Falls through to
 * the default locale if the country isn't in the table or maps to an
 * unsupported language.
 */
export function localeForCountry(country: string | null | undefined): string {
  if (!country) return DEFAULT_LOCALE
  const candidate = COUNTRY_TO_LOCALE[country.toUpperCase()]
  if (candidate && SUPPORTED_LOCALES.includes(candidate)) return candidate
  return DEFAULT_LOCALE
}
