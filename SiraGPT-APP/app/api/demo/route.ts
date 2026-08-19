import { NextResponse } from "next/server"

/**
 * Public, unauthenticated demo endpoint (growth handoff 2026-07-02).
 * Serves CACHED results — zero LLM cost, zero key exposure — so anonymous
 * visitors can see a real-looking output before signing up. Next route
 * handlers take precedence over the /api/* rewrite to the Express backend
 * (same mechanism as app/api/health), so this never reaches the backend.
 */

const CACHED_RESULTS: Record<string, string> = {
  contenido: [
    "**Versión profesional (LinkedIn)**",
    "Dejar de saltar entre cinco herramientas de IA también es productividad. SiraGPT reúne GPT, Claude, Gemini, generación de imágenes, voz y agentes en una sola cuenta: un flujo de trabajo, un historial, un lugar donde tu equipo realmente encuentra las cosas.",
    "",
    "**Versión directa (Instagram)**",
    "Una app. Todos los modelos. GPT, Claude, Gemini, imágenes, voz y agentes sin cambiar de pestaña. SiraGPT. Pruébalo gratis 👉 siragpt.com",
    "",
    "**Versión viral**",
    "Pagué 4 suscripciones de IA durante un año. Ahora uso una sola cuenta que las tiene todas — y me deja compararlas entre sí antes de decidir. No vuelvo atrás. #IA #productividad",
  ].join("\n"),
  comparar: [
    "**Respuesta tipo GPT — ejecución rápida**",
    "1. Congela el alcance hoy: una feature core, nada más. 2. Deja el deploy listo el día 1 (aunque sea con la landing vacía). 3. Automatiza el onboarding con un flujo de 3 pantallas. 4. Instrumenta analítica desde el primer commit. 5. Reserva el último día solo para bugs — sin features nuevas.",
    "",
    "**Respuesta tipo Claude — riesgo primero**",
    "Prioriza por costo de equivocarte: (1) el flujo de pago/registro, porque un fallo ahí mata el lanzamiento; (2) el caso de uso principal de punta a punta; (3) los estados de error visibles al usuario; (4) el deploy reproducible; (5) todo lo demás es recortable. Razonamiento: en una semana no optimizas — eliminas riesgos.",
    "",
    "**Respuesta tipo Gemini — usuario primero**",
    "Empieza por lo que el usuario ve en los primeros 60 segundos: landing clara → registro sin fricción → primer resultado 'wow' → botón de compartir → email de retorno. Ordena tus 5 tareas siguiendo exactamente ese recorrido y mide cada paso.",
  ].join("\n"),
  automatizar: [
    "**Plan de operaciones — listo para ejecutar**",
    "",
    "**Paso 1 · Revisar leads (25 min)**",
    "Filtra los leads de la semana por: respondió / abrió sin responder / frío. Los que abrieron sin responder son tu prioridad de hoy.",
    "",
    "**Paso 2 · Follow-ups (mensajes listos)**",
    '— Para quien abrió sin responder: "Hola {nombre}, vi que alcanzaste a revisar mi propuesta. ¿Te hace sentido que lo hablemos 15 minutos esta semana? Tengo martes 10am o jueves 4pm."',
    '— Para quien respondió con dudas: "Gracias por la respuesta, {nombre}. Te preparé un resumen de una página con los 3 puntos que preguntaste — te lo adjunto. ¿Avanzamos con una prueba de 2 semanas?"',
    "",
    "**Paso 3 · Propuesta (estructura)**",
    "Contexto del cliente → problema en sus palabras → solución en 3 bullets → precio con 2 opciones → siguiente paso con fecha.",
    "",
    "**Checklist final**",
    "☐ Leads clasificados ☐ Follow-ups enviados ☐ Propuesta redactada ☐ Recordatorio agendado para el viernes",
  ].join("\n"),
}

// Naive in-memory rate limit: enough to keep a public cached endpoint from
// being hammered (the payload is static text, so the blast radius is tiny).
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 20
const hits = new Map<string, { count: number; windowStart: number }>()

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = hits.get(ip)
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now })
    if (hits.size > 5000) hits.clear() // hard cap on memory
    return false
  }
  entry.count += 1
  return entry.count > MAX_PER_WINDOW
}

export async function POST(req: Request) {
  let demoId = ""
  try {
    const body = await req.json()
    demoId = String(body?.demoId || "")
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }

  const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim()
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 })
  }

  const result = CACHED_RESULTS[demoId]
  if (!result) {
    return NextResponse.json({ error: "demo_not_found" }, { status: 404 })
  }
  return NextResponse.json({ result, demoId, cached: true })
}
