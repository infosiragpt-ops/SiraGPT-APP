/**
 * Workspace tools registry — the catalog behind the /code "Herramientas"
 * launcher (Replit-style tool dock). One source of truth for the tool
 * metadata; the launcher renders sections from here and the tool screen
 * renders one tool at a time.
 *
 * status:   "ready" → wired to real behavior · "soon" → polished placeholder
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

export type ToolStatus = "ready" | "soon"
export type ToolBehavior = "screen" | "action"

export type WorkspaceToolId =
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
  icon: LucideIcon
  status: ToolStatus
  behavior: ToolBehavior
}

export const WORKSPACE_TOOLS: Record<WorkspaceToolId, WorkspaceTool> = {
  preview: {
    id: "preview",
    label: "Preview",
    description: "Vista previa de la app en el navegador",
    icon: Monitor,
    status: "ready",
    behavior: "screen",
  },
  shell: {
    id: "shell",
    label: "Shell",
    description: "Terminal integrada (CLI del workspace)",
    icon: Terminal,
    status: "ready",
    behavior: "screen",
  },
  console: {
    id: "console",
    label: "Console",
    description: "Salida de terminal tras ejecutar código",
    icon: SquareTerminal,
    status: "ready",
    behavior: "screen",
  },
  files: {
    id: "files",
    label: "Files",
    description: "Explora y abre los archivos del workspace",
    icon: FolderTree,
    status: "ready",
    behavior: "screen",
  },
  "new-file": {
    id: "new-file",
    label: "New file",
    description: "Crear un archivo nuevo",
    icon: FilePlus2,
    status: "ready",
    behavior: "action",
  },
  "code-search": {
    id: "code-search",
    label: "Code Search",
    description: "Buscar en el contenido de los archivos del workspace",
    icon: Search,
    status: "ready",
    behavior: "action",
  },
  publishing: {
    id: "publishing",
    label: "Publishing",
    description: "Publica una versión compartible de la app",
    icon: Rocket,
    status: "soon",
    behavior: "screen",
  },
  integrations: {
    id: "integrations",
    label: "Integraciones",
    description: "Conecta servicios nativos y APIs externas",
    icon: Cable,
    status: "soon",
    behavior: "screen",
  },
  database: {
    id: "database",
    label: "Database",
    description: "Datos estructurados: perfiles, métricas, catálogos",
    icon: Database,
    status: "soon",
    behavior: "screen",
  },
  storage: {
    id: "storage",
    label: "App Storage",
    description: "Sube y guarda imágenes, vídeos y documentos",
    icon: HardDrive,
    status: "soon",
    behavior: "screen",
  },
  auth: {
    id: "auth",
    label: "Auth",
    description: "Inicio de sesión con página de login preconstruida",
    icon: ShieldCheck,
    status: "soon",
    behavior: "screen",
  },
  security: {
    id: "security",
    label: "Security Center",
    description: "Vulnerabilidades, privacidad y cumplimiento",
    icon: ShieldAlert,
    status: "soon",
    behavior: "screen",
  },
  secrets: {
    id: "secrets",
    label: "Secrets",
    description: "API keys y credenciales de forma segura",
    icon: KeyRound,
    status: "soon",
    behavior: "screen",
  },
  skills: {
    id: "skills",
    label: "Agent Skills",
    description: "Habilidades que amplían las capacidades del agente",
    icon: Sparkles,
    status: "soon",
    behavior: "screen",
  },
  analytics: {
    id: "analytics",
    label: "Analytics",
    description: "Tráfico, métricas y uso de la app desplegada",
    icon: BarChart3,
    status: "soon",
    behavior: "screen",
  },
  automations: {
    id: "automations",
    label: "Automations",
    description: "Agentes y automatizaciones de larga duración",
    icon: Bot,
    status: "soon",
    behavior: "screen",
  },
  canvas: {
    id: "canvas",
    label: "Canvas",
    description: "Lienzo controlado por agente para mockups",
    icon: PenTool,
    status: "soon",
    behavior: "screen",
  },
  settings: {
    id: "settings",
    label: "User Settings",
    description: "Preferencias del editor y del workspace",
    icon: Settings,
    status: "soon",
    behavior: "screen",
  },
  validation: {
    id: "validation",
    label: "Validation",
    description: "Comandos de prueba y resultados de CI",
    icon: CheckCircle2,
    status: "soon",
    behavior: "screen",
  },
  developer: {
    id: "developer",
    label: "Developer",
    description: "Herramientas internas, telemetría y diagnósticos",
    icon: Wrench,
    status: "soon",
    behavior: "screen",
  },
  git: {
    id: "git",
    label: "Git",
    description: "Control de versiones del proyecto",
    icon: GitBranch,
    status: "soon",
    behavior: "screen",
  },
  vnc: {
    id: "vnc",
    label: "VNC",
    description: "Pantalla de escritorio remota de la app",
    icon: MonitorSmartphone,
    status: "soon",
    behavior: "screen",
  },
  workflows: {
    id: "workflows",
    label: "Workflows",
    description: "Orquestación encadenada con agente interno (10–20 h)",
    icon: Workflow,
    status: "soon",
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
      "publishing",
      "integrations",
      "database",
      "storage",
      "auth",
      "security",
      "secrets",
      "skills",
      "analytics",
      "automations",
      "canvas",
      "settings",
    ],
  },
  {
    id: "advanced",
    label: "Avanzado",
    toolIds: [
      "settings",
      "validation",
      "preview",
      "shell",
      "code-search",
      "console",
      "developer",
      "git",
      "vnc",
      "workflows",
    ],
  },
  {
    id: "files",
    label: "Archivos",
    toolIds: ["files", "new-file"],
  },
]

export const ALL_TOOLS: WorkspaceTool[] = Object.values(WORKSPACE_TOOLS)
