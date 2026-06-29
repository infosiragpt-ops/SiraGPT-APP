/**
 * code-agent · orchestrator (pure).
 *
 * The decision core of the /code chat agent. Given the current AgentState, the
 * user input and a few signals, it returns the next AgentAction — without any
 * side effects, network, or React. This mirrors the determinism of the builder
 * engine (intake-engine.js / brief-from-prompt.js) so the "Replit-Agent-style"
 * behaviour is fully testable with `node --test`.
 *
 * It also ships the SRE tier-0: a rule-based build-error classifier that maps
 * common packaging/install failures to a fix in the strict 5-section format,
 * so debugging works even when the LLM is unavailable.
 */

import type {
  AgentAction,
  AgentBuildContext,
  AgentGoal,
  AgentSignal,
  AgentState,
  BuildErrorVerdict,
} from "./types"

// ---- autonomous brief -------------------------------------------------------

// Kept for legacy sessions that may already be mid-intake in local storage.
// New build requests do not ask these questions; they generate immediately and
// the agent proposes missing brief details internally.
type IntakeQuestion = { slot: keyof AgentBuildContext; q: string }

const COMMON_QUESTIONS: readonly IntakeQuestion[] = [
  { slot: "productType", q: "¿Qué **producto o servicio** vas a ofrecer?" },
  { slot: "brand", q: "¿**Nombre** de la marca o negocio? (o escribe «propón uno»)" },
  { slot: "styleAudience", q: "¿Qué **estilo visual y público**? (ej. streetwear minimalista, premium oscuro, corporativo…)" },
]

const LANDING_QUESTIONS: readonly IntakeQuestion[] = [
  ...COMMON_QUESTIONS,
  { slot: "sections", q: "¿Qué **secciones** quieres? (hero, productos/colecciones, sobre nosotros, testimonios, contacto…)" },
  { slot: "colorRef", q: "¿Algún **color, paleta o referencia** (una web/marca que te guste)? (o «sorpréndeme»)" },
]

const APP_QUESTIONS: readonly IntakeQuestion[] = [
  ...COMMON_QUESTIONS,
  { slot: "features", q: "¿Qué **funcionalidades clave** no pueden faltar? (auth, pagos, panel, búsqueda, chat…)" },
  { slot: "dataEntities", q: "¿Qué **datos** manejará? Nombra las entidades (ej. Usuario, Pedido, Producto)." },
]

/** The intake question list for a goal (landing vs app). */
function questionsFor(goal: AgentGoal): readonly IntakeQuestion[] {
  return goal === "app" ? APP_QUESTIONS : LANDING_QUESTIONS
}

function clean(text: string): string {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim()
}

const BUILD_NOUN =
  /\b(landing|app|aplicaci[oó]n|web|p[aá]gina|pagina|sitio|website|portfolio|portafolio|tienda|ecommerce|e-commerce|dashboard|panel|blog|crud|software|sistema|plataforma)\b/
const BUILD_VERB =
  /\b(cre[ae]|cr[eé]a|cr[eé]ame|crear|crearme|cr[eé]ar|h[aá]z|hazme|haceme|hac[ée]me|construye|constr[uú]ye?me|construir|genera|gen[eé]rame|generar|real[ií]z(?:a|ar|[aá]me)|desarroll(?:a|ar|e)|desarr[oó]llame|programa|programar|impl[ée]menta|implementar|monta|m[oó]ntame|prepara|prepar[aá]me|prep[aá]rame|levanta|dame|ponme|quiero|necesito|dise[ñn]a|dise[ñn]ar|armar?|arma|build|make|create)\b/
const APP_GOAL_CUE =
  /\b(app|aplicaci[oó]n|dashboard|panel|crud|software|sistema|plataforma|gesti[oó]n|gestionar|administrar|manejar|registrar|punto de venta|pos|inventario|reservas?|pedidos?|ordenes?|[oó]rdenes?|clientes?|productos?|restaurante|restaurant|cafeter[ií]a|men[uú])\b/i

/** A "build something from scratch" request (recognised noun + verb). Strict. */
export function isBuildRequest(text: string): boolean {
  const t = text.toLowerCase()
  return BUILD_NOUN.test(t) && BUILD_VERB.test(t)
}

/**
 * Looser build-intent check: a build VERB alone ("créame…", "quiero…",
 * "hazme…"). In App mode this should generate directly, even with typos or a
 * missing noun ("crea un alding panaderia").
 */
