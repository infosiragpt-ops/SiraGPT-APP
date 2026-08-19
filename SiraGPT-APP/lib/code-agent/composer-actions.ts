import type { ComposerMode } from "./types"

export type ComposerQuickActionId =
  | "app-from-scratch"
  | "build-change"
  | "plan-architecture"
  | "debug-preview"
  | "ask-workspace"
  | "image-design"
  | "skills-implementation"
  | "skills-debugging"
  | "skills-review"
  | "mcp-workspace"
  | "mcp-code-tools"
  | "mcp-integrations"

export type ComposerToolTarget = "skills" | "developer" | "integrations" | "workflows" | "console"

export type ComposerQuickAction = {
  id: ComposerQuickActionId
  mode: ComposerMode
  prompt: string
  includeContext: boolean
  toolId?: ComposerToolTarget
  toast: string
}

export const COMPOSER_QUICK_ACTIONS: Record<ComposerQuickActionId, ComposerQuickAction> = {
  "app-from-scratch": {
    id: "app-from-scratch",
    mode: "app",
    includeContext: true,
    toast: "Modo App listo: describe o envia para construir desde cero.",
    prompt:
      "Construye una app web completa desde cero. Propón el producto, la arquitectura, el diseño y los datos demo si falta contexto. Entrega archivos listos para preview y ejecución.",
  },
  "build-change": {
    id: "build-change",
    mode: "build",
    includeContext: true,
    toast: "Modo Build listo: el agente aplicará cambios al workspace.",
    prompt:
      "Implementa este cambio en el workspace actual: revisa los archivos disponibles, edita solo lo necesario, aplica los cambios y deja el preview funcional.",
  },
  "plan-architecture": {
    id: "plan-architecture",
    mode: "plan",
    includeContext: true,
    toast: "Modo Plan listo: análisis sin escribir archivos.",
    prompt:
      "Analiza el workspace actual y entrega un plan técnico claro: arquitectura, archivos afectados, riesgos, validaciones y siguiente paso. No escribas archivos todavía.",
  },
  "debug-preview": {
    id: "debug-preview",
    mode: "debug",
    includeContext: true,
    toolId: "console",
    toast: "Modo Debug listo: revisa errores y propone un parche.",
    prompt:
      "Depura esta app: revisa el preview, consola y archivos del workspace. Identifica la causa raíz, aplica el parche mínimo necesario y deja instrucciones de verificación.",
  },
  "ask-workspace": {
    id: "ask-workspace",
    mode: "ask",
    includeContext: true,
    toast: "Modo Ask listo: pregunta técnica sobre el workspace.",
    prompt:
      "Explícame cómo está organizado este workspace, qué archivo controla el preview y qué cambios puedo pedirte ahora.",
  },
  "image-design": {
    id: "image-design",
    mode: "image",
    includeContext: true,
    toast: "Modo Image listo: convierte referencias visuales en cambios de UI.",
    prompt:
      "Analiza la captura o referencia visual adjunta y conviértela en cambios concretos de UI para esta app. Si falta la imagen, dime exactamente qué referencia necesitas.",
  },
  "skills-implementation": {
    id: "skills-implementation",
    mode: "plan",
    includeContext: true,
    toolId: "skills",
    toast: "Skills abierto: planificación de implementación lista.",
    prompt:
      "Selecciona las skills adecuadas para implementar esta app. Indica skill principal, skills secundarias, archivos que deben tocarse, orden de ejecución y validaciones.",
  },
  "skills-debugging": {
    id: "skills-debugging",
    mode: "debug",
    includeContext: true,
    toolId: "skills",
    toast: "Skills abierto: diagnóstico listo.",
    prompt:
      "Selecciona las skills adecuadas para depurar este workspace. Revisa síntomas, logs disponibles, hipótesis, pruebas mínimas y parche recomendado.",
  },
  "skills-review": {
    id: "skills-review",
    mode: "ask",
    includeContext: true,
    toolId: "skills",
    toast: "Skills abierto: revisión lista.",
    prompt:
      "Haz una revisión técnica del workspace usando las skills relevantes. Prioriza bugs, riesgos funcionales, accesibilidad, performance y pruebas faltantes.",
  },
  "mcp-workspace": {
    id: "mcp-workspace",
    mode: "ask",
    includeContext: true,
    toolId: "developer",
    toast: "MCP workspace listo: auditoría de contexto local.",
    prompt:
      "Audita las capacidades de workspace local disponibles para esta app: archivos, preview, consola, workflows, storage y limitaciones. Dime qué está conectado y qué falta para construir mejor.",
  },
  "mcp-code-tools": {
    id: "mcp-code-tools",
    mode: "debug",
    includeContext: true,
    toolId: "workflows",
    toast: "MCP code tools listo: revisión de herramientas.",
    prompt:
      "Revisa las herramientas de código disponibles para este workspace: build, run, terminal, validación, publicación y logs. Propón el flujo exacto para construir, probar y corregir.",
  },
  "mcp-integrations": {
    id: "mcp-integrations",
    mode: "ask",
    includeContext: true,
    toolId: "integrations",
    toast: "MCP integrations listo: conectores abiertos.",
    prompt:
      "Audita MCP Servers, conectores e integraciones que esta app necesitaría. Prioriza APIs, base de datos, auth, pagos, storage y publicación. Indica qué conectar y cómo usarlo.",
  },
}

export function getComposerQuickAction(id: ComposerQuickActionId): ComposerQuickAction {
  return COMPOSER_QUICK_ACTIONS[id]
}
