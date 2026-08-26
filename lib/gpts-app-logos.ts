/**
 * Professional logo resolver for the Apps catalog on /conexiones and /gpts.
 *
 * Priority:
 *   1. Local official mark under /conexiones-logos/ (Simple Icons / owned SVG)
 *   2. High-res domain logo (Clearbit, then DuckDuckGo ip3)
 *   3. Initials fallback is handled by AppLogo after every src errors
 */

export type GptStoreAppLogoInput = {
  id: string
  domain: string
}

const LOCAL_LOGO_DIR = "/conexiones-logos"

/** Multi-part public suffixes used as the brand apex (not just the last 2 labels). */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk",
  "com.au",
  "com.br",
  "co.kr",
  "co.za",
  "com.tr",
  "com.ua",
  "gov.ae",
  "com.lu",
  "co.nz",
  "com.mx",
])

const FILE_BY_SLUG: Record<string, string> = {
  google: "google.svg",
  gmail: "gmail.svg",
  googlecalendar: "googlecalendar.svg",
  googledrive: "googledrive.svg",
  googlemaps: "googlemaps.svg",
  googleads: "googleads.svg",
  googleanalytics: "googleanalytics.svg",
  googlecloud: "googlecloud.svg",
  googleplay: "googleplay.svg",
  slack: "slack.svg",
  x: "x.svg",
  twitter: "x.svg",
  linkedin: "linkedin.svg",
  meta: "meta.svg",
  facebook: "facebook.svg",
  instagram: "instagram.svg",
  whatsapp: "whatsapp.svg",
  github: "github.svg",
  notion: "notion.svg",
  youtube: "youtube.svg",
  spotify: "spotify.svg",
  amazon: "amazon.svg",
  indeed: "indeed.svg",
  etsy: "etsy.svg",
  meetup: "meetup.svg",
  producthunt: "producthunt.svg",
  swiggy: "swiggy.svg",
  foodpanda: "foodpanda.svg",
  volkswagen: "volkswagen.svg",
  gumtree: "gumtree.svg",
  inoreader: "inoreader.svg",
  kleinanzeigen: "kleinanzeigen.svg",
  aliexpress: "aliexpress.svg",
  tesla: "tesla.svg",
  emlakjet: "emlakjet.svg",
  penny: "penny.svg",
  bandsintown: "bandsintown.svg",
  boulanger: "boulanger.svg",
  blibli: "blibli.svg",
  zola: "zola.svg",
  microsoft: "microsoft.svg",
  windows: "windows.svg",
  outlook: "microsoftoutlook.svg",
  microsoftoutlook: "microsoftoutlook.svg",
  teams: "microsoftteams.svg",
  microsoftteams: "microsoftteams.svg",
  onedrive: "onedrive.svg",
  microsoftonedrive: "microsoftonedrive.svg",
  discord: "discord.svg",
  telegram: "telegram.svg",
  reddit: "reddit.svg",
  pinterest: "pinterest.svg",
  tiktok: "tiktok.svg",
  snapchat: "snapchat.svg",
  dropbox: "dropbox.svg",
  canva: "canva.svg",
  figma: "figma.svg",
  asana: "asana.svg",
  trello: "trello.svg",
  shopify: "shopify.svg",
  uber: "uber.svg",
  airbnb: "airbnb.svg",
  netflix: "netflix.svg",
  paypal: "paypal.svg",
  stripe: "stripe.svg",
  ebay: "ebay.svg",
  walmart: "walmart.svg",
  ikea: "ikea.svg",
  target: "target.svg",
  zoom: "zoom.svg",
  apple: "apple.svg",
  zillow: "zillow.svg",
  glassdoor: "glassdoor.svg",
  deliveroo: "deliveroo.svg",
  justeat: "justeat.svg",
}

