/**
 * Professional logo resolver for the Apps catalog on /conexiones and /gpts.
 *
 * Priority:
 *   1. Local official mark under /conexiones-logos/ (Simple Icons / owned SVG)
 *   2. Local high-res brand favicon under /conexiones-logos/brand/ (real
 *      domain mark bundled from each site's favicon, 32px+)
 *   3. Generated professional SVG tile (category glyph + monogram) for
 *      invented GPT-store hosts and any app without an official mark —
 *      never a blank box or a generic globe favicon
 *   4. Initials fallback is handled by AppLogo after every src errors
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

/**
 * Real domain marks bundled locally from each site's favicon (Google s2
 * sz=256, filtered to PNG/JPEG 32px+ so tiles never look pixelated).
 * Domain (normalized, apex) → bundled file.
 */
const BRAND_FAVICON_BY_DOMAIN: Record<string, string> = {
  "12andus.com": "/conexiones-logos/brand/12andus.com.png",
  "3byggetilbud.dk": "/conexiones-logos/brand/3byggetilbud.dk.png",
  "airtasker.com": "/conexiones-logos/brand/airtasker.com.png",
  "aliexpress.com": "/conexiones-logos/brand/aliexpress.com.png",
  "alldiscgolf.com": "/conexiones-logos/brand/alldiscgolf.com.png",
  "amoremall.com": "/conexiones-logos/brand/amoremall.com.png",
  "annstracts.com": "/conexiones-logos/brand/annstracts.com.jpg",
  "anyvan.com": "/conexiones-logos/brand/anyvan.com.png",
  "apexlog.com": "/conexiones-logos/brand/apexlog.com.png",
  "arabica.ae": "/conexiones-logos/brand/arabica.ae.png",
  "astrologic.io": "/conexiones-logos/brand/astrologic.io.png",
  "athome.lu": "/conexiones-logos/brand/athome.lu.png",
  "auto.com": "/conexiones-logos/brand/auto.com.jpg",
  "automotion.com": "/conexiones-logos/brand/automotion.com.png",
  "autoscout24.com": "/conexiones-logos/brand/autoscout24.com.png",
  "autotrader.com": "/conexiones-logos/brand/autotrader.com.png",
  "autovit.ro": "/conexiones-logos/brand/autovit.ro.jpg",
  "avito.ma": "/conexiones-logos/brand/avito.ma.png",
  "bandsintown.com": "/conexiones-logos/brand/bandsintown.com.png",
  "bayut.com": "/conexiones-logos/brand/bayut.com.png",
  "bayut.sa": "/conexiones-logos/brand/bayut.sa.png",
  "belk.com": "/conexiones-logos/brand/belk.com.png",
  "blibli.com": "/conexiones-logos/brand/blibli.com.png",
  "boostermage.com": "/conexiones-logos/brand/boostermage.com.jpg",
  "boulanger.com": "/conexiones-logos/brand/boulanger.com.png",
  "boyner.com.tr": "/conexiones-logos/brand/boyner.com.tr.png",
  "buywise.com": "/conexiones-logos/brand/buywise.com.png",
  "cafe24.com": "/conexiones-logos/brand/cafe24.com.png",
  "cargo.com": "/conexiones-logos/brand/cargo.com.png",
  "carparts.com": "/conexiones-logos/brand/carparts.com.png",
  "cars24.com": "/conexiones-logos/brand/cars24.com.png",
  "carsguide.com.au": "/conexiones-logos/brand/carsguide.com.au.png",
  "carslink.ai": "/conexiones-logos/brand/carslink.ai.png",
  "carwale.com": "/conexiones-logos/brand/carwale.com.png",
  "casepoint.com": "/conexiones-logos/brand/casepoint.com.png",
  "catholic-index.com": "/conexiones-logos/brand/catholic-index.com.png",
  "chaiz.com": "/conexiones-logos/brand/chaiz.com.png",
  "champfy.com": "/conexiones-logos/brand/champfy.com.png",
  "chotot.com": "/conexiones-logos/brand/chotot.com.png",
  "clickdealer.com": "/conexiones-logos/brand/clickdealer.com.png",
  "cliqueimudei.com": "/conexiones-logos/brand/cliqueimudei.com.png",
  "closai.com": "/conexiones-logos/brand/closai.com.png",
  "clutch.ca": "/conexiones-logos/brand/clutch.ca.png",
  "coches.net": "/conexiones-logos/brand/coches.net.png",
  "confused.com": "/conexiones-logos/brand/confused.com.png",
  "connectlinx.com": "/conexiones-logos/brand/connectlinx.com.jpg",
  "cora.com": "/conexiones-logos/brand/cora.com.png",
  "cowboy.com": "/conexiones-logos/brand/cowboy.com.png",
  "crbonfree.com": "/conexiones-logos/brand/crbonfree.com.jpg",
  "daft.ie": "/conexiones-logos/brand/daft.ie.png",
  "develoop.com": "/conexiones-logos/brand/develoop.com.png",
  "dewa.gov.ae": "/conexiones-logos/brand/dewa.gov.ae.jpg",
  "dispatcher.city": "/conexiones-logos/brand/dispatcher.city.jpg",
  "donedeal.ie": "/conexiones-logos/brand/donedeal.ie.png",
  "elandmall.com": "/conexiones-logos/brand/elandmall.com.png",
  "elko.is": "/conexiones-logos/brand/elko.is.png",
  "emlakjet.com": "/conexiones-logos/brand/emlakjet.com.png",
  "endurance-planner.com": "/conexiones-logos/brand/endurance-planner.com.png",
  "engelvoelkers.com": "/conexiones-logos/brand/engelvoelkers.com.png",
  "etland.co.kr": "/conexiones-logos/brand/etland.co.kr.png",
  "etsy.com": "/conexiones-logos/brand/etsy.com.png",
  "experteer.com": "/conexiones-logos/brand/experteer.com.png",
  "facebook.com": "/conexiones-logos/brand/facebook.com.png",
  "foodora.com": "/conexiones-logos/brand/foodora.com.png",
  "foodpanda.com": "/conexiones-logos/brand/foodpanda.com.png",
  "fotocasa.es": "/conexiones-logos/brand/fotocasa.es.png",
  "freediver.com": "/conexiones-logos/brand/freediver.com.png",
  "freshblooms.com": "/conexiones-logos/brand/freshblooms.com.png",
  "fryd.com": "/conexiones-logos/brand/fryd.com.png",
  "gathrd.com": "/conexiones-logos/brand/gathrd.com.png",
  "gethumandesign.com": "/conexiones-logos/brand/gethumandesign.com.png",
  "getir.com": "/conexiones-logos/brand/getir.com.png",
  "github.com": "/conexiones-logos/brand/github.com.png",
  "gmarket.co.kr": "/conexiones-logos/brand/gmarket.co.kr.png",
  "gsretail.com": "/conexiones-logos/brand/gsretail.com.png",
  "gumtree.com": "/conexiones-logos/brand/gumtree.com.png",
  "guyal.com": "/conexiones-logos/brand/guyal.com.png",
  "haaretz.com": "/conexiones-logos/brand/haaretz.com.png",
  "hausmann-immobilien.com": "/conexiones-logos/brand/hausmann-immobilien.com.jpg",
  "hepsiemlak.com": "/conexiones-logos/brand/hepsiemlak.com.png",
  "herecomestheguide.com": "/conexiones-logos/brand/herecomestheguide.com.png",
  "home-connect.com": "/conexiones-logos/brand/home-connect.com.png",
  "homey.app": "/conexiones-logos/brand/homey.app.png",
  "hookradar.com": "/conexiones-logos/brand/hookradar.com.png",
  "horizon-shield.com": "/conexiones-logos/brand/horizon-shield.com.png",
  "horoscope.com": "/conexiones-logos/brand/horoscope.com.png",
  "idealista.com": "/conexiones-logos/brand/idealista.com.png",
  "immobiliare.it": "/conexiones-logos/brand/immobiliare.it.png",
  "immobilien-franzen.com": "/conexiones-logos/brand/immobilien-franzen.com.png",
  "immobilier.lefigaro.fr": "/conexiones-logos/brand/immobilier.lefigaro.fr.png",
  "imovirtual.com": "/conexiones-logos/brand/imovirtual.com.png",
  "indeed.com": "/conexiones-logos/brand/indeed.com.png",
  "innovist.com": "/conexiones-logos/brand/innovist.com.png",
  "inoreader.com": "/conexiones-logos/brand/inoreader.com.png",
  "internshala.com": "/conexiones-logos/brand/internshala.com.png",
  "iqcars.net": "/conexiones-logos/brand/iqcars.net.png",
  "japanbox.kz": "/conexiones-logos/brand/japanbox.kz.jpg",
  "jobicy.com": "/conexiones-logos/brand/jobicy.com.png",
  "justlife.com": "/conexiones-logos/brand/justlife.com.png",
  "karaca.com": "/conexiones-logos/brand/karaca.com.png",
  "kleinanzeigen.de": "/conexiones-logos/brand/kleinanzeigen.de.png",
  "labyrinthos.co": "/conexiones-logos/brand/labyrinthos.co.png",
  "lacentrale.fr": "/conexiones-logos/brand/lacentrale.fr.png",
  "ladepeche.fr": "/conexiones-logos/brand/ladepeche.fr.png",
  "landwirt.com": "/conexiones-logos/brand/landwirt.com.png",
  "laundryheap.com": "/conexiones-logos/brand/laundryheap.com.png",
  "leparisien.fr": "/conexiones-logos/brand/leparisien.fr.png",
  "lfmall.co.kr": "/conexiones-logos/brand/lfmall.co.kr.png",
  "liftosaur.com": "/conexiones-logos/brand/liftosaur.com.jpg",
  "linkedin.com": "/conexiones-logos/brand/linkedin.com.png",
  "loft.com.br": "/conexiones-logos/brand/loft.com.br.png",
  "loveandlemons.com": "/conexiones-logos/brand/loveandlemons.com.png",
  "lu.ma": "/conexiones-logos/brand/lu.ma.jpg",
  "lume.com": "/conexiones-logos/brand/lume.com.png",
  "luxauto.lu": "/conexiones-logos/brand/luxauto.lu.png",
  "magneto365.com": "/conexiones-logos/brand/magneto365.com.png",
  "meetup.com": "/conexiones-logos/brand/meetup.com.png",
  "mercadolibre.com": "/conexiones-logos/brand/mercadolibre.com.png",
  "midilibre.fr": "/conexiones-logos/brand/midilibre.fr.png",
  "milanuncios.com": "/conexiones-logos/brand/milanuncios.com.png",
  "mimove.com": "/conexiones-logos/brand/mimove.com.png",
  "minty.com": "/conexiones-logos/brand/minty.com.png",
  "mondoir.art": "/conexiones-logos/brand/mondoir.art.png",
  "monnier-paris.com": "/conexiones-logos/brand/monnier-paris.com.png",
  "motos.net": "/conexiones-logos/brand/motos.net.png",
  "muju.com": "/conexiones-logos/brand/muju.com.png",
  "mumzworld.com": "/conexiones-logos/brand/mumzworld.com.png",
  "municibid.com": "/conexiones-logos/brand/municibid.com.jpg",
  "musinsa.com": "/conexiones-logos/brand/musinsa.com.png",
  "mycolive.com": "/conexiones-logos/brand/mycolive.com.png",
  "myregistry.com": "/conexiones-logos/brand/myregistry.com.png",
  "nailie.jp": "/conexiones-logos/brand/nailie.jp.png",
  "newsify.co": "/conexiones-logos/brand/newsify.co.png",
  "octopart.com": "/conexiones-logos/brand/octopart.com.png",
  "oliveyoung.co.kr": "/conexiones-logos/brand/oliveyoung.co.kr.png",
  "olx.in": "/conexiones-logos/brand/olx.in.png",
  "onxmaps.com": "/conexiones-logos/brand/onxmaps.com.png",
  "ordering.tools": "/conexiones-logos/brand/ordering.tools.png",
  "otomoto.pl": "/conexiones-logos/brand/otomoto.pl.png",
  "pararius.com": "/conexiones-logos/brand/pararius.com.png",
  "penny.de": "/conexiones-logos/brand/penny.de.png",
  "polypo.com": "/conexiones-logos/brand/polypo.com.png",
  "powerly.ai": "/conexiones-logos/brand/powerly.ai.png",
  "print.com": "/conexiones-logos/brand/print.com.png",
  "printa.com": "/conexiones-logos/brand/printa.com.png",
  "privatemdlabs.com": "/conexiones-logos/brand/privatemdlabs.com.png",
  "producthunt.com": "/conexiones-logos/brand/producthunt.com.png",
  "promocodes.com": "/conexiones-logos/brand/promocodes.com.png",
  "publicstorage.com": "/conexiones-logos/brand/publicstorage.com.png",
  "quintoandar.com.br": "/conexiones-logos/brand/quintoandar.com.br.png",
  "rakhys.com": "/conexiones-logos/brand/rakhys.com.png",
  "realestate.com.au": "/conexiones-logos/brand/realestate.com.au.png",
  "redfin.com": "/conexiones-logos/brand/redfin.com.png",
  "refermate.com": "/conexiones-logos/brand/refermate.com.png",
  "remode.com": "/conexiones-logos/brand/remode.com.png",
  "rentals.ca": "/conexiones-logos/brand/rentals.ca.png",
  "rilev.com": "/conexiones-logos/brand/rilev.com.png",
  "rozetka.com.ua": "/conexiones-logos/brand/rozetka.com.ua.png",
  "sangria.com": "/conexiones-logos/brand/sangria.com.png",
  "shipal.com": "/conexiones-logos/brand/shipal.com.png",
  "shopback.com": "/conexiones-logos/brand/shopback.com.png",
  "simplysefer.com": "/conexiones-logos/brand/simplysefer.com.png",
  "smartcustomer.com": "/conexiones-logos/brand/smartcustomer.com.png",
  "softonic.com": "/conexiones-logos/brand/softonic.com.png",
  "spaartje.com": "/conexiones-logos/brand/spaartje.com.jpg",
  "spotahome.com": "/conexiones-logos/brand/spotahome.com.png",
  "squareyards.com": "/conexiones-logos/brand/squareyards.com.png",
  "standvirtual.com": "/conexiones-logos/brand/standvirtual.com.png",
  "swiggy.com": "/conexiones-logos/brand/swiggy.com.png",
  "systembolaget.se": "/conexiones-logos/brand/systembolaget.se.png",
  "tastewise.io": "/conexiones-logos/brand/tastewise.io.png",
  "tessie.com": "/conexiones-logos/brand/tessie.com.png",
  "tessun-immobilien.com": "/conexiones-logos/brand/tessun-immobilien.com.png",
  "tiendanube.com": "/conexiones-logos/brand/tiendanube.com.png",
  "tillys.com": "/conexiones-logos/brand/tillys.com.png",
  "tixel.com": "/conexiones-logos/brand/tixel.com.png",
  "trocafone.com": "/conexiones-logos/brand/trocafone.com.png",
  "trovaprezzi.it": "/conexiones-logos/brand/trovaprezzi.it.png",
  "tuespaciopr.com": "/conexiones-logos/brand/tuespaciopr.com.jpg",
  "vaktim.com": "/conexiones-logos/brand/vaktim.com.png",
  "volkswagen.com": "/conexiones-logos/brand/volkswagen.com.png",
  "wallector.com": "/conexiones-logos/brand/wallector.com.png",
  "weavify.com": "/conexiones-logos/brand/weavify.com.png",
  "webuycars.co.za": "/conexiones-logos/brand/webuycars.co.za.png",
  "whowhatwear.com": "/conexiones-logos/brand/whowhatwear.com.png",
  "workopia.com": "/conexiones-logos/brand/workopia.com.jpg",
  "x.com": "/conexiones-logos/brand/x.com.png",
  "yogiyo.co.kr": "/conexiones-logos/brand/yogiyo.co.kr.png",
  "zenshopping.com": "/conexiones-logos/brand/zenshopping.com.png",
  "zola.com": "/conexiones-logos/brand/zola.com.png",
}

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

export function brandFaviconPath(app: GptStoreAppLogoInput): string | null {
  const host = normalizeLogoDomain(app.domain)
  if (!host) return null
  if (BRAND_FAVICON_BY_DOMAIN[host]) return BRAND_FAVICON_BY_DOMAIN[host]
  const apex = apexLogoDomain(host)
  if (apex && apex !== host && BRAND_FAVICON_BY_DOMAIN[apex]) return BRAND_FAVICON_BY_DOMAIN[apex]
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
  const brand = brandFaviconPath(app)
  const sources: string[] = []
  if (explicit) sources.push(explicit)
  if (local && local !== explicit) sources.push(local)
  if (brand && brand !== explicit && brand !== local) sources.push(brand)
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