export function hasBuildVerb(text: string): boolean {
  return BUILD_VERB.test(text.toLowerCase())
}

/** Short social greeting: should stay instant and never open the app intake. */
export function isQuickGreeting(text: string): boolean {
  const raw = clean(text)
  if (!raw || raw.length > 72) return false
  if (isBuildRequest(raw) || hasBuildVerb(raw) || BUILD_NOUN.test(raw.toLowerCase())) return false
  const t = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¡!¿?.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  // A greeting word ("hola", "buenas", "hey"…) and/or a short social opener
  // ("¿cómo estás?", "qué tal", "todo bien"…) — standalone OR combined. A bare
  // "como estas?" must stay an instant chat reply and never open the build/app
  // intake (the build-verb/noun guard above already rejects anything that is a
  // real request, so this is safe to widen).
  const GREET =
    "hola+|holi|holis|holas|ola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|saludos|hey+|ey|hi|hello|hellow|yo|sup"
  const OPENER =
    "que tal|que onda|que hubo|que pasa|que mas|que haces|como estas|como esta|como vas|como va|como andas|como te va|todo bien|how are you|whats up|what s up"
  return new RegExp(`^(?:(?:${GREET})(?: (?:${OPENER}))?|(?:${OPENER}))$`).test(t)
}

/** Heuristic: the text looks like a build/install/deploy error log. */
export function isBuildLog(text: string): boolean {
  return /(npm ERR!|npm error|ERESOLVE|EINTEGRITY|ETARGET|ENOENT|ECONNREFUSED|exit code|\bnpm\b.*\b404\b|tarball|Module not found|Cannot find module|firewall|gyp ERR!|peer dep)/i.test(
    text,
  )
}

function seedGoal(ctx: AgentBuildContext, text: string): AgentBuildContext {
  const goal = APP_GOAL_CUE.test(text) ? "app" : "landing"
  return { ...ctx, goal }
}

function seedAutonomousBrief(ctx: AgentBuildContext, text: string): AgentBuildContext {
  const seeded = seedGoal(ctx, text)
  const value = clean(text)
  if (!value || seeded.productType) return seeded
  return { ...seeded, productType: value }
}

/** Fill the slot the agent just asked about. "propón uno"/"sorpréndeme"/"-" → leave empty. */
function fillSlot(ctx: AgentBuildContext, index: number, raw: string): AgentBuildContext {
  const list = questionsFor(ctx.goal)
  const slot = list[Math.max(0, Math.min(index, list.length - 1))].slot
  const value = clean(raw)
  if (!value || /^(prop[oó]n( uno)?|sin preferencia|no s[eé]|cualquiera|sorpr[eé]ndeme|lo que sea|-|n\/a)$/i.test(value)) {
    return ctx // keep empty → applyDefaults / prompt handles it
  }
  return { ...ctx, [slot]: value }
}

/**
 * Decide the next action for the chat agent. Pure.
 */
export function nextAgentAction(state: AgentState, input: string, signal: AgentSignal): AgentAction {
  const text = clean(input)
  const tier: "llm" | "deterministic" = signal.hasModel && !signal.forceDeterministic ? "llm" : "deterministic"

  // 1) Explicit error-fix bridge always wins (user pressed "Reparar error").
  if (signal.fixErrorText) return { type: "debug", log: signal.fixErrorText }

  // 2) Non-constructive modes → plain chat, ALWAYS. Ask/Plan/Image must NEVER
  //    write files — even after a build (phase "preview") or when the user pastes
  //    an error log — otherwise Ask silently turns a question into a patch/debug.
  //    This check stays ABOVE the preview-patch and pasted-log-debug rules below.
  if (signal.mode === "ask" || signal.mode === "plan" || signal.mode === "image") {
    return { type: "passthrough" }
  }

  // 3) Debug: explicit debug mode, or a pasted error log in a constructive mode.
  if (signal.mode === "debug" || isBuildLog(text)) return { type: "debug", log: text }

  // 4) ⚡ Construir → generate immediately.
  if (signal.forceDeterministic) {
    return { type: "generate", context: seedGoal(state.context, text), tier: "deterministic" }
  }

  // 5) Iterating on an already-built app.
  if (state.phase === "preview" && !isBuildRequest(text) && text.length > 0) {
    return { type: "patch", instruction: text }
  }

  const inIntake = state.phase === "intake"
  const isBuildSeed =
    isBuildRequest(text) ||
    hasBuildVerb(text) ||
    BUILD_NOUN.test(text.toLowerCase()) ||
    (signal.mode === "app" && text.length > 80)
  const isStart = (signal.mode === "app" || signal.mode === "build") && isBuildSeed

  // 5) Intake gate (app/build).
  if (isStart || inIntake) {
    if (inIntake) {
      const idx = Math.max(0, state.intakeStep - 1) // the slot we just asked about
      const ctx = fillSlot(state.context, idx, text)
      return { type: "generate", context: seedAutonomousBrief(ctx, text), tier }
    }

    return { type: "generate", context: seedAutonomousBrief(state.context, text), tier }
  }

  // 6) Default (e.g. app-mode follow-up that is not a build request).
  return { type: "passthrough" }
}

