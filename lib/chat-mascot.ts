/**
 * Deterministic pixel mascot for each conversation.
 *
 * Same chat id → same creature for the life of the chat. Original
 * arcade-style sprites (not third-party characters), recolored from a
 * seeded palette so the sidebar reads like a row of unique pets.
 */

export const MASCOT_GRID = 12

export type ChatMascotPalette = {
  name: string
  /** outline, body, shade, highlight, eye, pupil, accent */
  colors: readonly [string, string, string, string, string, string, string]
}

export type ChatMascotSpec = {
  species: string
  palette: ChatMascotPalette
  pixels: number[][]
  flipped: boolean
}

const CHAR_TO_PIXEL: Record<string, number> = {
  ".": 0,
  "#": 1,
  o: 2,
  s: 3,
  h: 4,
  e: 5,
  p: 6,
  a: 7,
}

const SPRITE_ART: Record<string, string> = {
  wisp: `
............
...######...
..#oooooo#..
.#oepooepo#.
.#oooooooo#.
.#ohhhhhoo#.
.#oooooooo#.
.#oooooooo#.
.#o##oo##o#.
..#.#..#.#..
............
............
`,
  bug: `
............
.#........#.
..#......#..
.#.######.#.
.#oooooooo#.
#oepoooepo##
.#ossoosso#.
.#oooooooo#.
..##oooo##..
.#..#..#..#.
#..........#
............
`,
  cap: `
............
....####....
..##oooo##..
.#oooooooo#.
#oohhhhhooo#
#oooooooooo#
.#ssssssss#.
..#oooooo#..
...#eaae#...
...#p..p#...
....####....
............
`,
  ship: `
............
.....##.....
....#oo#....
...#ohho#...
..#oooooo#..
.#oepooepo#.
#oooooooooo#
.#sssoosss#.
..#.#..#.#..
.#........#.
............
............
`,
  bot: `
............
.....#.#....
.....#a#....
...######...
..#ohhhoo#..
..#epooep#..
..#oooooo#..
..#ssssss#..
..##oooo##..
.#.#....#.#.
.#.#....#.#.
............
`,
  blob: `
............
....####....
..##oooo##..
.#oepooepo#.
.#oooooooo#.
.#ohaaaaho#.
.#oooooooo#.
..#oooooo#..
...#s..s#...
....####....
............
............
`,
  sprout: `
............
.....#a.....
....#aa#....
...#a##a#...
....#..#....
...######...
..#oooooo#..
.#oepooepo#.
.#oooooooo#.
..#ssssss#..
...######...
............
`,
  fox: `
............
.#.#....#.#.
.##......##.
.#oooooooo#.
.#oepooepo#.
.#oooooooo#.
.#oohhhhoo#.
..#oaaaao#..
...#oooo#...
....#ss#....
.....##.....
............
`,
  owl: `
............
.#.#....#.#.
.##########.
.#oooooooo#.
#oe#oooe#o##
#op#ooop#o##
.#oooooooo#.
.#oohhhhoo#.
..#oaaaao#..
...#ssss#...
....####....
............
`,
  fish: `
............
......##....
.#...#oo#...
..#.#ohho#..
.#oepoooo#.#
#oooooooo#.#
.#ossoooo#.#
..#.#osso#..
.#...#oo#...
......##....
............
............
`,
  star: `
............
.....#......
....#o#.....
.#.#ooo#.#..
..#oohhoo#..
.#oepooepo#.
..#oooooo#..
.#.#osso#.#.
....#oo#....
.....#......
............
............
`,
  crab: `
............
#..........#
.#.#....#.#.
..##########
.#oepooepo#.
.#oooooooo#.
.#ohhhhhoo#.
.#o#oooo#o#.
#.#......#.#
............
............
............
`,
  bird: `
............
.....###....
...#ooooo#..
..#oepooo#..
.#ooooooo#..
.#oohhhaa#..
..#ooooaa#..
...#oss#....
..#.#..#.#..
.#........#.
............
............
`,
  cube: `
............
..########..
..#ohhhhho#.
..#ooooooo#.
..#e#ooo#e#.
..#p#ooo#p#.
..#ooooooo#.
..#sssssss#.
..########..
..##....##..
..##....##..
............
`,
  hopper: `
............
.#........#.
.#.#....#.#.
..##########
.#oepooepo#.
.#oooooooo#.
.#ohhhhhoo#.
..#oooooo#..
.#.#s..s#.#.
#..#....#..#
............
............
`,
  gem: `
............
.....##.....
...#oooo#...
..#ohhhho#..
.#oepooepo#.
.#oooooooo#.
..#osssoo#..
...#oooo#...
....#ss#....
.....##.....
............
............
`,
}

export const MASCOT_SPECIES = Object.keys(SPRITE_ART)

