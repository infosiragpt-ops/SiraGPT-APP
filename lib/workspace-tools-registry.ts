import type { LucideIcon } from "lucide-react"
import {
  BarChart3,
  Blocks,
  CheckCircle2,
  Code2,
  Database,
  FilePlus2,
  FileSearch,
  FolderOpen,
  GitBranch,
  Globe,
  LayoutGrid,
  Lock,
  Monitor,
  Palette,
  PlaySquare,
  Search,
  Settings,
  Shield,
  Sparkles,
  Terminal,
  UserCheck,
  Workflow,
} from "lucide-react"

import type { WorkspacePanelId } from "@/components/code/workspace-top-bar"
import type { WorkspaceToolId } from "@/lib/code-workspace-tools"

export type WorkspaceToolSectionId =
  | "jump"
  | "suggested"
  | "advanced"
  | "files"

export type WorkspaceToolAction =
  | { type: "panel"; panel: WorkspacePanelId }
  | { type: "code-tool"; toolId: WorkspaceToolId }
  | { type: "palette"; query?: string }
  | { type: "new-file" }
  | { type: "open-app" }
  | { type: "publishing" }
  | { type: "navigate"; href: string }
  | { type: "workflow-dialog" }
  | { type: "focus-chat" }
  | { type: "composer" }
  | { type: "noop"; message: string }

export type WorkspaceToolDef = {
  id: string
  section: WorkspaceToolSectionId
  title: string
  description: string
  icon: LucideIcon
  keywords?: string
  action: WorkspaceToolAction
  showChevron?: boolean
}

export const WORKSPACE_TOOL_SECTION_LABELS: Record<WorkspaceToolSectionId, string> = {
  jump: "Ir a una pestaña abierta",
  suggested: "Sugerido",
  advanced: "Avanzado",
  files: "Archivos",
}

