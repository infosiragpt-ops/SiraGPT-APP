/**
 * Professional, agent-driven starting points for /code.
 *
 * These are intentionally instructions rather than static templates. A starter
 * enters the same durable plan -> build -> verify pipeline as a typed message,
 * so the result can include frontend, backend, data, tests and a live preview.
 */

import { CODE_FOCUS_CEO_CHAT_EVENT } from "./code-agent-company-proactive"

export const CODE_AGENT_REQUEST_EVENT = "siragpt:code-agent-request"
const PENDING_AGENT_REQUEST_KEY = "code-workspace:autonomous-starter-pending:v1"
const PENDING_AGENT_REQUEST_TTL_MS = 2 * 60_000

export type CodeAgentRequestMode = "app" | "build" | "plan" | "debug" | "ask" | "deps" | "image"

export type CodeAgentRequestDetail = {
  text?: string
  mode?: string
  consumed?: boolean
}

export type CodeAutonomousStarter = {
  id: "ai-platform" | "business-os" | "custom-product" | "ecommerce-store" | "analytics-dashboard" | "api-backend"
  title: string
  description: string
  meta: string
  prompt: string
}

export const CODE_AUTONOMOUS_STARTERS: readonly CodeAutonomousStarter[] = [
  {
    id: "ai-platform",
    title: "Plataforma de IA",
    description: "Chat con streaming, memoria, archivos, usuarios y administración.",
    meta: "Full-stack · IA · API",
    prompt: [
      "Construye una plataforma de asistente de IA full-stack profesional, inspirada únicamente en las capacidades de los mejores productos de chat, sin copiar su marca ni su diseño.",
      "Usa el runtime compatible del preview: React + Vite + TypeScript para el frontend, Express para la API y SQLite para persistencia local verificable. Incluye chat con streaming mediante un adaptador de proveedores, historial y memoria, archivos, autenticación local, organizaciones y RBAC, límites de uso, administración, validación, rate limiting, errores y datos demo.",
      "Añade pruebas, Docker y un README que documente el despliegue separado del backend y la migración opcional a PostgreSQL. Usa variables de entorno con placeholders y nunca expongas secretos. Trabaja de forma autónoma: planifica, implementa por capas, ejecuta checks, corrige los fallos y deja el preview full-stack funcionando antes de finalizar, dentro del presupuesto de la corrida (máximo 4 horas y 120 pasos).",
    ].join("\n\n"),
  },
  {
    id: "business-os",
    title: "Software empresarial",
    description: "Operaciones, clientes, tareas, métricas y permisos en un solo producto.",
    meta: "SaaS · API · Auditoría",
    prompt: [
      "Construye un software empresarial SaaS full-stack listo para evolucionar en producción.",
      "Usa frontend React + Vite + TypeScript, backend/API Express y SQLite para que todo funcione en el preview actual. Incluye dashboard ejecutivo, CRM de clientes, proyectos y tareas, estados y responsables, búsqueda y filtros, notificaciones, exportación, roles y permisos, auditoría, datos demo y estados loading/empty/error con diseño responsive y accesible.",
      "Añade pruebas, Docker y una capa de datos preparada para migrar a PostgreSQL, documentando esa migración sin afirmar que ya está provisionada. Trabaja de forma autónoma dentro del presupuesto de la corrida (máximo 4 horas y 120 pasos): verifica tipos y tests, arranca el servidor, revisa el preview y corrige errores antes de entregar.",
    ].join("\n\n"),
  },
  {
    id: "custom-product",
    title: "Centro de soporte IA",
    description: "Inbox, tickets, conocimiento y automatizaciones con asistencia inteligente.",
    meta: "Soporte · IA · Automatización",
    prompt: [
      "Construye un centro de soporte SaaS con IA full-stack profesional y completamente navegable.",
      "Usa frontend React + Vite + TypeScript, backend/API Express y SQLite. Incluye inbox multicanal simulado, tickets con estados, prioridades y responsables, clientes, base de conocimiento, búsqueda, respuestas asistidas mediante un adaptador de IA, automatizaciones, métricas, autenticación local, RBAC, auditoría, datos demo y estados loading/empty/error.",
      "Añade validación, límites, pruebas, Docker y documentación para desplegar el backend por separado y migrar a PostgreSQL. Divide el trabajo entre especialistas lógicos, integra de forma segura y deja evidencia de los checks y un preview funcional. Ejecuta de forma autónoma dentro del presupuesto de la corrida (máximo 4 horas y 120 pasos). Usa placeholders para secretos y no copies marcas ni interfaces de terceros.",
    ].join("\n\n"),
  },
  {
    id: "ecommerce-store",
    title: "Tienda online",
    description: "Catálogo, carrito, checkout, inventario y panel de administración.",
    meta: "E-commerce · Pagos · Inventario",
    prompt: [
      "Construye una tienda online e-commerce full-stack profesional y completamente funcional.",
      "Usa frontend React + Vite + TypeScript, backend/API Express y SQLite. Incluye catálogo de productos con búsqueda y filtros, categorías, vista de detalle, carrito de compras persistente, flujo de checkout simulado (pasos: envío → pago → confirmación), gestión de inventario, panel de administración con CRUD de productos, pedidos y clientes, métricas de ventas, autenticación local con roles (cliente vs admin), datos demo realistas y estados loading/empty/error.",
      "Añade validación de formularios, límites de stock, pruebas, Docker y documentación para desplegar el backend por separado y migrar a PostgreSQL. Trabaja de forma autónoma dentro del presupuesto de la corrida (máximo 4 horas y 120 pasos): verifica tipos, arranca el servidor, revisa el preview y corrige errores antes de entregar. Usa placeholders para secretos y no copies marcas ni interfaces de terceros.",
    ].join("\n\n"),
  },
  {
    id: "analytics-dashboard",
    title: "Dashboard analítico",
    description: "Métricas en tiempo real, gráficos, segmentación y reportes exportables.",
    meta: "Dashboard · Charts · Data",
    prompt: [
      "Construye un dashboard analítico full-stack profesional con visualizaciones interactivas.",
      "Usa frontend React + Vite + TypeScript, backend/API Express y SQLite. Incluye dashboard principal con KPI cards, gráficos de líneas/barras/donut (usa recharts o una librería ligera), tabla de datos con ordenamiento y filtros, segmentación por rango de fechas, exportación a CSV/JSON, métricas en tiempo real (simuladas con intervalos), panel de configuración, autenticación local, datos demo coherentes y estados loading/empty/error.",
      "Añade validación, pruebas, Docker y documentación. Trabaja de forma autónoma dentro del presupuesto de la corrida (máximo 4 horas y 120 pasos): verifica tipos, arranca el servidor, revisa el preview y corrige errores antes de entregar. Usa placeholders para secretos.",
    ].join("\n\n"),
  },
  {
    id: "api-backend",
    title: "API REST completa",
    description: "Backend con autenticación, CRUD, validación, rate limiting y documentación.",
    meta: "API · Backend · OpenAPI",
    prompt: [
      "Construye una API REST profesional completa con Express + TypeScript + SQLite.",
      "Incluye autenticación JWT con refresh tokens, middleware de validación (Zod o similar), rate limiting por IP y por usuario, CORS configurable, CRUD completo para al menos 3 entidades relacionadas, paginación y filtros, manejo centralizado de errores, logging estructurado, documentación OpenAPI/Swagger autogenerada, seed con datos demo, pruebas de integración con supertest, Docker y un README con instrucciones de despliegue.",
      "Asegura que todos los endpoints respondan correctamente, los tests pasen y la documentación Swagger sea navegable. Trabaja de forma autónoma dentro del presupuesto de la corrida (máximo 4 horas y 120 pasos): verifica tipos, arranca el servidor, ejecuta los tests y corrige errores antes de entregar. Usa placeholders para secretos.",
    ].join("\n\n"),
  },
] as const

