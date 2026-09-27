/** Read a prior chat deliverable without turning a filename into a request to create one. */
export function isGeneratedArtifactReadRequest(prompt: string): boolean {
  const text = String(prompt || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").trim()
  if (!text || text.length > 4000) return false
  if (!/\b(?:acabas de (?:entregar|generar|crear)|entregaste|generaste|creaste|entregad\w*|generad\w*|de (?:tu |la )?respuesta anterior)\b/.test(text)) return false
  if (!/\b(?:sav|spss|xlsx|excel|docx|word|pptx?|powerpoint|pdf|csv)\b|\.(?:sav|xlsx|docx|pptx|pdf|csv)\b/.test(text)) return false
  if (!/\b(?:abre|abrir|lee|leer|revisa\w*|verifica\w*|comprueb\w*|compara\w*|contrasta\w*|diferenc\w*|analiza\w*|inspecciona\w*)\b/.test(text)) return false

  const changeVerbs = "(?:crea\\w*|genera\\w*|exporta\\w*|edita\\w*|modifi\\w*|cambi\\w*|reemplaza\\w*|sustitu\\w*|completa\\w*|corrige\\w*|actualiza\\w*|anade\\w*|agrega\\w*|elimina\\w*|borra\\w*|guarda\\w*|reescribe\\w*|inserta\\w*|altera\\w*)"
  const negatedChanges = new RegExp(`\\b(?:sin|no)\\s+(?:${changeVerbs}\\s+(?:ni|y)\\s+)*${changeVerbs}\\b`, "g")
  const requestedChanges = text.replace(negatedChanges, "")
  return !new RegExp(`\\b${changeVerbs}\\b`).test(requestedChanges)
}
