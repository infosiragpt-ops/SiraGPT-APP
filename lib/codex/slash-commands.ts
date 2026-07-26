export interface CodexSlashCommand {
  name: string
  description: string
  expand: (args: string) => string
}

const commands: CodexSlashCommand[] = [
  {
    name: "test",
    description: "Ejecuta tests, lint, tipos y browser check; corrige fallos reales.",
    expand: (args) => [
      "COMANDO /test:",
      "Valida el workspace actual de extremo a extremo.",
      "Ejecuta los tests y lint definidos por el proyecto, type_check, dev_server_check y browser_check.",
      "Corrige los fallos atribuibles al código y repite los gates hasta que pasen o exista un bloqueo externo demostrado.",
      args ? `Alcance adicional: ${args}` : "",
    ].filter(Boolean).join("\n"),
  },
  {
    name: "review",
    description: "Revisa el diff como QA y corrige defectos verificables.",
    expand: (args) => [
      "COMANDO /review:",
      "Revisa el diff y el estado actual como un revisor senior.",
      "Prioriza bugs, regresiones, seguridad, datos, accesibilidad y pruebas faltantes.",
      "Aplica correcciones seguras, ejecuta los gates pertinentes y entrega evidencia.",
      args ? `Foco solicitado: ${args}` : "",
    ].filter(Boolean).join("\n"),
  },
  {
    name: "deploy",
    description: "Prepara una release verificable desde el último checkpoint verde.",
    expand: (args) => [
      "COMANDO /deploy:",
      "Prepara la publicación desde el último checkpoint verde.",
      "Primero ejecuta tests, lint, type_check, dev_server_check y browser_check.",
      "No publiques si algún gate falla. Si todo pasa, crea la release/promoción y devuelve URL, checkpoint y evidencia de salud.",
      args ? `Destino o notas: ${args}` : "",
    ].filter(Boolean).join("\n"),
  },
]

export const CODEX_SLASH_COMMANDS = Object.freeze(commands)

export function expandCodexSlashCommand(input: string): {
  prompt: string
  command: CodexSlashCommand | null
  args: string
} {
  const source = String(input || "").trim()
  const match = source.match(/^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i)
  if (!match) return { prompt: source, command: null, args: "" }
  const name = match[1].toLowerCase()
  const args = String(match[2] || "").trim()
  const command = commands.find((row) => row.name === name) || null
  if (!command) return { prompt: source, command: null, args }
  return { prompt: command.expand(args), command, args }
}
