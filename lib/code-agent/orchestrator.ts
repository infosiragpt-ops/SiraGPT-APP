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
  /\b(landing|app|aplicaci[oó]n|web|p[aá]gina|pagina|sitio|website|portfolio|portafolio|tienda|ecommerce|e-commerce|dashboard|panel|blog|crud|software|sistema|plataforma|juegos?|videojuegos?|games?|arcade|calculadora|quiz)\b/
const BUILD_VERB =
  /\b(cre|cre[ae]|cr[eé]a|cr[eé]ame|crear|crearme|cr[eé]ar|h[aá]z|hazme|haceme|hac[ée]me|construye|constr[uú]ye?me|construir|contr[uú]ye(?:me)?|contruir|costr[uú]ye(?:me)?|costruir|genera|gen[eé]rame|generar|real[ií]z(?:a|ar|[aá]me)|desarroll(?:a|ar|e)|desarr[oó]llame|programa|programar|impl[ée]menta|implementar|monta|m[oó]ntame|prepara|prepar[aá]me|prep[aá]rame|levanta|dame|ponme|quiero|necesito|dise[ñn]a|dise[ñn]ar|armar?|arma|build|make|create)\b/
const APP_GOAL_CUE =
  /\b(app|aplicaci[oó]n|dashboard|panel|crud|software|sistema|plataforma|gesti[oó]n|gestionar|administrar|manejar|registrar|punto de venta|pos|inventario|pedidos?|ordenes?|[oó]rdenes?|clientes?|productos?)\b/i

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