/** App id → local mark (covers catalog ids and well-known aliases). */
const FILE_BY_ID: Record<string, string> = {
  indeed: "indeed.svg",
  linkedin: "linkedin.svg",
  etsy: "etsy.svg",
  meetup: "meetup.svg",
  "product-hunt": "producthunt.svg",
  swiggy: "swiggy.svg",
  "swiggy-food": "swiggy.svg",
  foodpanda: "foodpanda.svg",
  "vw-sign-drive": "volkswagen.svg",
  gumtree: "gumtree.svg",
  inoreader: "inoreader.svg",
  kleinanzeigen: "kleinanzeigen.svg",
  pandafind: "aliexpress.svg",
  tessie: "tesla.svg",
  emlakjet: "emlakjet.svg",
  penny: "penny.svg",
  bandsintown: "bandsintown.svg",
  "boulanger-achat-en-ligne": "boulanger.svg",
  blibli: "blibli.svg",
  zola: "zola.svg",
  gmail: "gmail.svg",
  google: "google.svg",
  calendar: "googlecalendar.svg",
  drive: "googledrive.svg",
  slack: "slack.svg",
  twitter: "x.svg",
  x: "x.svg",
  facebook: "facebook.svg",
  meta: "meta.svg",
  instagram: "instagram.svg",
  whatsapp: "whatsapp.svg",
  github: "github.svg",
  notion: "notion.svg",
  youtube: "youtube.svg",
  spotify: "spotify.svg",
  amazon: "amazon.svg",
}

/**
 * Domain / apex → local mark. Subdomains of these hosts inherit the mark
 * unless a more specific host is listed (calendar.google.com, etc.).
 */
const FILE_BY_DOMAIN: Record<string, string> = {
  "google.com": "google.svg",
  "gmail.com": "gmail.svg",
  "mail.google.com": "gmail.svg",
  "calendar.google.com": "googlecalendar.svg",
  "drive.google.com": "googledrive.svg",
  "docs.google.com": "googledrive.svg",
  "maps.google.com": "googlemaps.svg",
  "ads.google.com": "googleads.svg",
  "analytics.google.com": "googleanalytics.svg",
  "cloud.google.com": "googlecloud.svg",
  "play.google.com": "googleplay.svg",
  "slack.com": "slack.svg",
  "x.com": "x.svg",
  "twitter.com": "x.svg",
  "linkedin.com": "linkedin.svg",
  "meta.com": "meta.svg",
  "facebook.com": "facebook.svg",
  "fb.com": "facebook.svg",
  "instagram.com": "instagram.svg",
  "whatsapp.com": "whatsapp.svg",
  "wa.me": "whatsapp.svg",
  "github.com": "github.svg",
  "notion.so": "notion.svg",
  "notion.com": "notion.svg",
  "youtube.com": "youtube.svg",
  "youtu.be": "youtube.svg",
  "spotify.com": "spotify.svg",
  "amazon.com": "amazon.svg",
  "indeed.com": "indeed.svg",
  "etsy.com": "etsy.svg",
  "meetup.com": "meetup.svg",
  "producthunt.com": "producthunt.svg",
  "swiggy.com": "swiggy.svg",
  "foodpanda.com": "foodpanda.svg",
  "volkswagen.com": "volkswagen.svg",
  "vw.com": "volkswagen.svg",
  "gumtree.com": "gumtree.svg",
  "inoreader.com": "inoreader.svg",
  "kleinanzeigen.de": "kleinanzeigen.svg",
  "aliexpress.com": "aliexpress.svg",
  "tesla.com": "tesla.svg",
  "tessie.com": "tesla.svg",
  "emlakjet.com": "emlakjet.svg",
  "penny.de": "penny.svg",
  "bandsintown.com": "bandsintown.svg",
  "boulanger.com": "boulanger.svg",
  "blibli.com": "blibli.svg",
  "zola.com": "zola.svg",
  "microsoft.com": "microsoft.svg",
  "office.com": "microsoft.svg",
  "live.com": "microsoft.svg",
  "outlook.com": "microsoftoutlook.svg",
  "outlook.office.com": "microsoftoutlook.svg",
  "teams.microsoft.com": "microsoftteams.svg",
  "onedrive.com": "onedrive.svg",
  "onedrive.live.com": "onedrive.svg",
  "discord.com": "discord.svg",
  "telegram.org": "telegram.svg",
  "t.me": "telegram.svg",
  "reddit.com": "reddit.svg",
  "pinterest.com": "pinterest.svg",
  "tiktok.com": "tiktok.svg",
  "snapchat.com": "snapchat.svg",
  "dropbox.com": "dropbox.svg",
  "canva.com": "canva.svg",
  "figma.com": "figma.svg",
  "asana.com": "asana.svg",
  "trello.com": "trello.svg",
  "shopify.com": "shopify.svg",
  "uber.com": "uber.svg",
  "airbnb.com": "airbnb.svg",
  "netflix.com": "netflix.svg",
  "paypal.com": "paypal.svg",
  "stripe.com": "stripe.svg",
  "ebay.com": "ebay.svg",
  "walmart.com": "walmart.svg",
  "ikea.com": "ikea.svg",
  "target.com": "target.svg",
  "zoom.us": "zoom.svg",
  "apple.com": "apple.svg",
  "icloud.com": "apple.svg",
  "zillow.com": "zillow.svg",
  "glassdoor.com": "glassdoor.svg",
  "deliveroo.com": "deliveroo.svg",
  "just-eat.com": "justeat.svg",
  "justeat.com": "justeat.svg",
}

