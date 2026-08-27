/**
 * Professional logo resolver for the Apps catalog on /conexiones and /gpts.
 *
 * Priority:
 *   1. Local official mark under /conexiones-logos/ (Simple Icons / owned SVG)
 *   2. Generated professional SVG tile (category glyph + monogram) for
 *      invented GPT-store hosts and any app without an official mark —
 *      never a blank box or a generic globe favicon
 *   3. Initials fallback is handled by AppLogo after every src errors
 */

export type GptStoreAppLogoInput = {
  id: string
  domain: string
  name?: string
  category?: string
  logo?: string
  icon?: string
}

function explicitCatalogLogo(app: GptStoreAppLogoInput): string | null {
  const value = String(app.logo || app.icon || "").trim()
  return value || null
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
  idealista: "idealista.svg",
  redfin: "redfin.svg",
  autoscout24: "autoscout24.svg",
  autotrader: "autotrader.svg",
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
  idealista: "idealista.svg",
  redfin: "redfin.svg",
  autoscout24: "autoscout24.svg",
  autotrader: "autotrader.svg",
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
  "idealista.com": "idealista.svg",
  "redfin.com": "redfin.svg",
  "autoscout24.com": "autoscout24.svg",
  "autotrader.com": "autotrader.svg",
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

const TILE_PALETTE = [
  ["#1D4ED8", "#EFF6FF"],
  ["#0F766E", "#F0FDFA"],
  ["#7C3AED", "#F5F3FF"],
  ["#B45309", "#FFFBEB"],
  ["#BE123C", "#FFF1F2"],
  ["#334155", "#F8FAFC"],
  ["#0369A1", "#F0F9FF"],
  ["#166534", "#F0FDF4"],
] as const

function hashId(id: string): number {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash
}

function tileInitials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "A"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Fabricated GPT-store hostnames (astro-scope-destiny-matrix.com, …)
 * never resolve on Clearbit / favicon CDNs. Those cards need a local SVG.
 */
export function isLikelyInventedDomain(domain: string): boolean {
  const host = normalizeLogoDomain(domain)
  const label = host.split(".")[0] || ""
  const hyphens = (label.match(/-/g) || []).length
  if (hyphens >= 2) return true
  if (label.length >= 24) return true
  if (/^\d/.test(label) && hyphens >= 1) return true
  return false
}

function categoryGlyph(category: string | undefined, fill: string): string {
  switch (category) {
    case "Empleo":
      return `<rect x="18" y="28" width="28" height="18" rx="3" fill="none" stroke="${fill}" stroke-width="2.4"/><path d="M26 28v-3a6 6 0 0 1 12 0v3" fill="none" stroke="${fill}" stroke-width="2.4"/>`
    case "Inmuebles":
      return `<path d="M12 30 32 14 52 30v22H12z" fill="none" stroke="${fill}" stroke-width="2.4"/><rect x="28" y="36" width="8" height="16" fill="none" stroke="${fill}" stroke-width="2.2"/>`
    case "Autos":
      return `<path d="M14 38h36l-5-12H19z" fill="none" stroke="${fill}" stroke-width="2.4"/><circle cx="22" cy="40" r="3.2" fill="${fill}"/><circle cx="42" cy="40" r="3.2" fill="${fill}"/>`
    case "Compras":
      return `<path d="M20 26h24l2 22H18z" fill="none" stroke="${fill}" stroke-width="2.4"/><path d="M24 26a8 8 0 0 1 16 0" fill="none" stroke="${fill}" stroke-width="2.4"/>`
    case "Astrología":
      return `<path d="M32 14l3.2 9.8H46l-8.4 6.2 3.2 9.8L32 33.6 23.2 39.8l3.2-9.8L18 23.8h10.8z" fill="${fill}"/>`
    case "Comida":
      return `<path d="M22 16v20a10 10 0 0 0 20 0V16" fill="none" stroke="${fill}" stroke-width="2.4"/><path d="M22 22h20" fill="none" stroke="${fill}" stroke-width="2.4"/>`
    case "Noticias":
      return `<rect x="16" y="16" width="32" height="32" rx="4" fill="none" stroke="${fill}" stroke-width="2.4"/><path d="M22 26h20M22 34h14" fill="none" stroke="${fill}" stroke-width="2.4"/>`
    default:
      return `<circle cx="32" cy="32" r="11" fill="none" stroke="${fill}" stroke-width="2.4"/><circle cx="32" cy="32" r="4" fill="${fill}"/>`
  }
}

/** Deterministic professional tile — category glyph + monogram, never a blank box. */
export function generatedBrandTileSvg(app: GptStoreAppLogoInput): string {
  const label = (app.name || app.id || "App").trim()
  const [bg, fg] = TILE_PALETTE[hashId(app.id || label) % TILE_PALETTE.length]
  const letters = escapeXml(tileInitials(label))
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img">`,
    `<rect width="64" height="64" rx="16" fill="${bg}"/>`,
    `<g opacity="0.28">${categoryGlyph(app.category, fg)}</g>`,
    `<text x="32" y="40" text-anchor="middle" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="18" font-weight="700" fill="${fg}">${letters}</text>`,
    `</svg>`,
  ].join("")
}

export function generatedBrandTileUrl(app: GptStoreAppLogoInput): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(generatedBrandTileSvg(app))}`
}

export function gptStoreAppLogoSources(app: GptStoreAppLogoInput): string[] {
  const generated = generatedBrandTileUrl(app)
  const explicit = explicitCatalogLogo(app)
  const local = officialMarkPath(app)
  const sources: string[] = []
  if (explicit) sources.push(explicit)
  if (local && local !== explicit) sources.push(local)
  if (sources.length > 0) return [...sources, generated]
  // Unmapped + invented hosts: a real local SVG so the tile is never a blank
  // box or a generic globe from a failed favicon/Clearbit lookup.
  return [generated]
}

/** Primary logo URL (local mark, high-res domain logo, or generated SVG tile). */
export function gptStoreAppLogoUrl(app: GptStoreAppLogoInput): string {
  return gptStoreAppLogoSources(app)[0] || generatedBrandTileUrl(app)
}

/**
 * Official catalog mark only — explicit `logo`/`icon` or a local SVG.
 * Returns null when the app has no real asset (caller keeps its generic fallback).
 * Never invents a monogram tile.
 */
export function officialCatalogLogoSources(app: GptStoreAppLogoInput): string[] {
  const explicit = explicitCatalogLogo(app)
  const local = officialMarkPath(app)
  const sources: string[] = []
  if (explicit) sources.push(explicit)
  if (local && local !== explicit) sources.push(local)
  return sources
}

export function officialCatalogLogoUrl(app: GptStoreAppLogoInput): string | null {
  return officialCatalogLogoSources(app)[0] || null
}
