// code-chat-blocker — detect an out-of-credits / quota error that came back as
// assistant text in the /code chat, so the UI can surface a high-visibility
// blocker panel instead of plain prose. Conservative: requires explicit credit
// phrasing so a normal mention of "créditos" doesn't trip it.

export type ChatBlocker = { title: string; url?: string }

const CREDIT_PHRASING =
  /insufficient credits|insufficient_quota|out of credits|sin cr[eé]ditos|can only afford|quota exceeded|cuota agotada|l[ií]mite de cr[eé]ditos/i

const inflightGenerate = new Set<string>()

export function beginCodeGenerate(id: string): boolean {
  const key = String(id || "").trim()
  if (!key) return false
  if (inflightGenerate.has(key)) return false
  inflightGenerate.add(key)
  return true
}

export function endCodeGenerate(id: string): void {
  inflightGenerate.delete(String(id || "").trim())
}

export function detectBlocker(content: string): ChatBlocker | null {
  const t = content || ""
  if (!CREDIT_PHRASING.test(t)) return null
  if (/\b402\b/.test(t) || /credits_exhausted|insufficient credits|sin cr[eé]ditos/i.test(t)) {
    return { title: "Créditos agotados", url: "/settings" }
  }
  return { title: "Créditos o cuota agotada", url: "/settings" }
}