/** Build the deterministic-generator prompt from the accumulated context. */
export function promptFromContext(ctx: AgentBuildContext): string {
  const kind = ctx.goal === "app" ? "App web" : "Landing one-page"
  const parts = [kind]
  if (ctx.brand) parts.push(`de ${ctx.brand}`)
  if (ctx.productType) parts.push(`para ${ctx.productType}`)
  if (ctx.styleAudience) parts.push(`estilo ${ctx.styleAudience}`)
  if (ctx.sections) parts.push(`con secciones ${ctx.sections}`)
  if (ctx.features) parts.push(`con funcionalidades ${ctx.features}`)
  if (ctx.dataEntities) parts.push(`que maneja ${ctx.dataEntities}`)
  if (ctx.colorRef) parts.push(`con paleta/referencias ${ctx.colorRef}`)
  return parts.join(" ")
}

// ---- SRE tier-0: deterministic build-error classifier ----------------------

function extractPackageSpec(log: string): { name?: string; version?: string } {
  // name@version (scoped or not)
  const nv = log.match(/((?:@[\w.-]+\/)?[\w.-]+)@(\d+\.\d+\.\d+(?:-[\w.]+)?)/)
  if (nv) return { name: nv[1], version: nv[2] }
  // scoped package name alone (common in OTel transitive failures)
  const scoped = log.match(/(@[\w.-]+\/[\w.-]+)/)
  if (scoped) return { name: scoped[1] }
  return {}
}

/**
 * Classify a build/install/deploy log into a fix verdict, in the strict
 * 5-section shape. Always returns a verdict (matched:false → generic guidance).
 */