export const WORKSPACE_TOOLS: WorkspaceToolDef[] = [
  {
    id: "jump-agent",
    section: "jump",
    title: "Agent",
    description: "Chat de construccion y edicion del workspace",
    icon: Sparkles,
    keywords: "agent chat builder assistant",
    action: { type: "focus-chat" },
  },
  {
    id: "jump-preview",
    section: "jump",
    title: "Preview",
    description: "Vista previa de la app en el navegador",
    icon: Monitor,
    keywords: "preview browser app",
    action: { type: "panel", panel: "preview" },
  },
  {
    id: "jump-shell",
    section: "jump",
    title: "Shell",
    description: "Terminal integrada (CLI del workspace)",
    icon: Terminal,
    keywords: "shell terminal cli bash",
    action: { type: "panel", panel: "terminal" },
  },
  {
    id: "jump-publishing",
    section: "jump",
    title: "Publishing",
    description: "Publica una version compartible de la app",
    icon: Globe,
    keywords: "publishing deploy deployments publish",
    action: { type: "code-tool", toolId: "publishing" },
  },
  {
    id: "suggested-agent",
    section: "suggested",
    title: "Agent",
    description: "Chat de construccion y edicion del workspace",
    icon: Sparkles,
    keywords: "agent chat builder assistant",
    action: { type: "focus-chat" },
  },
  {
    id: "suggested-preview",
    section: "suggested",
    title: "Preview",
    description: "Vista previa de la app en el navegador",
    icon: Monitor,
    keywords: "preview browser app",
    action: { type: "panel", panel: "preview" },
  },
  {
    id: "suggested-shell",
    section: "suggested",
    title: "Shell",
    description: "Terminal integrada (CLI del workspace)",
    icon: Terminal,
    keywords: "shell terminal cli bash",
    action: { type: "panel", panel: "terminal" },
  },
  {
    id: "suggested-console",
    section: "suggested",
    title: "Console",
    description: "Salida de terminal tras ejecutar codigo",
    icon: Code2,
    keywords: "console output logs terminal",
    action: { type: "code-tool", toolId: "console" },
  },
  {
    id: "suggested-publish",
    section: "suggested",
    title: "Publishing",
    description: "Publica una versión compartible de la app",
    icon: Globe,
    keywords: "publish deploy share",
    action: { type: "publishing" },
  },
  {
    id: "suggested-integrations",
    section: "suggested",
    title: "Integraciones",
    description: "Conecta servicios nativos y APIs externas",
    icon: Blocks,
    keywords: "integrations mcp connectors",
    action: { type: "code-tool", toolId: "integrations" },
  },
  {
    id: "suggested-database",
    section: "suggested",
    title: "Database",
    description: "Datos estructurados: perfiles, métricas, catálogos",
    icon: Database,
    keywords: "database sql prisma",
    action: { type: "code-tool", toolId: "database" },
  },
  {
    id: "suggested-storage",
    section: "suggested",
    title: "App Storage",
    description: "Sube y guarda imágenes, vídeos y documentos",
    icon: FolderOpen,
    keywords: "storage upload files",
    action: { type: "code-tool", toolId: "storage" },
  },
  {
    id: "suggested-auth",
    section: "suggested",
    title: "Auth",
    description: "Inicio de sesión con página de login preconstruida",
    icon: UserCheck,
    keywords: "auth login oauth",
    action: { type: "code-tool", toolId: "auth" },
  },
  {
    id: "suggested-security",
    section: "suggested",
    title: "Security Center",
    description: "Vulnerabilidades, privacidad y cumplimiento",
    icon: Shield,
    keywords: "security audit compliance",
    action: { type: "code-tool", toolId: "security" },
  },
  {
    id: "suggested-secrets",
    section: "suggested",
    title: "Secrets",
    description: "API keys y credenciales de forma segura",
    icon: Lock,
    keywords: "secrets env api key",
    action: { type: "code-tool", toolId: "secrets" },
  },
  {
    id: "suggested-agent-skills",
    section: "suggested",
    title: "Agent Skills",
    description: "Habilidades que amplían las capacidades del agente",
    icon: Sparkles,
    keywords: "agent skills tools gpts",
    action: { type: "code-tool", toolId: "skills" },
  },
  {
    id: "suggested-analytics",
    section: "suggested",
    title: "Analytics",
    description: "Tráfico, métricas y uso de la app desplegada",
    icon: BarChart3,
    keywords: "analytics metrics traffic",
    action: { type: "code-tool", toolId: "analytics" },
  },
  {
    id: "suggested-automations",
    section: "suggested",
    title: "Automations",
    description: "Agentes y automatizaciones de larga duración",
    icon: PlaySquare,
    keywords: "automations agents cron",
    action: { type: "code-tool", toolId: "automations" },
  },
  {
    id: "suggested-canvas",
    section: "suggested",
    title: "Canvas",
    description: "Lienzo controlado por agente para mockups",
    icon: Palette,
    keywords: "canvas design wireframe",
    action: { type: "code-tool", toolId: "canvas" },
  },
  {
    id: "suggested-settings",
    section: "suggested",
    title: "User Settings",
    description: "Preferencias del editor y del workspace",
    icon: Settings,
    keywords: "settings preferences",
    action: { type: "code-tool", toolId: "settings" },
  },
  {
    id: "adv-settings",
    section: "advanced",
    title: "User Settings",
    description: "Preferencias personales del editor",
    icon: Settings,
    keywords: "settings",
    action: { type: "code-tool", toolId: "settings" },
  },
  {
    id: "adv-validation",
    section: "advanced",
    title: "Validation",
    description: "Comandos de prueba y resultados de CI",
    icon: CheckCircle2,
    keywords: "validation test ci",
    action: { type: "panel", panel: "validation" },
  },
  {
    id: "adv-preview",
    section: "advanced",
    title: "Preview",
    description: "Vista previa de la app",
    icon: Monitor,
    keywords: "preview",
    action: { type: "panel", panel: "preview" },
  },
  {
    id: "adv-shell",
    section: "advanced",
    title: "Shell",
    description: "Acceso CLI al workspace",
    icon: Terminal,
    keywords: "shell terminal",
    action: { type: "panel", panel: "terminal" },
  },
  {
    id: "adv-code-search",
    section: "advanced",
    title: "Code Search",
    description: "Buscar en el contenido de los archivos del workspace",
    icon: Search,
    keywords: "search find code grep",
    action: { type: "palette", query: "open " },
  },
  {
    id: "adv-console",
    section: "advanced",
    title: "Console",
    description: "Salida de terminal tras ejecutar código",
    icon: Code2,
    keywords: "console output log terminal",
    action: { type: "code-tool", toolId: "console" },
  },
  {
    id: "adv-developer",
    section: "advanced",
    title: "Developer",
    description: "Herramientas internas, telemetría y diagnósticos",
    icon: LayoutGrid,
    keywords: "developer debug telemetry",
    action: { type: "code-tool", toolId: "developer" },
  },
  {
    id: "adv-git",
    section: "advanced",
    title: "Git",
    description: "Control de versiones del proyecto",
    icon: GitBranch,
    keywords: "git version control",
    action: { type: "panel", panel: "git" },
  },
  {
    id: "adv-vnc",
    section: "advanced",
    title: "VNC",
    description: "Pantalla de escritorio remota de la app",
    icon: Monitor,
    keywords: "vnc desktop screen",
    action: { type: "code-tool", toolId: "vnc" },
  },
  {
    id: "adv-workflows",
    section: "advanced",
    title: "Workflows",
    description: "Orquestación encadenada con agente interno (10–20 h)",
    icon: Workflow,
    keywords: "workflow agent chain durable opus",
    action: { type: "code-tool", toolId: "workflows" },
  },
  {
    id: "files-find",
    section: "files",
    title: "Files",
    description: "Buscar un archivo",
    icon: FileSearch,
    keywords: "files find open",
    action: { type: "code-tool", toolId: "files" },
    showChevron: true,
  },
  {
    id: "files-new",
    section: "files",
    title: "New file",
    description: "Crear un archivo nuevo",
    icon: FilePlus2,
    keywords: "new file create",
    action: { type: "new-file" },
    showChevron: true,
  },
]

const SECTION_ORDER: WorkspaceToolSectionId[] = ["jump", "suggested", "advanced", "files"]

export function filterWorkspaceTools(query: string): WorkspaceToolDef[] {
  const q = query.trim().toLowerCase()
  if (!q) return WORKSPACE_TOOLS
  return WORKSPACE_TOOLS.filter((tool) => {
    const blob = `${tool.title} ${tool.description} ${tool.keywords ?? ""}`.toLowerCase()
    return blob.includes(q)
  })
}

export function groupWorkspaceTools(tools: WorkspaceToolDef[]): Array<{ section: WorkspaceToolSectionId; label: string; items: WorkspaceToolDef[] }> {
  return SECTION_ORDER.map((section) => ({
    section,
    label: WORKSPACE_TOOL_SECTION_LABELS[section],
    items: tools.filter((t) => t.section === section),
  })).filter((g) => g.items.length > 0)
}

/** 20 h — Replit-style durable agent runs */
export const WORKSPACE_WORKFLOW_MAX_RUNTIME_MS = 20 * 60 * 60 * 1000

/** 10 h preset */
export const WORKSPACE_WORKFLOW_RUNTIME_10H_MS = 10 * 60 * 60 * 1000

export const WORKSPACE_ORCHESTRATOR_MODEL =
  process.env.NEXT_PUBLIC_WORKSPACE_ORCHESTRATOR_MODEL || "claude-opus-4-20250514"
