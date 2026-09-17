#!/usr/bin/env node
/**
 * Writes the 19 LOADERS CELESTE v2 SVGs under public/loaders/.
 *
 * Shared bounce (all except completado / error) — Luis kit, exact:
 *   <rect x="20|30|40" y="32" width="4" height="10" fill="#38BDF8">
 *     <animateTransform ... values="0 0; 0 20; 0 0" begin="0|0.2s|0.4s" dur="0.6s"/>
 *   </rect>
 *
 * pensando.svg            = ONLY the three bouncing rects (no top icon)
 * pensando-original.svg   = Luis original crop (viewBox 10 40 45 50, bars at y=50)
 * Other in-progress files = static top icon (above y≈24) + the same three bars
 * completado / error      = animated check / X, no bars
 */
const fs = require("fs")
const path = require("path")

const CELESTE = "#38BDF8"
const DANGER = "#F87171"
const OUT = path.join(__dirname, "..", "public", "loaders")
const ICONS_OUT = path.join(OUT, "icons")

const BOUNCE = (y, begin) =>
  `<rect x="${begin === "0" ? 20 : begin === "0.2s" ? 30 : 40}" y="${y}" width="4" height="10" fill="${CELESTE}">
  <animateTransform attributeType="xml" attributeName="transform" type="translate" values="0 0; 0 20; 0 0" begin="${begin}" dur="0.6s" repeatCount="indefinite"/>
</rect>`

const BARS_Y32 = ["0", "0.2s", "0.4s"].map((b) => BOUNCE(32, b)).join("\n")
const BARS_Y50 = ["0", "0.2s", "0.4s"].map((b) => BOUNCE(50, b)).join("\n")
const BARS_STATIC = `<rect x="20" y="32" width="4" height="10" fill="${CELESTE}"/>
<rect x="30" y="32" width="4" height="10" fill="${CELESTE}"/>
<rect x="40" y="32" width="4" height="10" fill="${CELESTE}"/>`
const BARS_STATIC_Y50 = `<rect x="20" y="50" width="4" height="10" fill="${CELESTE}"/>
<rect x="30" y="50" width="4" height="10" fill="${CELESTE}"/>
<rect x="40" y="50" width="4" height="10" fill="${CELESTE}"/>`

