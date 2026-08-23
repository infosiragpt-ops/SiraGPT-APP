#!/usr/bin/env node
/**
 * Writes the 19 LOADERS CELESTE v2 SVGs under public/loaders/.
 * Bars: 4×10, bounce 20px, dur 0.6s, delays 0 / 0.2 / 0.4s, #38BDF8.
 * Terminal states (completado / error) omit the bouncing bars.
 */
const fs = require("fs")
const path = require("path")

const CELESTE = "#38BDF8"
const SUCCESS = "#34D399"
const DANGER = "#F87171"
const OUT = path.join(__dirname, "..", "public", "loaders")
const ICONS_OUT = path.join(OUT, "icons")

const BARS = `
  <g class="celeste-bars" transform="translate(18 40)" fill="${CELESTE}">
    <rect x="0" y="0" width="4" height="10" rx="2">
      <animateTransform attributeType="xml" attributeName="transform" type="translate" values="0 0; 0 -20; 0 0" begin="0s" dur="0.6s" repeatCount="indefinite"/>
    </rect>
    <rect x="10" y="0" width="4" height="10" rx="2">
      <animateTransform attributeType="xml" attributeName="transform" type="translate" values="0 0; 0 -20; 0 0" begin="0.2s" dur="0.6s" repeatCount="indefinite"/>
    </rect>
    <rect x="20" y="0" width="4" height="10" rx="2">
      <animateTransform attributeType="xml" attributeName="transform" type="translate" values="0 0; 0 -20; 0 0" begin="0.4s" dur="0.6s" repeatCount="indefinite"/>
    </rect>
  </g>`

