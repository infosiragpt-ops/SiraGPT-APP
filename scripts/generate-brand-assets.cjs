#!/usr/bin/env node
/**
 * generate-brand-assets — renders every raster/vector asset of the official
 * SiraGPT mark (the eight-arm mark, Luis 2026-10-09) from the single motion
 * model in `lib/brand/sira-motion.ts`, so a brand change is one script run:
 *
 *   node scripts/generate-brand-assets.cjs            # everything
 *   node scripts/generate-brand-assets.cjs --only=web # web | social | android | ios | desktop | extension
 *
 * Surfaces: favicon + PWA icons + manifest maskable + brand SVGs (public/),
 * Open Graph / Twitter cards, Capacitor Android launcher + splash PNGs,
 * iOS AppIcon + splash, Electron desktop icon.png/.icns/.ico (+ the Windows
 * appx tiles via scripts/generate-windows-appx-assets.js) and the browser
 * extension icons. Ink is #0A0A0A on white; nothing else carries colour.
 *
 * Requires the root dependencies (sharp, typescript). The social cards set
 * their wordmark in Liberation Sans (metric-compatible with Arial) resolved
 * through fontconfig at render time; the committed PNGs are the artefact (CI
 * never renders them), so regenerate them on a machine with the Liberation
 * fonts installed (fonts-liberation on Debian/Ubuntu) to keep the wordmark
 * identical.
 */

const fs = require("fs")
const path = require("path")
const { execFileSync } = require("child_process")
const sharp = require("sharp")
const ts = require("typescript")

const root = path.resolve(__dirname, "..")
const INK = "#0A0A0A"
const WHITE = "#ffffff"

function loadMotionModel() {
  const source = fs.readFileSync(path.join(root, "lib/brand/sira-motion.ts"), "utf8")
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const mod = { exports: {} }
  new Function("module", "exports", "require", outputText)(mod, mod.exports, require)
  return mod.exports
}

const motion = loadMotionModel()
const { LOGO_GEOMETRY, LOGO_GEOMETRY_SMALL, siraMarkSvg } = motion

/** The mark's inner groups (arms + dots) in a given ink, without the <svg> wrapper. */
function markInner(color, geometry = LOGO_GEOMETRY) {
  const svg = siraMarkSvg({ geometry, color, title: null })
  return svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")
}

function round2(v) {
  return Math.round(v * 100) / 100
}

/**
 * A square tile: optional background (rounded by `radius`, a fraction of the
 * side) with the mark centred at `ratio` of the side. Returns SVG markup.
 */
function tileSvg({ size, ratio, radius = 0, background = WHITE, geometry = LOGO_GEOMETRY, color = INK, label = "SiraGPT" }) {
  const mark = size * ratio
  const scale = mark / geometry.size
  const offset = (size - mark) / 2
  const rx = radius > 0 ? ` rx="${round2(size * radius)}"` : ""
  const bg = background ? `  <rect width="${size}" height="${size}"${rx} fill="${background}"/>\n` : ""
  const aria = label ? ` role="img" aria-label="${label}"` : ' aria-hidden="true"'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"${aria}>\n` +
    bg +
    `  <g transform="translate(${round2(offset)} ${round2(offset)}) scale(${round2(scale)})">${markInner(color, geometry)}</g>\n` +
    `</svg>\n`
  )
}

/** A rectangle with the mark centred, sized to `ratio` of the shorter side (splash screens, cards). */
function stageSvg({ width, height, ratio, background = WHITE, geometry = LOGO_GEOMETRY, color = INK, extra = "" }) {
  const mark = Math.min(width, height) * ratio
  const scale = mark / geometry.size
  const x = (width - mark) / 2
  const y = (height - mark) / 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">\n` +
    `  <rect width="${width}" height="${height}" fill="${background}"/>\n` +
    `  <g transform="translate(${round2(x)} ${round2(y)}) scale(${round2(scale)})">${markInner(color, geometry)}</g>\n` +
    extra +
    `</svg>\n`
  )
}

