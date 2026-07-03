import { readFileSync, readdirSync, existsSync } from "fs"
import { join } from "path"

export interface AgentToolConfig {
  read: boolean
  write: boolean
  edit: boolean
  bash: boolean
  glob: boolean
  grep: boolean
  web_search: boolean
  web_fetch: boolean
  spawn_subagent: boolean
}

export interface AgentModelConfig {
  provider: string
  name: string
  temperature: number
  max_tokens: number
}

export interface AgentIntakeConfig {
  max_turns: number
}

export interface AgentDefinition {
  id: string
  name: string
  description: string
  version: string
  author: string
  enabled: boolean
  model: AgentModelConfig
  intake: AgentIntakeConfig
  tools: AgentToolConfig
  prompts: { system: string }
}

const AGENTS_DIR = join(process.cwd(), "agents")

function parseToml(raw: string): Record<string, unknown> {
  const result: Record<string, Record<string, unknown>> = {}
  let currentSection = ""
  let currentMultilineKey = ""
  let currentMultilineLines: string[] = []

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim()

    if (currentMultilineKey) {
      if (line === '"""') {
        const section = result[currentSection] || {}
        section[currentMultilineKey] = currentMultilineLines.join("\n").trim()
        result[currentSection] = section
        currentMultilineKey = ""
        currentMultilineLines = []
        continue
      }
      currentMultilineLines.push(rawLine)
      continue
    }

    if (!line || line.startsWith("#")) continue

    if (line.startsWith("[") && line.endsWith("]")) {
      currentSection = line.slice(1, -1)
      if (!result[currentSection]) result[currentSection] = {}
      continue
    }

    const eqIdx = line.indexOf("=")
    if (eqIdx === -1) continue

    const key = line.slice(0, eqIdx).trim()
    let value = line.slice(eqIdx + 1).trim()

    if (value === '"""') {
      currentMultilineKey = key
      currentMultilineLines = []
      continue
    }

    const section = result[currentSection] || {}
    if (value === "true") section[key] = true
    else if (value === "false") section[key] = false
    else if (/^\d+\.?\d*$/.test(value)) section[key] = Number(value)
    else if (value.startsWith('"') && value.endsWith('"'))
      section[key] = value.slice(1, -1)
    else section[key] = value
    result[currentSection] = section
  }

  return result
}

function parseAgentToml(filePath: string): AgentDefinition | null {
  try {
    const raw = readFileSync(filePath, "utf-8")
    const parsed = parseToml(raw)

    const agent = parsed.agent as Record<string, unknown>
    const model = parsed.model as Record<string, unknown>
    const intake = parsed.intake as Record<string, unknown>
    const tools = parsed.tools as Record<string, unknown>
    const prompts = parsed.prompts as Record<string, unknown>

    if (!agent || !model || !tools) return null

    return {
      id: String(agent.id || ""),
      name: String(agent.name || ""),
      description: String(agent.description || ""),
      version: String(agent.version || "1.0.0"),
      author: String(agent.author || ""),
      enabled: Boolean(agent.enabled ?? true),
      model: {
        provider: String(model.provider || "anthropic"),
        name: String(model.name || "claude-sonnet-4-20250514"),
        temperature: Number(model.temperature ?? 0.3),
        max_tokens: Number(model.max_tokens ?? 4096),
      },
      intake: { max_turns: Number(intake?.max_turns ?? 5) },
      tools: {
        read: Boolean(tools.read ?? false),
        write: Boolean(tools.write ?? false),
        edit: Boolean(tools.edit ?? false),
        bash: Boolean(tools.bash ?? false),
        glob: Boolean(tools.glob ?? false),
        grep: Boolean(tools.grep ?? false),
        web_search: Boolean(tools.web_search ?? false),
        web_fetch: Boolean(tools.web_fetch ?? false),
        spawn_subagent: Boolean(tools.spawn_subagent ?? false),
      },
      prompts: { system: String(prompts?.system || "") },
    }
  } catch {
    return null
  }
}

let registry: AgentDefinition[] = []
let loaded = false

export function loadRegistry(): AgentDefinition[] {
  if (!existsSync(AGENTS_DIR)) {
    console.warn("[agent-registry] agents/ directory not found at", AGENTS_DIR)
    return []
  }
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".toml"))
  const agents: AgentDefinition[] = []
  for (const file of files) {
    const def = parseAgentToml(join(AGENTS_DIR, file))
    if (def && def.enabled) agents.push(def)
  }
  registry = agents
  loaded = true
  console.log("[agent-registry] Loaded " + agents.length + " agents")
  return agents
}

export function reloadRegistry(): AgentDefinition[] {
  registry = []
  loaded = false
  return loadRegistry()
}

export function getAgents(): AgentDefinition[] {
  if (!loaded) loadRegistry()
  return registry
}

export function getAgent(id: string): AgentDefinition | undefined {
  if (!loaded) loadRegistry()
  return registry.find((a) => a.id === id)
}

export function agentToInfo(def: AgentDefinition) {
  const toolNames = Object.entries(def.tools)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    version: def.version,
    model: def.model.name,
    tools: toolNames,
  }
}