function wrap(state, body, viewBox = "0 0 64 64") {
  const label = state.replace(/-/g, " ")
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="64" height="64" fill="none" color="${CELESTE}" role="img" aria-label="${label}">
  <title>SiraGPT loader · ${label}</title>
${body}
</svg>
`
}

function seal(letters, fontSize) {
  const size = fontSize || (letters.length > 1 ? 7.2 : 12)
  const baseline = letters.length > 1 ? 15.4 : 16.8
  return `  <rect x="22" y="2.5" width="20" height="20" rx="4.5" fill="${CELESTE}"/>
  <text x="32" y="${baseline}" text-anchor="middle" fill="#ffffff" font-family="Arial,Helvetica,sans-serif" font-size="${size}" font-weight="700">${letters}</text>`
}

const ICONS = {
  "buscando-internet": `  <g fill="none" stroke="${CELESTE}" stroke-width="2" stroke-linecap="round">
    <circle cx="30" cy="11" r="6.5"/>
    <path d="M35 16.2 41 22"/>
  </g>`,
  "generando-codigo": `  <g fill="none" stroke="${CELESTE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M26 6 20 13 26 20"/>
    <path d="M38 6 44 13 38 20"/>
    <path d="M35 5.5 29 20.5"/>
  </g>`,
  "generando-word": seal("W", 12),
  "generando-pdf": seal("PDF", 7),
  "generando-ppt": seal("P", 12),
  "generando-excel": seal("X", 12),
  "generando-imagen": `  <g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="21" y="4" width="22" height="17" rx="2.2"/>
    <circle cx="27.4" cy="9.2" r="1.5" fill="${CELESTE}" stroke="none"/>
    <path d="M22.6 17.2 28 11.6l3.2 3.2 2.6-2.8 6.2 5.2"/>
  </g>`,
  "generando-audio": `  <g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M24 10.5v5.2h4.2L34 21V5.2l-5.8 5.3H24z"/>
    <path d="M37.2 9.2a5.4 5.4 0 0 1 0 7.6"/>
    <path d="M40.4 6.4a9.2 9.2 0 0 1 0 13.2"/>
  </g>`,
  "generando-video": `  <g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linejoin="round">
    <rect x="20.5" y="5" width="23" height="16" rx="2.4"/>
    <path d="M29 9.6 36.4 13 29 16.4z" fill="${CELESTE}" stroke="none"/>
  </g>`,
  "analizando-archivo": `  <g fill="none" stroke="${CELESTE}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 3.5h10L38 9.2V21H22z"/>
    <path d="M32 3.6v5.6H38"/>
    <circle cx="37.2" cy="18.2" r="4"/>
    <path d="M40.1 21.2 43.4 24.4"/>
  </g>`,
  "subiendo-archivo": `  <g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 5h10.5L39 11.6V22H22z"/>
    <path d="M32.5 5.1v6.5H39"/>
    <path d="M30.5 19.2V12.8M27.4 15.4 30.5 12.2 33.6 15.4"/>
  </g>`,
  "descargando-archivo": `  <g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 3.5h10.5L39 10.1V20.5H22z"/>
    <path d="M32.5 3.6v6.5H39"/>
    <path d="M30.5 11.4v6.4M27.4 14.6 30.5 17.8 33.6 14.6"/>
  </g>`,
  "enviando-correo": `  <g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="20.5" y="6" width="23" height="14.5" rx="2"/>
    <path d="M21.4 7.6 32 15.2 42.6 7.6"/>
  </g>`,
  "procesando-datos": `  <g fill="none" stroke="${CELESTE}" stroke-width="1.6" stroke-linecap="round">
    <ellipse cx="32" cy="6.6" rx="10" ry="3"/>
    <path d="M22 6.6v5.2c0 1.7 4.5 3 10 3s10-1.3 10-3V6.6"/>
    <path d="M22 11.8v5.2c0 1.7 4.5 3 10 3s10-1.3 10-3v-5.2"/>
  </g>`,
  "cargando-general": `  <g fill="none" stroke="${CELESTE}" stroke-width="1.8" stroke-linecap="round">
    <circle cx="32" cy="13" r="8.2" opacity="0.28"/>
    <path d="M32 4.8a8.2 8.2 0 0 1 8.2 8.2"/>
  </g>`,
}

const COMPLETADO = `  <g fill="none" stroke="${CELESTE}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="32" cy="32" r="16" stroke-dasharray="101" stroke-dashoffset="101">
      <animate attributeName="stroke-dashoffset" from="101" to="0" dur="0.45s" fill="freeze"/>
    </circle>
    <path d="M22 33 29 40 44 24" stroke-dasharray="36" stroke-dashoffset="36">
      <animate attributeName="stroke-dashoffset" from="36" to="0" begin="0.2s" dur="0.35s" fill="freeze"/>
    </path>
  </g>`

const COMPLETADO_STATIC = `  <g fill="none" stroke="${CELESTE}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="32" cy="32" r="16"/>
    <path d="M22 33 29 40 44 24"/>
  </g>`

const ERROR = `  <g fill="none" stroke="${DANGER}" stroke-width="3" stroke-linecap="round">
    <circle cx="32" cy="32" r="16" stroke-dasharray="101" stroke-dashoffset="101">
      <animate attributeName="stroke-dashoffset" from="101" to="0" dur="0.35s" fill="freeze"/>
    </circle>
    <path d="M24 24 40 40" stroke-dasharray="23" stroke-dashoffset="23">
      <animate attributeName="stroke-dashoffset" from="23" to="0" begin="0.2s" dur="0.25s" fill="freeze"/>
    </path>
    <path d="M40 24 24 40" stroke-dasharray="23" stroke-dashoffset="23">
      <animate attributeName="stroke-dashoffset" from="23" to="0" begin="0.32s" dur="0.25s" fill="freeze"/>
    </path>
  </g>`

const ERROR_STATIC = `  <g fill="none" stroke="${DANGER}" stroke-width="3" stroke-linecap="round">
    <circle cx="32" cy="32" r="16"/>
    <path d="M24 24 40 40M40 24 24 40"/>
  </g>`

const KIT = [
  { state: "pensando", body: BARS_Y32, icon: BARS_STATIC_Y50, iconViewBox: "10 40 45 50" },
  { state: "pensando-original", body: BARS_Y50, icon: BARS_STATIC_Y50, viewBox: "10 40 45 50", iconViewBox: "10 40 45 50" },
  ...Object.keys(ICONS).map((state) => ({
    state,
    body: `${ICONS[state]}\n${BARS_Y32}`,
    icon: `${ICONS[state]}\n${BARS_STATIC}`,
  })),
  { state: "completado", body: COMPLETADO, icon: COMPLETADO_STATIC },
  { state: "error", body: ERROR, icon: ERROR_STATIC },
]

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(ICONS_OUT, { recursive: true })

for (const file of fs.readdirSync(OUT)) {
  if (file.endsWith(".svg")) fs.unlinkSync(path.join(OUT, file))
}
for (const file of fs.readdirSync(ICONS_OUT)) {
  if (file.endsWith(".svg")) fs.unlinkSync(path.join(ICONS_OUT, file))
}

for (const item of KIT) {
  fs.writeFileSync(path.join(OUT, `${item.state}.svg`), wrap(item.state, item.body, item.viewBox))
  if (item.icon != null) {
    fs.writeFileSync(path.join(ICONS_OUT, `${item.state}.svg`), wrap(item.state, item.icon, item.iconViewBox || "0 0 64 64"))
  }
}

if (KIT.length !== 19) {
  throw new Error(`expected 19 kit SVGs, got ${KIT.length}`)
}

console.log(`wrote ${KIT.length} loaders → ${OUT}`)
console.log(KIT.map((k) => k.state).join("\n"))