/** Social card (1200×630): the mark above a bold «SiraGPT» wordmark, both in ink on white. */
function socialCardSvg({ width = 1200, height = 630 } = {}) {
  const mark = 250
  const scale = mark / LOGO_GEOMETRY.size
  const x = (width - mark) / 2
  const y = 128
  const fontFamily = "Liberation Sans, DejaVu Sans, Arial, Helvetica, sans-serif"
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="SiraGPT">\n` +
    `  <rect width="${width}" height="${height}" fill="${WHITE}"/>\n` +
    `  <g transform="translate(${round2(x)} ${round2(y)}) scale(${round2(scale)})">${markInner(INK)}</g>\n` +
    `  <text x="${width / 2}" y="552" text-anchor="middle" font-family="${fontFamily}" font-weight="700" font-size="104" letter-spacing="-2" fill="${INK}">SiraGPT</text>\n` +
    `</svg>\n`
  )
}

async function png(svg, { opaque = false, palette = false, level = 9 } = {}) {
  let image = sharp(Buffer.from(svg))
  if (opaque) image = image.flatten({ background: WHITE }).removeAlpha()
  else image = image.ensureAlpha()
  return image.png({ compressionLevel: level, palette, adaptiveFiltering: !palette }).toBuffer()
}

function write(rel, data) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, data)
  const size = fs.statSync(abs).size
  console.log(`  ${rel}  (${size} B)`)
}

/* ---------- ICO (Windows): BMP DIB entries for the small sizes, PNG for 256 ---------- */

async function bmpDibEntry(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const rowBytes = width * 4
  const maskRowBytes = Math.ceil(width / 32) * 4
  const buf = Buffer.alloc(40 + rowBytes * height + maskRowBytes * height)
  buf.writeUInt32LE(40, 0) // biSize
  buf.writeInt32LE(width, 4)
  buf.writeInt32LE(height * 2, 8) // XOR + AND masks
  buf.writeUInt16LE(1, 12) // planes
  buf.writeUInt16LE(32, 14) // bpp
  buf.writeUInt32LE(0, 16) // BI_RGB
  buf.writeUInt32LE(rowBytes * height + maskRowBytes * height, 20)
  for (let y = 0; y < height; y += 1) {
    const srcRow = height - 1 - y
    for (let x = 0; x < width; x += 1) {
      const s = (srcRow * width + x) * 4
      const d = 40 + y * rowBytes + x * 4
      buf[d] = data[s + 2] // B
      buf[d + 1] = data[s + 1] // G
      buf[d + 2] = data[s] // R
      buf[d + 3] = data[s + 3] // A
    }
  }
  const maskStart = 40 + rowBytes * height
  for (let y = 0; y < height; y += 1) {
    const srcRow = height - 1 - y
    for (let x = 0; x < width; x += 1) {
      if (data[(srcRow * width + x) * 4 + 3] === 0) {
        const byte = maskStart + y * maskRowBytes + (x >> 3)
        buf[byte] |= 0x80 >> (x & 7)
      }
    }
  }
  return { bytes: buf, width, height }
}

async function buildIco(entries) {
  // entries: [{ size, png, dib }] — dib true ⇒ store as BMP DIB, else PNG
  const dir = Buffer.alloc(6 + 16 * entries.length)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(entries.length, 4)
  const blobs = []
  let offset = dir.length
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    const blob = entry.dib ? (await bmpDibEntry(entry.png)).bytes : entry.png
    const e = 6 + 16 * i
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, e)
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, e + 1)
    dir.writeUInt8(0, e + 2)
    dir.writeUInt8(0, e + 3)
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(blob.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    blobs.push(blob)
    offset += blob.length
  }
  return Buffer.concat([dir, ...blobs])
}

/* ---------- ICNS (macOS): PNG payloads for every modern icon type ---------- */

const ICNS_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
]

function buildIcns(pngBySize) {
  const chunks = []
  for (const [type, size] of ICNS_TYPES) {
    const data = pngBySize.get(size)
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, "latin1")
    header.writeUInt32BE(data.length + 8, 4)
    chunks.push(header, data)
  }
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write("icns", 0, 4, "latin1")
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

/* ---------- surfaces ---------- */

const TILE_RADIUS = 96 / 512 // the PWA tile corner (icon.svg rx=96 on 512)

async function web() {
  console.log("web (public/)")
  write("public/brand/sira-mark.svg", siraMarkSvg({ title: "SiraGPT" }) + "\n")
  write("public/icon.svg", tileSvg({ size: 512, ratio: 0.68, radius: TILE_RADIUS }))
  for (const [rel, size] of [["public/sira-gpt-512.png", 512], ["public/sira-gpt.png", 512], ["public/sira-gpt-192.png", 192]]) {
    write(rel, await png(tileSvg({ size, ratio: 0.68, radius: TILE_RADIUS })))
  }
  // Apple touch icons: opaque, full-bleed. iOS composites transparent pixels on
  // black and applies its own continuous-curvature mask, so a rounded tile with
  // alpha would show black corners on the home screen.
  for (const rel of ["public/sira-gpt-180.png", "public/apple-touch-icon.png"]) {
    write(rel, await png(tileSvg({ size: 180, ratio: 0.68 }), { opaque: true }))
  }
  // Maskable: full-bleed white, the mark inside the 80 % safe zone.
  write("public/brand/sira-maskable-512.png", await png(tileSvg({ size: 512, ratio: 0.58 })))
  // Legacy favicon: 16/32/48 PNG-in-ICO with the small (heavier) geometry.
  const favicon = []
  for (const size of [16, 32, 48]) {
    favicon.push({ size, png: await png(tileSvg({ size, ratio: 0.78, radius: 0.2, geometry: LOGO_GEOMETRY_SMALL })) })
  }
  write("public/favicon.ico", await buildIco(favicon))
}

async function social() {
  console.log("social cards (public/)")
  const card = await png(socialCardSvg(), { opaque: false })
  write("public/opengraph-image.png", card)
  write("public/twitter-image.png", card)
}

async function android() {
  console.log("android (Capacitor res/)")
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
  for (const [density, factor] of Object.entries(densities)) {
    const launcher = Math.round(48 * factor)
    const foreground = Math.round(108 * factor)
    const dir = `android/app/src/main/res/mipmap-${density}`
    write(`${dir}/ic_launcher.png`, await png(tileSvg({ size: launcher, ratio: 0.68, radius: TILE_RADIUS })))
    write(`${dir}/ic_launcher_round.png`, await png(tileSvg({ size: launcher, ratio: 0.64, radius: 0.5 })))
    // Adaptive foreground: transparent, the mark inside the 66 dp safe circle (the mark's extent IS a circle).
    write(`${dir}/ic_launcher_foreground.png`, await png(tileSvg({ size: foreground, ratio: 0.58, background: null })))
  }
  // Google Play listing icon: 512², opaque, full-bleed (Play applies its own mask).
  write("docs/store-submission/assets/android/play-icon-512.png", await png(tileSvg({ size: 512, ratio: 0.68 }), { opaque: true }))
  const splash = {
    "drawable": [480, 320],
    "drawable-land-mdpi": [480, 320],
    "drawable-port-mdpi": [320, 480],
    "drawable-land-hdpi": [800, 480],
    "drawable-port-hdpi": [480, 800],
    "drawable-land-xhdpi": [1280, 720],
    "drawable-port-xhdpi": [720, 1280],
    "drawable-land-xxhdpi": [1600, 960],
    "drawable-port-xxhdpi": [960, 1600],
    "drawable-land-xxxhdpi": [1920, 1280],
    "drawable-port-xxxhdpi": [1280, 1920],
  }
  for (const [dir, [width, height]] of Object.entries(splash)) {
    write(`android/app/src/main/res/${dir}/splash.png`, await png(stageSvg({ width, height, ratio: 0.2 })))
  }
}

async function ios() {
  console.log("ios (Assets.xcassets)")
  // App Store icon: 1024², opaque, square (iOS applies the mask).
  write("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", await png(tileSvg({ size: 1024, ratio: 0.68 }), { opaque: true }))
  const splash = await png(stageSvg({ width: 2732, height: 2732, ratio: 0.2 }), { opaque: true })
  for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
    write(`ios/App/App/Assets.xcassets/Splash.imageset/${name}`, splash)
  }
}

async function desktop() {
  console.log("desktop (apps/desktop/assets)")
  const tiles = new Map()
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const geometry = size <= 32 ? LOGO_GEOMETRY_SMALL : LOGO_GEOMETRY
    tiles.set(size, await png(tileSvg({ size, ratio: 0.66, radius: 0.22, geometry })))
  }
  write("apps/desktop/assets/icon.png", tiles.get(512))
  write("apps/desktop/assets/icon.icns", buildIcns(tiles))
  write(
    "apps/desktop/assets/icon.ico",
    await buildIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: tiles.get(size), dib: size < 256 }))),
  )
}

async function extension() {
  console.log("extension (extension/icons)")
  for (const size of [16, 48, 128]) {
    const geometry = size <= 32 ? LOGO_GEOMETRY_SMALL : LOGO_GEOMETRY
    write(`extension/icons/icon-${size}.png`, await png(tileSvg({ size, ratio: 0.72, radius: 0.2, geometry })))
  }
}

const SURFACES = { web, social, android, ios, desktop, extension }

async function main() {
  const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice("--only=".length)
  const picked = only ? only.split(",").filter(Boolean) : Object.keys(SURFACES)
  for (const name of picked) {
    if (!SURFACES[name]) throw new Error(`unknown surface "${name}" (expected ${Object.keys(SURFACES).join(", ")})`)
  }
  for (const name of picked) await SURFACES[name]()
  if (picked.includes("desktop")) {
    console.log("windows appx tiles (from apps/desktop/assets/icon.png)")
    execFileSync(process.execPath, [path.join(__dirname, "generate-windows-appx-assets.js")], { stdio: "inherit" })
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

module.exports = { tileSvg, stageSvg, socialCardSvg, buildIco, buildIcns, markInner, SURFACES }
