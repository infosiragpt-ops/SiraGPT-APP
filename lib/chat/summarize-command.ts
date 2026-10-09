/** Slash summary is a normal turn, retaining files, model, queue and Stop. */
export function summarizeCommandPrompt(
  remainder: string,
  attachmentCount: number,
  messages: Array<{ role?: string; content?: string }> = [],
): string | null {
  const instruction = remainder.trim()
  if (attachmentCount > 0) {
    return `Resume los documentos adjuntos en español con las ideas principales y las conclusiones. Entrega el resumen aquí en el chat, sin crear ni modificar archivos.${instruction ? `\nIndicaciones: ${instruction}` : ""}`
  }
  const target = [...messages].reverse().find(message =>
    ["ASSISTANT", "USER"].includes(String(message.role || "").toUpperCase())
    && String(message.content || "").trim()
    && !/^\s*(?:```agent-task-state|\[[A-Z_]+\])/.test(String(message.content)),
  )
  if (!target?.content) return null
  return `Resume el siguiente mensaje en español con sus ideas principales. Entrega el resumen aquí en el chat, sin crear ni modificar archivos.${instruction ? `\nIndicaciones: ${instruction}` : ""}\n\nMensaje a resumir:\n${target.content}`
}