export const MASCOT_PALETTES: ChatMascotPalette[] = [
  { name: "snow", colors: ["#2A2A32", "#F4F1EA", "#D5D0C6", "#FFFFFF", "#FFFFFF", "#2A2A32", "#E8B4B8"] },
  { name: "grape", colors: ["#2A1840", "#8B5CF6", "#6D3FCF", "#C4B5FD", "#FFFFFF", "#1E1033", "#F0ABFC"] },
  { name: "sea", colors: ["#0F3D3A", "#2DD4BF", "#14B8A6", "#99F6E4", "#FFFFFF", "#134E4A", "#FDE68A"] },
  { name: "ember", colors: ["#4A1C0C", "#F97316", "#EA580C", "#FDBA74", "#FFFFFF", "#431407", "#FECACA"] },
  { name: "sky", colors: ["#0C2A4A", "#38BDF8", "#0284C7", "#BAE6FD", "#FFFFFF", "#0C4A6E", "#FDE68A"] },
  { name: "lime", colors: ["#14532D", "#4ADE80", "#22C55E", "#BBF7D0", "#FFFFFF", "#14532D", "#FDE68A"] },
  { name: "blush", colors: ["#4C1D3A", "#FB7185", "#E11D48", "#FECDD3", "#FFFFFF", "#4C0519", "#FDE68A"] },
  { name: "sun", colors: ["#422006", "#FACC15", "#EAB308", "#FEF08A", "#FFFFFF", "#422006", "#FB7185"] },
  { name: "orchid", colors: ["#3B0764", "#C084FC", "#A855F7", "#E9D5FF", "#FFFFFF", "#3B0764", "#F9A8D4"] },
  { name: "mint", colors: ["#064E3B", "#5EEAD4", "#2DD4BF", "#CCFBF1", "#FFFFFF", "#134E4A", "#FDE68A"] },
  { name: "coral", colors: ["#7F1D1D", "#FB7185", "#F43F5E", "#FECDD3", "#FFFFFF", "#4C0519", "#FDE68A"] },
  { name: "moss", colors: ["#1A2E05", "#65A30D", "#4D7C0F", "#D9F99D", "#FFFFFF", "#1A2E05", "#FDE68A"] },
]

function parseSprite(art: string, species: string): number[][] {
  const rows = art
    .trim()
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean)
  if (rows.length !== MASCOT_GRID) {
    throw new Error(`mascot ${species}: expected ${MASCOT_GRID} rows, got ${rows.length}`)
  }
  return rows.map((row) => {
    if (row.length !== MASCOT_GRID) {
      throw new Error(`mascot ${species}: expected ${MASCOT_GRID} cols, got ${row.length}`)
    }
    return Array.from(row, (ch) => {
      const value = CHAR_TO_PIXEL[ch]
      if (value === undefined) {
        throw new Error(`mascot ${species}: bad pixel '${ch}'`)
      }
      return value
    })
  })
}

const SPRITES: Record<string, number[][]> = Object.fromEntries(
  MASCOT_SPECIES.map((name) => [name, parseSprite(SPRITE_ART[name], name)]),
)

function hashSeed(seed: string): number {
  const input = `sira-mascot:v1:${seed}`
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function clonePixels(pixels: number[][]): number[][] {
  return pixels.map((row) => row.slice())
}

function flipPixels(pixels: number[][]): number[][] {
  return pixels.map((row) => row.slice().reverse())
}

const specCache = new Map<string, ChatMascotSpec>()

export function getChatMascot(seed: string): ChatMascotSpec {
  const key = String(seed || "sira")
  const cached = specCache.get(key)
  if (cached) return cached

  const hash = hashSeed(key)
  const species = MASCOT_SPECIES[hash % MASCOT_SPECIES.length]
  const palette = MASCOT_PALETTES[(hash >>> 8) % MASCOT_PALETTES.length]
  const flipped = ((hash >>> 20) & 1) === 1
  const base = SPRITES[species]
  const spec: ChatMascotSpec = {
    species,
    palette,
    pixels: flipped ? flipPixels(base) : clonePixels(base),
    flipped,
  }
  specCache.set(key, spec)
  return spec
}

export type MascotRect = {
  x: number
  y: number
  w: number
  h: number
  color: string
}

/** Merge same-color pixels into greedy axis-aligned rects for compact SVGs. */
export function mascotRects(spec: ChatMascotSpec): MascotRect[] {
  const { pixels, palette } = spec
  const seen = pixels.map((row) => row.map(() => false))
  const rects: MascotRect[] = []
  for (let y = 0; y < MASCOT_GRID; y += 1) {
    for (let x = 0; x < MASCOT_GRID; x += 1) {
      const value = pixels[y][x]
      if (!value || seen[y][x]) continue
      let width = 1
      while (x + width < MASCOT_GRID && pixels[y][x + width] === value && !seen[y][x + width]) {
        width += 1
      }
      let height = 1
      grow: while (y + height < MASCOT_GRID) {
        for (let dx = 0; dx < width; dx += 1) {
          if (pixels[y + height][x + dx] !== value || seen[y + height][x + dx]) break grow
        }
        height += 1
      }
      for (let dy = 0; dy < height; dy += 1) {
        for (let dx = 0; dx < width; dx += 1) {
          seen[y + dy][x + dx] = true
        }
      }
      rects.push({
        x,
        y,
        w: width,
        h: height,
        color: palette.colors[value - 1],
      })
    }
  }
  return rects
}
