/**
 * Human-readable schedule strings for the Empresas Rutinas block.
 * Always 24-hour clock, locale es-PE. Accepts crontab or English leftovers.
 */

const WEEKDAY_LABELS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

function formatClock(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`
}

function parseField(token: string, min: number, max: number): number[] | "any" {
  const raw = String(token || "").trim()
  if (!raw || raw === "*") return "any"
  const values = new Set<number>()
  for (const part of raw.split(",")) {
    const [range, stepRaw] = part.split("/")
    const step = stepRaw ? Number(stepRaw) : 1
    if (!Number.isInteger(step) || step <= 0) continue
    if (range === "*") {
      for (let value = min; value <= max; value += step) values.add(value)
      continue
    }
    if (range.includes("-")) {
      const [fromRaw, toRaw] = range.split("-")
      const from = Number(fromRaw)
      const to = Number(toRaw)
      if (!Number.isInteger(from) || !Number.isInteger(to)) continue
      for (let value = from; value <= to; value += step) {
        if (value >= min && value <= max) values.add(value)
      }
      continue
    }
    const single = Number(range)
    if (Number.isInteger(single) && single >= min && single <= max) values.add(single)
  }
  return [...values].sort((a, b) => a - b)
}

function joinClocks(hours: number[], minute: number): string {
  const clocks = hours.map((hour) => formatClock(hour, minute))
  if (clocks.length === 1) return clocks[0]
  if (clocks.length === 2) return `${clocks[0]} y ${clocks[1]}`
  return `${clocks.slice(0, -1).join(", ")} y ${clocks[clocks.length - 1]}`
}

function weekdayPhrase(days: number[] | "any"): string | null {
  if (days === "any") return null
  const normalized = [...new Set(days.map((day) => (day === 7 ? 0 : day)))].sort((a, b) => a - b)
  if (normalized.length === 5 && normalized.join(",") === "1,2,3,4,5") return "Lunes a viernes"
  if (normalized.length === 2 && normalized.join(",") === "0,6") return "Fines de semana"
  if (normalized.length === 1) {
    const label = WEEKDAY_LABELS[normalized[0]] || "día"
    return label.charAt(0).toUpperCase() + label.slice(1)
  }
  const labels = normalized.map((day) => WEEKDAY_LABELS[day] || "día")
  return labels.map((label, index) => (index === 0 ? label.charAt(0).toUpperCase() + label.slice(1) : label)).join(", ")
}

function looksLikeCronField(token: string): boolean {
  return /^(\*|\d+)(-\d+)?(\/\d+)?(,\d+(-\d+)?(\/\d+)?)*$/.test(token)
}

function fromCron(expr: string): string | null {
  const tokens = expr.trim().split(/\s+/)
  if (tokens.length !== 5 || !tokens.every(looksLikeCronField)) return null
  const minutes = parseField(tokens[0], 0, 59)
  const hours = parseField(tokens[1], 0, 23)
  const dow = parseField(tokens[4], 0, 7)
  const minute = minutes === "any" ? 0 : minutes[0] ?? 0

  const hourStep = /^(\*|\d+-\d+)\/(\d+)$/.exec(tokens[1])
  if (hourStep) {
    const step = Number(hourStep[2])
    if (Number.isInteger(step) && step > 0) {
      return `Cada ${step} horas a las ${formatClock(0, minute)}`
    }
  }

  if (hours !== "any" && hours.length > 0) {
    const clocks = joinClocks(hours, minute)
    const days = weekdayPhrase(dow)
    if (days) return `${days} a las ${clocks}`
    return `Todos los días a las ${clocks}`
  }

  if (tokens[1] === "*" && minutes !== "any" && minutes.length === 1) {
    return `Cada hora a las :${pad2(minute)}`
  }

  return null
}

function fromEnglish(text: string): string | null {
  const everyHours = /every\s+(\d+)\s+hours?(?:\s+at\s+:?(\d{1,2}))?/i.exec(text)
  if (everyHours) {
    const step = Number(everyHours[1])
    const minute = everyHours[2] ? Number(everyHours[2]) : 0
    return `Cada ${step} horas a las ${formatClock(0, minute)}`
  }

  const weekday = /weekdays?\s+at\s+(.+)/i.exec(text)
  if (weekday) {
    const clocks = [...weekday[1].matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi)].map((match) => {
      let hour = Number(match[1])
      const minute = match[2] ? Number(match[2]) : 0
      const meridiem = match[3].toLowerCase()
      if (meridiem === "pm" && hour < 12) hour += 12
      if (meridiem === "am" && hour === 12) hour = 0
      return formatClock(hour, minute)
    })
    if (clocks.length === 1) return `Lunes a viernes a las ${clocks[0]}`
    if (clocks.length >= 2) return `Lunes a viernes a las ${clocks[0]} y ${clocks[1]}`
  }

  return null
}

export function formatScheduleEsPE(input: string | null | undefined): string {
  const text = String(input || "").trim()
  if (!text) return "Programada"
  if (/[áéíóúñ]/i.test(text) && /cada|lunes|todos los días|fines de semana/i.test(text)) {
    return text
  }
  return fromCron(text) || fromEnglish(text) || text
}

export const DEFAULT_EMPRESAS_ROUTINES = [
  {
    id: "mejora-constante",
    title: "Mejora constante chat y code",
    cronExpr: "57 */3 * * *",
  },
  {
    id: "avisar-tiendas",
    title: "Avisar tiendas iPhone y Android",
    cronExpr: "32 9,15 * * 1-5",
  },
] as const
