/**
 * Workspace tools registry — the catalog behind the /code "Herramientas"
 * launcher (Replit-style tool dock). One source of truth for the tool
 * metadata; the launcher renders sections from here and the tool screen
 * renders one tool at a time.
 *
 * status:   "ready" → wired to real behavior
 * behavior: "screen" → opens the single active tool screen ·
 *           "action" → runs an inline action and closes the launcher
 */

import {
  BarChart3,
  Bot,
  Cable,
  CheckCircle2,
  Database,
  FilePlus2,
  FolderTree,
  GitBranch,
  HardDrive,
  KeyRound,
  Monitor,
  MonitorSmartphone,
  PenTool,
  Rocket,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Terminal,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react"

export type ToolStatus = "ready"
export type ToolBehavior = "screen" | "action"
/** Honest catalog badge. `status` stays "ready" for the existing type. */
export type ToolReadiness = "live" | "pronto"

export type WorkspaceToolId =
  | "agent"
  | "preview"
  | "shell"
  | "console"
  | "files"
  | "new-file"
  | "code-search"
  | "publishing"
  | "integrations"
  | "database"
  | "storage"
  | "auth"
  | "security"
  | "secrets"
  | "skills"
  | "analytics"
  | "automations"
  | "canvas"
  | "settings"
  | "validation"
  | "developer"
  | "git"
  | "vnc"
  | "workflows"

export type WorkspaceTool = {
  id: WorkspaceToolId
  label: string
  description: string
  keywords: string
  icon: LucideIcon
  status: ToolStatus
  /** Omitted = live. Use "pronto" for stub tools in the catalog. */
  readiness?: ToolReadiness
  behavior: ToolBehavior
}

export function toolReadiness(tool: Pick<WorkspaceTool, "readiness">): ToolReadiness {
  return tool.readiness ?? "live"
}

export const WORKSPACE_TOOLS: Record<WorkspaceToolId, WorkspaceTool> = {
  agent: {
    id: "agent",
    label: "Agent",
    description: "Chat de construcción y edición del workspace",
    keywords: "agent chat builder assistant construccion edicion workspace",
    icon: Bot,
    status: "ready",
    behavior: "action",
  },
  preview: {
    id: "preview",
    label: "Preview",
    description: "Vista previa de la app en el navegador",
    keywords: "preview browser navegador app vista previa",
    icon: Monitor,
    status: "ready",
    behavior: "screen",
  },
  shell: {
    id: "shell",
    label: "Shell",
    description: "Terminal integrada (CLI del workspace)",
    keywords: "shell terminal cli comandos workspace bash",
    icon: Terminal,
    status: "ready",
    behavior: "screen",
  },
  console: {
    id: "console",
    label: "Console",
    description: "Salida de logs al ejecutar código",
    keywords: "console logs output salida runtime workflow run",
    icon: SquareTerminal,
    status: "ready",
    behavior: "screen",
  },
  files: {
    id: "files",
    label: "Files",
    description: "Explora y abre los archivos del workspace",
    keywords: "files archivos file tree explorer abrir workspace",
    icon: FolderTree,
    status: "ready",
    behavior: "screen",
  },
  "new-file": {
    id: "new-file",
    label: "New file",
    description: "Crea un archivo nuevo",
    keywords: "new file nuevo archivo crear",
    icon: FilePlus2,
    status: "ready",
    behavior: "action",
  },
  "code-search": {
    id: "code-search",
    label: "Code Search",
    description: "Busca en el contenido de los archivos",
    keywords: "code search buscar codigo archivos contenido grep",
    icon: Search,
    status: "ready",
    behavior: "screen",
  },
  publishing: {
    id: "publishing",
    label: "Publishing",
    description: "Publica una versión compartible de la app",
    keywords: "publishing deploy deployment publish publicar production domains logs",
    icon: Rocket,
    status: "ready",
    behavior: "screen",
  },
  integrations: {
    id: "integrations",
    label: "Integraciones",
    description: "Conecta servicios nativos y APIs externas",
    keywords: "integraciones integrations connectors apis servicios nativos",
    icon: Cable,
    status: "ready",
    behavior: "screen",
  },
  database: {
    id: "database",
    label: "Database",
    description: "Datos estructurados: perfiles, métricas, catálogos",
    keywords: "database postgres sql datos tablas metrics catalogos",
    icon: Database,
    status: "ready",
    behavior: "screen",
  },
  storage: {
    id: "storage",
    label: "App Storage",
    description: "Imágenes, vídeos y documentos de la app",
    keywords: "app storage object files uploads imagenes videos documentos",
    icon: HardDrive,
    status: "ready",
    behavior: "screen",
  },
  auth: {
    id: "auth",
    label: "Auth",
    description: "Inicio de sesión con página de login lista",
    keywords: "auth authentication login users oauth sesion",
    icon: ShieldCheck,
    status: "ready",
    behavior: "screen",
  },
  security: {
    id: "security",
    label: "Security Center",
    description: "Vulnerabilidades, privacidad y cumplimiento",
    keywords: "security center seguridad vulnerabilidades privacy compliance scan",
    icon: ShieldAlert,
    status: "ready",
    behavior: "screen",
  },
  secrets: {
    id: "secrets",
    label: "Secrets",
    description: "API keys y credenciales de forma segura",
    keywords: "secrets env api keys credenciales environment variables",
    icon: KeyRound,
    status: "ready",
    behavior: "screen",
  },
  skills: {
    id: "skills",
    label: "Agent Skills",
    description: "Habilidades que amplían las capacidades del agente",
    keywords: "agent skills habilidades capacidades agente tools",
    icon: Sparkles,
    status: "ready",
    behavior: "screen",
  },
  analytics: {
    id: "analytics",
    label: "Analytics",
    description: "Tráfico, métricas y uso de la app desplegada",
    keywords: "analytics metricas trafico uso deployed app monitoring",
    icon: BarChart3,
    status: "ready",
    behavior: "screen",
  },
  automations: {
    id: "automations",
    label: "Automations",
    description: "Agentes y automatizaciones de larga duración",
    keywords: "automations automatizaciones agents recurring long running",
    icon: Bot,
    status: "ready",
    behavior: "screen",
  },
  canvas: {
    id: "canvas",
    label: "Canvas",
    description: "Lienzo controlado por agente para mockups",
    keywords: "canvas lienzo design mockups frames flows",
    icon: PenTool,
    status: "ready",
    behavior: "screen",
  },
  settings: {
    id: "settings",
    label: "User Settings",
    description: "Preferencias del editor y del workspace",
    keywords: "user settings preferencias editor workspace keyboard theme",
    icon: Settings,
    status: "ready",
    behavior: "screen",
  },
  validation: {
    id: "validation",
    label: "Validation",
    description: "Comandos de prueba y resultados de CI",
    keywords: "validation tests ci comandos checks qa",
    icon: CheckCircle2,
    status: "ready",
    behavior: "screen",
  },
  developer: {
    id: "developer",
    label: "Developer",
    description: "Herramientas internas, telemetría y diagnósticos",
    keywords: "developer devtools diagnostics telemetry internal debug",
    icon: Wrench,
    status: "ready",
    behavior: "screen",
  },
  git: {
    id: "git",
    label: "Git",
    description: "Control de versiones del proyecto",
    keywords: "git version control github commit push branch",
    icon: GitBranch,
    status: "ready",
    behavior: "screen",
  },
  vnc: {
    id: "vnc",
    label: "VNC",
    description: "Pantalla de escritorio remota de la app",
    keywords: "vnc remote desktop pantalla remota viewer",
    icon: MonitorSmartphone,
    status: "ready",
    readiness: "pronto",
    behavior: "screen",
  },
  workflows: {
    id: "workflows",
    label: "Workflows",
    description: "Comandos reutilizables y botón Run del workspace",
    keywords: "workflows run button comandos reusable scripts paralelo secuencial",
    icon: Workflow,
    status: "ready",
    behavior: "screen",
  },
}

export type ToolSection = {
  id: string
  label: string
  toolIds: WorkspaceToolId[]
}

/**
 * Static sections shown in the launcher. The dynamic "Pestañas abiertas"
 * section is computed by the launcher from the currently-open tools.
 */
export const TOOL_SECTIONS: ToolSection[] = [
  {
    id: "suggested",
    label: "Sugerido",
    toolIds: [
      "agent",
      "preview",
      "shell",
      "console",
      "publishing",
      "database",
      "secrets",
      "workflows",
    ],
  },
  {
    id: "advanced",
    label: "Avanzado",
    toolIds: [
      "integrations",
      "storage",
      "auth",
      "security",
      "analytics",
      "skills",
      "automations",
      "canvas",
      "settings",
      "validation",
      "developer",
      "git",
      "vnc",
    ],
  },
  {
    id: "files",
    label: "Archivos",
    toolIds: ["files", "new-file"],
  },
]

export const ALL_TOOLS: WorkspaceTool[] = Object.values(WORKSPACE_TOOLS)


/** OLA200_WAVE_F FE-053 — timeout + abort so a hung tool cannot freeze the composer. */
export async function invokeWorkspaceToolWithTimeout<T>(
  invoke: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 20_000,
  external?: AbortSignal | null,
): Promise<T> {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  if (external) {
    if (external.aborted) ac.abort()
    else external.addEventListener("abort", onAbort, { once: true })
  }
  const timer = setTimeout(() => ac.abort(), Math.max(250, timeoutMs))
  try {
    return await invoke(ac.signal)
  } finally {
    clearTimeout(timer)
    if (external) external.removeEventListener("abort", onAbort)
  }
}
