/** Same-chat SAV/XLSX comparison; do not hijack other document workflows. */
export function isGeneratedArtifactReadRequest(prompt: string): boolean {
  const text = String(prompt || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").trim()
  if (!text || text.length > 4000) return false
  const priorDelivery = /\b(?:acabas de (?:entregar|generar|crear)|entregaste|generaste|creaste|entregad\w*|generad\w*|cread\w*|de (?:tu |la )?respuesta anterior)\b/g
  if (!text.match(priorDelivery)) return false
  if (!/\b(?:sav|spss)\b|\.sav\b/.test(text) || !/\b(?:xlsx|excel)\b|\.xlsx\b/.test(text)) return false
  if (/\b(?:word|docx|pptx?|powerpoint|pdf|csv)\b|\.(?:docx|pptx|pdf|csv)\b/.test(text)) return false
  if (!/\b(?:abre|abrir|lee|leer|revisa\w*|verifica\w*|comprueb\w*|compara\w*|contrasta\w*|diferenc\w*|analiza\w*|inspecciona\w*)\b/.test(text)) return false

  const changeVerbs = "(?:crea\\w*|genera\\w*|exporta\\w*|haz|hacer|haga\\w*|conviert\\w*|converti\\w*|prepara\\w*|transforma\\w*|edita\\w*|modifi\\w*|cambi\\w*|reemplaza\\w*|sustitu\\w*|completa\\w*|corrige\\w*|actualiza\\w*|anade\\w*|agrega\\w*|elimina\\w*|borra\\w*|guarda\\w*|reescribe\\w*|inserta\\w*|altera\\w*)"
  const negatedChanges = new RegExp(`\\b(?:sin|no)\\s+(?:${changeVerbs}\\s+(?:ni|y)\\s+)*${changeVerbs}\\b`, "g")
  // «que acabas de generar» names the previous delivery; only another
  // unnegated creation/edit verb outside that reference is a new command.
  const requestedChanges = text.replace(priorDelivery, "").replace(negatedChanges, "")
  return !new RegExp(`\\b${changeVerbs}\\b`).test(requestedChanges)
}