function normalizeCodeIntent(text: string): string {
  return clean(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¡!¿?.,;:'’]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Educational, explanatory or explicitly negated code wording is read-only. */
export function isCodeInformationRequest(text: string): boolean {
  const normalized = normalizeCodeIntent(text)
  if (!normalized) return false
  if (
    /^(?:como\b|que\b|cual(?:es)?\b|por que\b|explicame\b|explica\b|dime como\b|quiero saber\b|necesito saber\b|quiero aprender\b|necesito aprender\b|puedes explicarme\b|podrias explicarme\b|me explicas\b|ayudame a entender\b|ensename (?:a|como)\b|muestrame como\b|tutorial\b|guia\b|pasos para\b|how\b|what\b|why\b|show me how\b|teach me how\b)/.test(
      normalized,
    )
  ) {
    return true
  }
  const isQuestion = /^[¿]/.test(clean(text)) || /\?\s*$/.test(clean(text))
  const explicitRequestQuestion =
    /^(?:(?:por favor|please) )?(?:puedes|podrias|can you|could you)\b/.test(normalized)
    || /^(?:por favor|please) (?:cambia|modifica|edita|corrige|arregla|agrega|anade|incluye|elimina|borra|quita|actualiza|reemplaza|renombra|mueve|instala|configura|sube|publica|despliega|sincroniza|change|edit|update|delete|remove|publish|upload|deploy|fix|add|install|configure|rename|move|sync)\b/.test(
      normalized,
    )
  if (
    isQuestion
    && !explicitRequestQuestion
    && /^(?:cambia|modifica|edita|corrige|arregla|agrega|anade|incluye|elimina|borra|quita|actualiza|reemplaza|renombra|mueve|instala|configura|sube|publica|despliega|sincroniza|change|edit|update|delete|remove|publish|upload|deploy|fix|add|install|configure|rename|move|sync)\b/.test(
      normalized,
    )
  ) {
    return true
  }

  // Negation is fail-closed: in a preview session even a terse "no hagas
  // nada" must never fall through to the generic patch branch.
  if (
    /^(?:(?:por favor|please) )?(?:no\b|nunca\b|do not\b|don t\b|never\b)/.test(normalized)
    || /^(?:quiero|necesito) que no\b/.test(normalized)
    || /^(?:(?:por favor )?sin) (?:hacer|tocar|cambiar|modificar|editar|corregir|arreglar|agregar|anadir|incluir|eliminar|borrar|quitar|actualizar|reemplazar|renombrar|mover|instalar|configurar|subir|publicar|desplegar|sincronizar|commit|push)\b/.test(
      normalized,
    )
  ) {
    return true
  }
  const mentionedMutation =
    "(?:cambi[a-z]*|modifi[a-z]*|edit[a-z]*|corr(?:eg|ij)[a-z]*|arregl[a-z]*|agreg[a-z]*|anad[a-z]*|inclu[a-z]*|elimin[a-z]*|borr[a-z]*|quit[a-z]*|actuali[a-z]*|reempla[a-z]*|renombr[a-z]*|muev[a-z]*|mov[a-z]*|instal[a-z]*|configur[a-z]*|sub(?:e|ir|elo|ela|as|an|amos)[a-z]*|publi[a-z]*|despleg[a-z]*|sincron[a-z]*|toc[a-z]*|(?:hag[a-z]*|hacer) (?:un )?(?:commit|push)|commit|push|chang[a-z]*|updat[a-z]*|delet[a-z]*|remov[a-z]*|publish[a-z]*|upload[a-z]*|deploy[a-z]*|fix[a-z]*|add[a-z]*|install[a-z]*|renam[a-z]*|sync[a-z]*)"
  if (
    new RegExp(
      `\\b(?:no|nunca|never|not|do not|don t)\\b(?: [a-z0-9_-]+){0,5} ${mentionedMutation}\\b`,
    ).test(normalized)
    || new RegExp(`\\bsin\\b(?: [a-z0-9_-]+){0,4} ${mentionedMutation}\\b`).test(
      normalized,
    )
  ) {
    return true
  }
  return /\b(?:solo|solamente|just) (?:explicame|explica|dime|explain|tell me)\b/.test(
    normalized,
  )
}

/** Explicit mutation of an existing project, including publish/version-control actions. */
export function isCodeWriteRequest(text: string): boolean {
  const normalized = normalizeCodeIntent(text)
  if (isCodeInformationRequest(text)) return false

  const writeVerb =
    "(?:cambia(?:r|lo|la|s)?|cambies|modifica(?:r|lo|la|s)?|modifiques|edita(?:r|lo|la|s)?|edites|corrige(?:lo|la|s)?|corrijas|corregir|arregla(?:r|lo|la|s)?|arregles|agrega(?:r|lo|la|s)?|agregues|anade(?:r|lo|la|s)?|anadas|incluye(?:lo|la|s)?|incluyas|incluir|elimina(?:r|lo|la|s)?|elimines|borra(?:r|lo|la|s)?|borres|quita(?:r|lo|la|s)?|quites|actualiza(?:r|lo|la|s)?|actualices|reemplaza(?:r|lo|la|s)?|reemplaces|renombra(?:r|lo|la|s)?|renombres|mueve(?:r|lo|la|s)?|muevas|instala(?:r|lo|la|s)?|instales|configura(?:r|lo|la|s)?|configures|sube|subir|subelo|subas|publica|publicar|publicalo|publiques|despliega|desplegar|despliegues|sincroniza|sincronizar|sincronices|commit|push|change|edit|update|delete|remove|publish|upload|deploy|fix|add|install|configure|rename|move|sync)"
  const directPrefix =
    "(?:(?:por favor|please) )?(?:(?:puedes|podrias|quiero que|necesito que|debes|vamos a|can you|could you) )?"
  if (new RegExp(`^${directPrefix}${writeVerb}\\b`).test(normalized)) return true
  if (new RegExp(`^${directPrefix}(?:haz|hagas|make|do) (?:un |a )?(?:commit|push)\\b`).test(normalized)) {
    return true
  }

  // A read/review step may precede the actual mutation in the same order:
  // "revisa el proyecto y luego súbelo a GitHub".
  return new RegExp(
    `\\b(?:y(?: luego)?|despues|entonces) (?:${directPrefix})?${writeVerb}\\b`,
  ).test(normalized)
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
  if (new RegExp(`^(?:(?:${GREET})(?: (?:${OPENER}))?|(?:${OPENER}))$`).test(t)) return true
  // Greeting + short vocative tail ("hola amigo", "hola sira", "hey bro",
  // "buenas equipo"): still a greeting, never a build. Without this, a social
  // message that slips past the classifiers falls through to the build engine
  // and spins a full run for a "hola". Tail is capped at 2 plain words and
  // must not carry app/data intent ("hola inventario" stays a real request).
  const vocative = t.match(new RegExp(`^(?:${GREET})((?: [a-z]{2,14}){1,2})$`))
  if (vocative && !APP_GOAL_CUE.test(vocative[1])) return true
  return false
}

/**
 * Conversational message: a question, doubt, meta-question or short social
 * phrase that must get a CHAT reply — never open the intake or generate
 * files. The build tiers treat "quiero/necesito" as build verbs (so "quiero
 * una tienda online" generates), which made "quiero preguntarte algo" build
 * an app; here a desire verb whose OBJECT is conversational (preguntar,
 * saber, hablar…) wins over that, and everything else defers to the build
 * markers: real build intent (verb + noun) always stays a build.
 */
export function isConversationalMessage(text: string): boolean {
  const raw = clean(text)
  if (!raw) return false
  if (raw.length > 400) return false // long specs are briefs, not questions
  if (isBuildLog(raw)) return false // error logs → SRE tier
  const t = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")

  // 1) Desire verb + conversational object beats the "quiero/necesito" build
  //    verb: "quiero preguntarte algo", "necesito saber si…", "quisiera
  //    entender cómo funciona".
  const DESIRE_CONVO =
    /\b(quiero|quisiera|necesito|me gustaria|deseo)\s+(?:hacerte\s+|hacerle\s+)?(preguntar(?:te|le)?|saber|entender|consultar(?:te)?|hablar|charlar|platicar|conversar|comentar(?:te)?|contar(?:te)?|decir(?:te)?|una\s+(?:pregunta|duda|consulta|explicacion)|ayuda(?:rme)?|apoyo|una mano|algo)\b/
  if (DESIRE_CONVO.test(t)) return true

  // 2) From here on, real build intent wins ("crea una app", "quiero una
  //    tienda online", "¿puedes crear una landing?" — all build).
  const buildish = BUILD_NOUN.test(t) || APP_GOAL_CUE.test(t)
  if (buildish && hasBuildVerb(raw)) return false

  // 3) Questions: a leading interrogative or any remaining "?" (build
  //    verb+noun combos were already claimed by the build tier above).
  const QUESTION_START =
    /^(?:¿\s*)?(que|como|cual(?:es)?|cuando|donde|por ?que|quien(?:es)?|cuant[oa]s?|puedes|podrias|sabes|hay|es posible|eres|tienes|para que|seria(?:s)? capaz|what|how|why|can you|could you|do you|are you)\b/
  if (QUESTION_START.test(t)) return true
  if (raw.includes("?")) return true

  // 4) Meta / acknowledgements / doubts without any build verb.
  const CONVO_MARKER =
    /\b(una pregunta|tengo una (?:duda|consulta|pregunta)|preguntarte|explicame|explicarme|explica(?:me)?|dime|cuentame|no entiendo|ayudame(?: a entender)?|ayuda|puedes ayudar(?:me)?|help(?: me)?|gracias|muchas gracias|ok(?:ey)?|vale|perfecto|entendido|genial|buen trabajo|excelente|de acuerdo)\b/
  if (CONVO_MARKER.test(t) && !hasBuildVerb(raw)) return true

  return false
}

/**
 * A conversational /code turn that still needs the read-only web toolchain.
 *
 * CEO Office deliberately keeps ordinary chat on the low-latency plain stream,
 * but a pasted URL or an explicit request to search/read the public web is not
 * ordinary small-talk. Those turns request deterministic server-side web
 * grounding before the same plain stream runs. The general agent toolset stays
 * disabled so untrusted pages cannot reach shell, files or private connectors.
 */
export function needsWebTools(text: string): boolean {
  const raw = clean(text)
  if (!raw) return false
  if (/\bhttps?:\/\/[^\s<>"')\]]+/i.test(raw)) return true

  const normalized = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")

  const webTarget =
    /\b(?:internet|web|google|navegador|browser|sitio|website|pagina|url|enlace|link)\b/
  const publicCodeHost =
    /\b(?:github|gitlab|bitbucket|codeberg|sourceforge)\b/
  const readAction =
    /\b(?:busca|buscar|buscame|investiga|investigar|consulta|consultar|verifica|verificar|revisa|revisar|accede|acceder|abre|abrir|lee|leer|navega|navegar|raspa|scrapea|scrapear|search|browse|fetch|open|read)\b/
  const localCodeOperation =
    /\b(?:workspace|codigo local|repositorio local|repo local|proyecto local|mi proyecto|este proyecto|esta aplicacion|archivos? locales?|working tree|rama local)\b/
  const codeHostWriteAction =
    /\b(?:sube|subir|subelo|publica|publicar|publicalo|push|commit|clona|clonar|clone|sincroniza|sincronizar|despliega|desplegar|deploy)\b/
  const publicDomain =
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+(?:com|org|net|edu|gov|io|ai|co|pe|bo|es|mx|ar|cl|dev|app)(?:\/[^\s]*)?\b/
  const discoveryAction =
    /\b(?:busca|buscar|buscame|investiga|investigar|research|search|googlea|googlear)\b/
  const localCodeTarget =
    /\b(?:codigo|code|bug|error|proyecto|project|workspace|repositorio|repo|archivo|file|componente|component)\b/
  const freshFact =
    /\b(?:hoy|actual|actualmente|reciente|ultimo|ultimos|noticias|clima|precio|precios|cotizacion|competidor|competidores|mercado|latest|current|today|news|weather|price|prices)\b/

  if (webTarget.test(normalized) && readAction.test(normalized)) return true
  if (
    publicCodeHost.test(normalized)
    && readAction.test(normalized)
    && !localCodeOperation.test(normalized)
    && !codeHostWriteAction.test(normalized)
  ) {
    return true
  }
  if (publicDomain.test(normalized) && readAction.test(normalized)) return true
  if (discoveryAction.test(normalized) && !localCodeTarget.test(normalized)) return true
  return freshFact.test(normalized) && (readAction.test(normalized) || raw.includes("?"))
}

type WebConversationTurn = Readonly<{ role: string; content: string }>

const WEB_FOLLOW_UP_ACK =
  /^(?:(?:si|yes|claro(?: que si)?|dale|ok(?:ey)?|vale|de acuerdo)(?: (?:(?:hazlo|buscalo|investigalo|consultalo|verificalo|abrelo|leelo|busca|investiga|consulta|verifica|abre|lee|procede|adelante)(?: ya| ahora)?|go ahead|do it))?|(?:hazlo|buscalo|investigalo|consultalo|verificalo|abrelo|leelo|busca|investiga|consulta|verifica|abre|lee|procede|adelante)(?: ya| ahora)?|go ahead|do it)$/
const WEB_ACTION_OR_TARGET =
  /\b(?:busca|buscar|busco|busque|investiga|investigar|consulta|consultar|verifica|verificar|accede|acceder|abre|abrir|lee|leer|navega|navegar|github|gitlab|bitbucket|codeberg|sourceforge|internet|web|sitio|website|url|enlace|link|repositorio|repo|search|browse|fetch|open|read)\b/
const WEB_OFFER =
  /\b(?:quieres|deseas|prefieres|puedo|podria|debo|hago|lo busco|lo investigo|lo consulto|lo verifico|lo abro|lo leo|shall i|should i|want me to|would you like me to)\b/
const DEICTIC_WEB_TARGET =
  /\b(?:su|sus|ese|esa|eso|este|esta|esto|aquel|aquella|ella|ello|dicho|dicha|anterior)\b/

function normalizeWebFollowUp(text: string): string {
  return clean(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¡!¿?.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function isWebFollowUpAck(text: string): boolean {
  const normalized = normalizeWebFollowUp(text)
    .replace(/\b(?:por favor|please)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return WEB_FOLLOW_UP_ACK.test(normalized)
}

function normalizePublicHostname(hostname: string): string | null {
  const normalized = hostname.toLowerCase().replace(/^www\./, "")
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+(?:com|org|net|edu|gov|io|ai|co|pe|bo|es|mx|ar|cl|dev|app)$/.test(
    normalized,
  )
    ? normalized
    : null
}

function lastPublicHostname(turns: ReadonlyArray<WebConversationTurn>): string | null {
  let userTurnsWithoutTarget = 0
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (!turn || turn.role !== "user") continue
    const content = clean(turn.content)
    if (!content) continue

    const urls = content.match(/https?:\/\/[^\s<>"')\]]+/gi) || []
    for (let urlIndex = urls.length - 1; urlIndex >= 0; urlIndex -= 1) {
      try {
        const hostname = normalizePublicHostname(
          new URL(urls[urlIndex].replace(/[.,;:!?]+$/g, "")).hostname,
        )
        if (hostname) return hostname
      } catch {
        // Keep looking for another explicit public target.
      }
    }

    const domains = content.match(
      /\b(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+(?:com|org|net|edu|gov|io|ai|co|pe|bo|es|mx|ar|cl|dev|app)\b/gi,
    )
    if (domains?.length) return normalizePublicHostname(domains[domains.length - 1])

    // Do not inherit a hostname across an unrelated user topic. A single
    // acknowledgement may bridge the immediately preceding public-web target,
    // but arbitrary older domains are never carried into a new lookup.
    userTurnsWithoutTarget += 1
    if (!isWebFollowUpAck(content) || userTurnsWithoutTarget > 1) return null
  }
  return null
}

function resolveDeicticWebTarget(
  request: string,
  priorTurns: ReadonlyArray<WebConversationTurn>,
): string {
  if (/\bhttps?:\/\//i.test(request)) return request
  if (!DEICTIC_WEB_TARGET.test(normalizeWebFollowUp(request))) return request
  const hostname = lastPublicHostname(priorTurns)
  return hostname ? `${request}\nObjetivo público referido: ${hostname}` : request
}

/**
 * Resolve the safe public-web query for the current /code turn.
 *
 * This keeps multi-turn confirmations such as "sí" in read-only web mode
 * instead of letting them fall into the code engine. Only the latest explicit
 * web request and, when needed, one public hostname are carried forward; the
 * full chat transcript and private workspace context never leave this scope.
 */
export function buildWebGroundingQuery(
  text: string,
  turns: ReadonlyArray<WebConversationTurn>,
): string | null {
  const raw = clean(text)
  if (!raw) return null

  // Resolve contextual confirmations before treating words such as "busca"
  // as a new, targetless lookup. This preserves the previous public objective.
  if (isWebFollowUpAck(raw)) {
    let previousIndex = turns.length - 1
    while (previousIndex >= 0 && !clean(turns[previousIndex]?.content || "")) previousIndex -= 1
    const previous = previousIndex >= 0 ? turns[previousIndex] : null
    const previousNormalized = normalizeWebFollowUp(previous?.content || "")
    if (
      previous
      && previous.role === "assistant"
      && WEB_ACTION_OR_TARGET.test(previousNormalized)
      && WEB_OFFER.test(previousNormalized)
    ) {
      for (let index = previousIndex - 1; index >= 0; index -= 1) {
        const turn = turns[index]
        if (!turn || turn.role !== "user") continue
        const request = clean(turn.content)
        if (!request || !needsWebTools(request)) continue
        const resolved = resolveDeicticWebTarget(request, turns.slice(0, index))
        return `${resolved}\nEl usuario confirmó que se realice ahora. Responde con el resultado y no pidas otra confirmación.`
      }
    }
  }

  if (needsWebTools(raw)) {
    return resolveDeicticWebTarget(raw, turns)
  }

  return null
}

/**
 * A build ORDER with no content of its own: "ok, créala", "hazlo",
 * "constrúyela ya", "procede", "adelante". The substance lives in the
 * previous conversation — briefFromConversation() recovers it so the build
 * tiers never receive a contentless prompt.
 */
export function isBareBuildCommand(text: string): boolean {
  const raw = clean(text)
  if (!raw || raw.length > 60) return false
  const t = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¡!¿?.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (BUILD_NOUN.test(t) || APP_GOAL_CUE.test(t)) return false // has substance
  const ACK = "(?:ok(?:ey)?|dale|si|listo|va|vale|perfecto|de acuerdo|entonces)"
  const GO =
    "(?:crea(?:la|lo)?|hazla|hazlo|haz|construye(?:la|lo)?|construir|genera(?:la|lo)?|arma(?:la|lo)?|monta(?:la|lo)?|empieza|comienza|procede|adelante|manos a la obra|build it|do it|go ahead|make it)"
  const re = new RegExp(`^(?:${ACK}[ ]*)*${GO}(?:[ ]+(?:ya|ahora|con eso|con todo|porfa(?:vor)?|por favor|nomas|entonces|pues))*$`)
  return re.test(t)
}

/**
 * Recover the real brief from the recent conversation: the last (up to 3)
 * substantive USER messages — skipping greetings, bare build commands, chat
 * fillers and error logs; conversational turns are kept only when they carry
 * the idea (a build noun / app cue, e.g. "¿puedes hacer una app de pedidos
 * para mi cafetería?"). Returns null when nothing substantive exists.
 */
export function briefFromConversation(
  turns: ReadonlyArray<{ role: string; content: string }>,
): string | null {
  const parts: string[] = []
  for (let i = turns.length - 1; i >= 0 && parts.length < 3; i--) {
    const turn = turns[i]
    if (!turn || turn.role !== "user") continue
    const raw = clean(turn.content)
    if (!raw) continue
    if (isQuickGreeting(raw) || isBareBuildCommand(raw) || isBuildLog(raw)) continue
    const low = raw.toLowerCase()
    const carriesIdea = BUILD_NOUN.test(low) || APP_GOAL_CUE.test(raw)
    if (raw.length < 12 && !carriesIdea) continue
    if (isConversationalMessage(raw) && !carriesIdea) continue
    parts.unshift(raw)
  }
  return parts.length ? parts.join(". ") : null
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

  // 2) Dependency mode is constructive: edit package.json/lockfile, install,
  //    then verify. It should never be treated as a passive Ask answer.
  if (signal.mode === "deps") {
    return { type: "patch", instruction: text }
  }

  // 3) Non-constructive modes → plain chat, ALWAYS. Ask/Plan/Image must NEVER
  //    write files — even after a build (phase "preview") or when the user pastes
  //    an error log — otherwise Ask silently turns a question into a patch/debug.
  //    This check stays ABOVE the preview-patch and pasted-log-debug rules below.
  if (signal.mode === "ask" || signal.mode === "plan" || signal.mode === "image") {
    return { type: "passthrough" }
  }

  // 4) Debug: explicit debug mode, or a pasted error log in a constructive mode.
  if (signal.mode === "debug" || isBuildLog(text)) return { type: "debug", log: text }

  // 5) ⚡ Construir → generate immediately.
  if (signal.forceDeterministic) {
    return { type: "generate", context: seedGoal(state.context, text), tier: "deterministic" }
  }

  // 6) Informational intent stays read-only in every app/build phase.
  // Explicit write requests phrased as questions ("¿puedes cambiar...?") are
  // excluded and continue to the mutation classifier below.
  if (
    isCodeInformationRequest(text)
    || (isConversationalMessage(text) && !isCodeWriteRequest(text))
  ) {
    return { type: "passthrough" }
  }

  // 7) Iterating on an already-built app.
  if (state.phase === "preview" && !isBuildRequest(text) && text.length > 0) {
    return { type: "patch", instruction: text }
  }

  if (
    (signal.mode === "app" || signal.mode === "build")
    && isCodeWriteRequest(text)
  ) {
    return { type: "patch", instruction: text }
  }

  const inIntake = state.phase === "intake"
  const isBuildSeed =
    isBuildRequest(text) ||
    hasBuildVerb(text) ||
    BUILD_NOUN.test(text.toLowerCase()) ||
    (signal.mode === "app" && text.length > 80)
  const isStart = (signal.mode === "app" || signal.mode === "build") && isBuildSeed

  // 8) Intake/build gate.
  if (isStart || inIntake) {
    if (inIntake) {
      const idx = Math.max(0, state.intakeStep - 1) // the slot we just asked about
      const ctx = fillSlot(state.context, idx, text)
      return { type: "generate", context: seedAutonomousBrief(ctx, text), tier }
    }

    return { type: "generate", context: seedAutonomousBrief(state.context, text), tier }
  }

  // 9) Default (e.g. app-mode follow-up that is not a build request).
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

export interface AgentWorkspaceFile {
  path: string
  content: string
}

export type AgentWorkspaceFiles = Record<string, AgentWorkspaceFile>

const EXACT_READY_MARKER = /\b[A-Z][A-Z0-9_]{4,120}_READY\b/g

function jsxText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function stripInstructionValue(value: string): string {
  return clean(value)
    .replace(/^[`"'“”‘’]+|[`"'“”‘’.,;:]+$/g, "")
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function extractExactDisplayTextInstruction(input: string): string | null {
  const text = clean(input)
  const direct = text.match(
    /(?:texto|marcador|frase|t[ií]tulo|headline|principal)[^.\n]{0,140}?\b(?:a|por|como|sea|mostrar(?:\s+el)?|muestre(?:\s+el)?|debe\s+(?:ser|mostrar))\s+[`"'“”‘’]*([A-Z0-9][A-Z0-9_-]{3,120})/i,
  )
  const value = direct?.[1] ? stripInstructionValue(direct[1]) : null
  if (value && /^[A-Z0-9_-]{4,120}$/.test(value)) return value

  const marker = text.match(EXACT_READY_MARKER)
  return marker?.[0] ?? null
}

function extractVisibleCardInstruction(input: string): { title: string; detail?: string } | null {
  const text = clean(input)
  const match = text.match(
    /(?:agrega|a[ñn]ade|incluye|crea|pon)\s+(?:una\s+)?tarjeta(?:\s+visible)?(?:\s+(?:llamada|titulada|con\s+t[ií]tulo))?\s+(.+?)(?:\s+(?:con|y)\s+(.+))?$/i,
  )
  if (!match?.[1]) return null
  const title = stripInstructionValue(match[1]).slice(0, 80)
  const detail = match[2] ? stripInstructionValue(match[2]).slice(0, 160) : undefined
  if (!title) return null
  return { title, detail }
}

function isNextProject(files: AgentWorkspaceFiles): boolean {
  const appPage = files["app/page.tsx"]
  const pkg = files["package.json"]?.content || ""
  return !!appPage && /"next"\s*:|"dev"\s*:\s*"[^"]*next\s+dev/i.test(pkg)
}

function replaceExactDisplayText(page: string, marker: string): string {
  const exactNode = /(<[A-Za-z0-9]+\b[^>]*data-testid=["']required-output["'][^>]*>)([\s\S]*?)(<\/[A-Za-z0-9]+>)/m
  if (exactNode.test(page)) {
    return page.replace(exactNode, `$1${jsxText(marker)}$3`)
  }

  EXACT_READY_MARKER.lastIndex = 0
  if (EXACT_READY_MARKER.test(page)) {
    EXACT_READY_MARKER.lastIndex = 0
    return page.replace(EXACT_READY_MARKER, marker)
  }
  EXACT_READY_MARKER.lastIndex = 0

  const requiredNode = `      <p className="card" data-testid="required-output">${jsxText(marker)}</p>\n`
  if (/      <\/div>\n/.test(page)) {
    return page.replace(/(      <\/div>\n)/, `$1${requiredNode}`)
  }
  return page.replace(/(    <\/section>)/, `${requiredNode}$1`)
}

function buildVisibleCard(card: { title: string; detail?: string }): string {
  const critical = /cr[ií]tic/i.test(`${card.title} ${card.detail || ""}`)
  const testId = /\bsla\b/i.test(card.title) ? "sla-critical-card" : "agentic-added-card"
  const detail = card.detail || (critical ? "Estado crítico que requiere atención inmediata." : "Tarjeta agregada desde el chat.")
  return [
    `      <div className="card" data-testid="${testId}">`,
    `        <h3>${jsxText(card.title)}</h3>`,
    `        <p>${jsxText(detail)}</p>`,
    critical ? "        <strong>ESTADO CRÍTICO</strong>" : null,
    "      </div>",
  ].filter((line): line is string => line !== null).join("\n")
}

function ensureVisibleCard(page: string, card: { title: string; detail?: string }): string {
  const titlePattern = new RegExp(escapeRegExp(card.title), "i")
  if (titlePattern.test(page)) return page

  const cardBlock = `${buildVisibleCard(card)}\n`
  if (/(      <div className="grid">\n)/.test(page)) {
    return page.replace(/(      <div className="grid">\n)/, `$1${cardBlock}`)
  }
  return page.replace(/(    <\/section>)/, `${cardBlock}$1`)
}

export function buildDeterministicPreviewPatches(
  files: AgentWorkspaceFiles,
  instruction: string,
): Array<{ path: string; content: string }> {
  if (!isNextProject(files)) return []

  const appPage = files["app/page.tsx"]
  let next = appPage.content
  const exactText = extractExactDisplayTextInstruction(instruction)
  const card = extractVisibleCardInstruction(instruction)

  if (exactText) next = replaceExactDisplayText(next, exactText)
  if (card) next = ensureVisibleCard(next, card)

  if (next === appPage.content) return []
  return [{ path: appPage.path, content: next }]
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
      siguientePaso: "Reintento la instalación automáticamente en el preview.",
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
      siguientePaso: "Reinstalo automáticamente en el preview.",
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
      siguientePaso: "Reintento automáticamente tras ajustar el lockfile.",
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
        "Proyecto Vite/Node: añade el paquete a `dependencies` en `package.json`; el preview reintentará la instalación automáticamente. Preview estático: quita el `import` y cárgalo por CDN (`<script src=…>`), o usa una alternativa ya disponible (React/Tailwind están globales).",
      siguientePaso: "Aplica el cambio; el preview reintentará automáticamente si es un proyecto Node, o se actualizará en vivo si es estático.",
    }
  }

  // Prisma schema reserved model names (e.g. `model Prisma`) generated from
  // stack words in a prompt. This is code/config generated by the builder and
  // can be fixed deterministically by renaming the model plus client accessor.
  const reservedModels = Array.from(text.matchAll(/-\s+"model\s+([A-Za-z_][A-Za-z0-9_]*)"/g)).map((m) => m[1])
  if (/reserved keywords|contains reserved keywords/i.test(text) && reservedModels.length > 0) {
    const renames = Object.fromEntries(
      reservedModels.map((model) => [model, /Record$/.test(model) ? `${model}Item` : `${model}Record`]),
    )
    return {
      matched: true,
      category: "prisma_reserved_model",
      diagnostico: "Prisma rechazó el schema porque contiene un nombre de modelo reservado.",
      quePasaba:
        `El schema declaró ${reservedModels.map((m) => `\`model ${m}\``).join(", ")}, y Prisma reserva ese identificador para su runtime interno.`,
      causaRaiz:
        "Es un fallo del generador: interpretó palabras técnicas del prompt como entidades de datos y produjo un modelo inválido.",
      arreglo:
        "Renombrar el/los modelos reservados en `prisma/schema.prisma` y actualizar las referencias del Prisma Client en rutas/seed.",
      siguientePaso: "Aplico el parche y reintento el preview automáticamente.",
      suggestedPrismaModelRenames: renames,
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
    siguientePaso: "Tras ajustar, reintento el build/preview automáticamente.",
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