const GOOGLE_APEX = /^google\.[a-z]{2,3}(?:\.[a-z]{2})?$/
const AMAZON_APEX = /^amazon\.[a-z]{2,3}(?:\.[a-z]{2})?$/

export function normalizeLogoDomain(domain: string): string {
  return String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split(":")[0]
}

export function apexLogoDomain(domain: string): string {
  const host = normalizeLogoDomain(domain)
  if (!host) return ""
  const parts = host.split(".").filter(Boolean)
  if (parts.length < 2) return host
  const lastTwo = parts.slice(-2).join(".")
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".")
  }
  if (/^(co|com|gov|net|org|ac)\.[a-z]{2}$/.test(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".")
  }
  return lastTwo
}

function localPath(file: string | undefined): string | null {
  if (!file) return null
  return `${LOCAL_LOGO_DIR}/${file}`
}

export function officialMarkPath(app: GptStoreAppLogoInput): string | null {
  const id = String(app.id || "").trim().toLowerCase()
  if (id && FILE_BY_ID[id]) return localPath(FILE_BY_ID[id])

  const host = normalizeLogoDomain(app.domain)
  if (!host) {
    if (id && FILE_BY_SLUG[id]) return localPath(FILE_BY_SLUG[id])
    return null
  }

  if (FILE_BY_DOMAIN[host]) return localPath(FILE_BY_DOMAIN[host])

  if (host.endsWith(".google.com") || GOOGLE_APEX.test(host)) {
    if (host.startsWith("mail.")) return localPath("gmail.svg")
    if (host.startsWith("calendar.")) return localPath("googlecalendar.svg")
    if (host.startsWith("drive.") || host.startsWith("docs.")) return localPath("googledrive.svg")
    if (host.startsWith("maps.")) return localPath("googlemaps.svg")
    return localPath("google.svg")
  }

  const apex = apexLogoDomain(host)
  if (FILE_BY_DOMAIN[apex]) return localPath(FILE_BY_DOMAIN[apex])
  if (AMAZON_APEX.test(apex) || AMAZON_APEX.test(host)) return localPath("amazon.svg")
  if (GOOGLE_APEX.test(apex)) return localPath("google.svg")

  const brand = apex.split(".")[0]
  if (FILE_BY_SLUG[brand]) return localPath(FILE_BY_SLUG[brand])
  if (id && FILE_BY_SLUG[id]) return localPath(FILE_BY_SLUG[id])
  return null
}

export function clearbitLogoUrl(domain: string): string {
  return `https://logo.clearbit.com/${encodeURIComponent(normalizeLogoDomain(domain))}`
}

export function duckduckgoLogoUrl(domain: string): string {
  return `https://icons.duckduckgo.com/ip3/${normalizeLogoDomain(domain)}.ico`
}

export function gptStoreAppLogoSources(app: GptStoreAppLogoInput): string[] {
  const domain = normalizeLogoDomain(app.domain)
  const sources: string[] = []
  const local = officialMarkPath(app)
  if (local) sources.push(local)
  if (domain) {
    sources.push(clearbitLogoUrl(domain))
    sources.push(duckduckgoLogoUrl(domain))
  }
  return [...new Set(sources)]
}

/** Primary logo URL (local mark or first high-res domain endpoint). */
export function gptStoreAppLogoUrl(app: GptStoreAppLogoInput): string {
  return gptStoreAppLogoSources(app)[0] || ""
}