export function classifyBuildError(log: string): BuildErrorVerdict {
  const text = String(log || "")
  const { name, version } = extractPackageSpec(text)

  // 404 / ETARGET on a (often transitive, optional) dependency tarball.
  if (/(\b404\b|ETARGET|ENOTFOUND)[\s\S]*(tarball|registry|\.tgz|resolve)/i.test(text) || /npm error 404/i.test(text)) {
    const dep = name || "la dependencia transitiva"
    const overrides = name ? { [name]: version || "latest" } : undefined
    return {
      matched: true,
      category: "registry_404_tarball",
      diagnostico: "Falló la instalación de dependencias durante el build.",
      quePasaba: `\`npm\` abortó al descargar el tarball de \`${dep}\` (HTTP 404 desde el registro/espejo). Suele ser una dependencia **transitiva opcional**.`,
      causaRaiz:
        "No es tu código: el firewall del entorno bloquea el egress al host de ese tarball, o el paquete no está en el espejo de npm configurado.",
      arreglo: name
        ? `Fijar \`${name}\` vía \`overrides\` a una versión presente en el registro${version ? ` (\`${version}\`)` : ""}, o marcarla opcional. *(package.json actualizado).*`
        : "Añadir un `overrides` que fije la dependencia rota a una versión presente, o configurar un `.npmrc` con un registro accesible.",
      siguientePaso: "Pulsa **⚡ Construir / Re-publicar** para reintentar la instalación.",
      suggestedOverrides: overrides,
    }
  }

  // ERESOLVE peer-dependency conflict.
  if (/ERESOLVE|peer dep|could not resolve dependency/i.test(text)) {
    const overrides = name ? { [name]: version || "latest" } : undefined
    return {
      matched: true,
      category: "eresolve_peer",
      diagnostico: "La instalación falló por un conflicto de dependencias peer.",
      quePasaba:
        "El árbol de dependencias tiene peers incompatibles y `npm` no pudo resolver una versión que satisfaga a todos.",
      causaRaiz:
        "No es un bug de tu app: dos paquetes piden rangos de peer-deps incompatibles entre sí en el registro.",
      arreglo: name
        ? `Fijar \`${name}\`${version ? ` a \`${version}\`` : ""} en \`overrides\` para romper el conflicto. *(package.json actualizado).*`
        : "Fijar la versión del peer en conflicto en `overrides`, o instalar con `--legacy-peer-deps`.",
      siguientePaso: "Pulsa **⚡ Construir / Re-publicar** para reinstalar.",
      suggestedOverrides: overrides,
    }
  }

  // EINTEGRITY — checksum mismatch (stale lockfile vs mirror).
  if (/EINTEGRITY|integrity check(sum)? failed|sha512-/i.test(text)) {
    return {
      matched: true,
      category: "eintegrity",
      diagnostico: "La instalación falló por un checksum de integridad que no coincide.",
      quePasaba:
        "El hash del paquete en el lockfile no coincide con el del tarball servido por el registro/espejo.",
      causaRaiz: "No es tu código: el espejo de npm sirvió un artefacto distinto al fijado en el lockfile.",
      arreglo:
        "Regenerar la entrada del lockfile o fijar el paquete afectado a una versión estable en `overrides`. *(revisa package-lock).* ",
      siguientePaso: "Pulsa **⚡ Construir / Re-publicar** tras regenerar el lockfile.",
    }
  }

  // Module not found in the dev server / preview build.
  if (/Module not found|Cannot find module/i.test(text)) {
    return {
      matched: true,
      category: "module_not_found",
      diagnostico: "El build/preview no encuentra un módulo importado.",
      quePasaba: name
        ? `Se importó \`${name}\` pero no está disponible en el entorno.`
        : "Hay un import a un paquete que no existe en el workspace.",
      causaRaiz:
        "Si el workspace tiene `package.json` (proyecto Vite/Node), la dependencia falta en `dependencies` o no se instaló. Si es un preview estático sin build, los paquetes deben venir por CDN, no por `import` de npm.",
      arreglo:
        "Proyecto Vite/Node: añade el paquete a `dependencies` en `package.json` y pulsa **▶ Ejecutar** para reinstalar. Preview estático: quita el `import` y cárgalo por CDN (`<script src=…>`), o usa una alternativa ya disponible (React/Tailwind están globales).",
      siguientePaso: "Aplica el cambio y pulsa **▶ Ejecutar** (proyecto Node) o revisa el **preview en vivo** (estático).",
    }
  }

  // Generic fallback — still in the strict format.
  return {
    matched: false,
    category: "generic_build_failure",
    diagnostico: "El build/instalación falló.",
    quePasaba: "El proceso terminó con error; el log no coincide con un patrón conocido.",
    causaRaiz:
      "Puede ser del entorno (red/registry/firewall) o de una configuración. Revisa la primera línea de error del log.",
    arreglo:
      "Comparte la línea exacta del primer error (npm ERR! / exit code) o el nombre del paquete que falla para fijar un `overrides`.",
    siguientePaso: "Tras ajustar, pulsa **⚡ Construir / Re-publicar**.",
  }
}

/** Render a verdict as the strict 5-section Markdown the SRE role must emit. */
export function renderFiveSections(v: BuildErrorVerdict): string {
  return [
    `**Diagnóstico:** ${v.diagnostico}`,
    `**Qué pasaba:** ${v.quePasaba}`,
    `**Causa raíz:** ${v.causaRaiz}`,
    `**Arreglo:** ${v.arreglo}`,
    `**Siguiente paso:** ${v.siguientePaso}`,
  ].join("\n\n")
}

/**
 * Merge overrides into a package.json text, returning the new full content.
 * Pure. Returns null if the input is not valid JSON (caller skips the patch).
 */
export function mergeOverridesIntoPackageJson(
  pkgText: string,
  overrides: Record<string, string>,
): string | null {
  try {
    const pkg = JSON.parse(pkgText)
    pkg.overrides = { ...(pkg.overrides || {}), ...overrides }
    return JSON.stringify(pkg, null, 2) + "\n"
  } catch {
    return null
  }
}