export function claimCodeAgentRequest(
  detail: CodeAgentRequestDetail | null | undefined,
): { text: string; mode?: CodeAgentRequestMode } | null {
  if (!detail || detail.consumed) return null
  const text = String(detail.text || "").trim()
  if (!text) return null

  const mode: CodeAgentRequestMode | undefined =
    detail.mode === "app"
    || detail.mode === "build"
    || detail.mode === "deps"
    || detail.mode === "plan"
    || detail.mode === "debug"
    || detail.mode === "ask"
    || detail.mode === "image"
      ? detail.mode
      : undefined

  detail.consumed = true
  return { text, mode }
}

export function claimPendingCodeAgentInstruction(): { text: string; mode: "app" } | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(PENDING_AGENT_REQUEST_KEY)
    if (!raw) return null
    window.sessionStorage.removeItem(PENDING_AGENT_REQUEST_KEY)
    const parsed = JSON.parse(raw) as { text?: string; mode?: string; ts?: number }
    const text = String(parsed?.text || "").trim()
    const ts = Number(parsed?.ts)
    if (
      !text
      || parsed?.mode !== "app"
      || !Number.isFinite(ts)
      || Date.now() - ts > PENDING_AGENT_REQUEST_TTL_MS
    ) {
      return null
    }
    return { text, mode: "app" }
  } catch {
    return null
  }
}

export function requestCodeAgentInstruction(
  text: string,
  options: { mode?: "app" } = {},
): boolean {
  if (typeof window === "undefined") return false
  const instruction = String(text || "").trim()
  if (!instruction) return false
  const detail: CodeAgentRequestDetail = {
    text: instruction,
    mode: options.mode ?? "app",
  }
  window.dispatchEvent(new CustomEvent(CODE_AGENT_REQUEST_EVENT, { detail }))
  if (detail.consumed === true) {
    try {
      window.sessionStorage.removeItem(PENDING_AGENT_REQUEST_KEY)
    } catch {
      /* storage disabled */
    }
    return true
  }

  // Closing the CEO column unmounts its listener. Persist the instruction,
  // reopen that column, and let the panel claim it exactly once on mount.
  try {
    window.sessionStorage.setItem(
      PENDING_AGENT_REQUEST_KEY,
      JSON.stringify({ text: instruction, mode: "app", ts: Date.now() }),
    )
    window.dispatchEvent(new CustomEvent(CODE_FOCUS_CEO_CHAT_EVENT))
    return true
  } catch {
    return false
  }
}