const ICONS = {
  pensando: `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 8.5h24a6 6 0 0 1 6 6v10a6 6 0 0 1-6 6H32l-6 5.5v-5.5h-6a6 6 0 0 1-6-6v-10a6 6 0 0 1 6-6z"/>
    <circle cx="28" cy="19.5" r="1.15" fill="${CELESTE}" stroke="none"/>
    <circle cx="32" cy="19.5" r="1.15" fill="${CELESTE}" stroke="none"/>
    <circle cx="36" cy="19.5" r="1.15" fill="${CELESTE}" stroke="none"/>
  </g>`,
  "buscando-internet": `<g fill="none" stroke="${CELESTE}" stroke-width="1.8" stroke-linecap="round">
    <circle cx="30" cy="20" r="8.2"/>
    <path d="M36.2 26.4 42 32.4"/>
  </g>`,
  "generando-codigo": `<g fill="none" stroke="${CELESTE}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M26 14 20 20.5 26 27"/>
    <path d="M38 14 44 20.5 38 27"/>
    <path d="M34 13.5 30 28.5"/>
  </g>`,
  "generando-word": `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M24 10.5h12.5L44 18v16.5H24z"/>
    <path d="M36.5 10.6v7.4H44"/>
    <path d="M28.2 22.2 30.4 30h1.6l1.5-5.2 1.5 5.2h1.6l2.2-7.8" stroke-width="1.5"/>
  </g>`,
  "generando-pdf": `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M24 10.5h12.5L44 18v16.5H24z"/>
    <path d="M36.5 10.6v7.4H44"/>
    <path d="M28 25.5h4.2a2.1 2.1 0 0 0 0-4.2H28v8h1.6" stroke-width="1.5"/>
    <path d="M35.2 21.4v8M35.2 21.4h3.1a2 2 0 0 1 0 4h-3.1" stroke-width="1.5"/>
  </g>`,
  "generando-ppt": `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="22" y="16" width="22" height="15" rx="2"/>
    <path d="M25 16V13.5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2V16"/>
    <path d="M29 21.5h8M29 25.5h5.5"/>
  </g>`,
  "generando-excel": `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="21" y="12" width="22" height="18" rx="2"/>
    <path d="M21 18h22M21 24h22M28.2 12v18M36 12v18"/>
  </g>`,
  "generando-imagen": `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="21" y="12" width="22" height="17" rx="2.2"/>
    <circle cx="27.4" cy="17.6" r="1.6" fill="${CELESTE}" stroke="none"/>
    <path d="M22.6 25.4 28.2 19.6l3.4 3.5 2.8-3.1 5.6 5.4"/>
  </g>`,
  "generando-audio": `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M24 18.5v5.2h4.2L34 29V13.2l-5.8 5.3H24z"/>
    <path d="M37.2 17.2a5.4 5.4 0 0 1 0 7.6"/>
    <path d="M40.4 14.4a9.2 9.2 0 0 1 0 13.2"/>
  </g>`,
  "generando-video": `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="20.5" y="13" width="23" height="16" rx="2.4"/>
    <path d="M29 17.6 36.4 21 29 24.4z" fill="${CELESTE}" stroke="none"/>
  </g>`,
  "analizando-archivo": `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M23 11h11.5L41 17.8V31H23z"/>
    <path d="M34.5 11.1v6.7H41"/>
    <circle cx="38.6" cy="29.6" r="5.1"/>
    <path d="M42.2 33.4 45.4 36.6"/>
  </g>`,
  "subiendo-archivo": `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M23 14h11.5L41 20.8V33H23z"/>
    <path d="M34.5 14.1v6.7H41"/>
    <path d="M32 29.2V22.4M28.6 25.2 32 21.8 35.4 25.2"/>
  </g>`,
  "descargando-archivo": `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M23 11h11.5L41 17.8V30H23z"/>
    <path d="M34.5 11.1v6.7H41"/>
    <path d="M32 20.6v6.8M28.6 24.6 32 28 35.4 24.6"/>
  </g>`,
  "enviando-correo": `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="20.5" y="14" width="23" height="14.5" rx="2"/>
    <path d="M21.4 15.6 32 23.2 42.6 15.6"/>
  </g>`,
  "procesando-datos": `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round">
    <ellipse cx="32" cy="13.4" rx="10" ry="3.2"/>
    <path d="M22 13.4v5.6c0 1.8 4.5 3.2 10 3.2s10-1.4 10-3.2V13.4"/>
    <path d="M22 19v5.6c0 1.8 4.5 3.2 10 3.2s10-1.4 10-3.2V19"/>
  </g>`,
  "cargando-general": `<g fill="none" stroke="${CELESTE}" stroke-width="1.7" stroke-linecap="round">
    <circle cx="32" cy="21" r="8.4" opacity="0.28"/>
    <path d="M32 12.6a8.4 8.4 0 0 1 8.4 8.4"/>
  </g>`,
  puntitos: "",
  completado: `<g fill="none" stroke="${SUCCESS}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="32" cy="28" r="12"/>
    <path d="M25.6 28.2 29.8 32.4 39 22.8"/>
  </g>`,
  error: `<g fill="none" stroke="${DANGER}" stroke-width="1.9" stroke-linecap="round">
    <circle cx="32" cy="28" r="12"/>
    <path d="M27.2 23.2 36.8 32.8M36.8 23.2 27.2 32.8"/>
  </g>`,
}

function wrap(state, icon, bars) {
  const label = state.replace(/-/g, " ")
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" fill="none" role="img" aria-label="${label}">
  <title>SiraGPT loader · ${label}</title>
  ${icon}
  ${bars}
</svg>
`
}

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(ICONS_OUT, { recursive: true })
for (const [state, icon] of Object.entries(ICONS)) {
  const bars = state === "completado" || state === "error" ? "" : BARS
  fs.writeFileSync(path.join(OUT, `${state}.svg`), wrap(state, icon, bars))
  fs.writeFileSync(path.join(ICONS_OUT, `${state}.svg`), wrap(state, icon, ""))
}
console.log(`wrote ${Object.keys(ICONS).length} loaders + icons → ${OUT}`)
