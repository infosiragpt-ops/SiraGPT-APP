/**
 * workspace-auth — real auth-state detection for the /code Auth tool.
 *
 * Pure/deterministic: scans the workspace file map for authentication
 * indicators (libraries, API routes, JWT usage, login forms) so the tool can
 * show whether the app ACTUALLY has login, with file evidence — and build the
 * agent instruction that implements it honoring the user's toggles.
 */

type FileLike = { content?: string }

export type AuthEvidence = { path: string; hint: string }

export type WorkspaceAuthState = {
  hasAuth: boolean
  evidence: AuthEvidence[]
}

const CONTENT_HINTS: Array<{ re: RegExp; hint: string }> = [
  { re: /next-auth|@auth\/core|@auth\/nextjs/i, hint: "NextAuth / Auth.js" },
  { re: /@clerk\//i, hint: "Clerk" },
  { re: /supabase[^\n]{0,40}\.auth\./i, hint: "Supabase Auth" },
  { re: /firebase\/auth|getAuth\(/i, hint: "Firebase Auth" },
  { re: /\bpassport\b/i, hint: "Passport.js" },
  { re: /\blucia\b/i, hint: "Lucia" },
  { re: /jsonwebtoken|jwt\.sign\(|jwt\.verify\(/i, hint: "JWT" },
  { re: /\bbcrypt(js)?\b/i, hint: "hash de contraseñas (bcrypt)" },
  { re: /type=["']password["']/i, hint: "formulario con campo password" },
]

const PATH_HINTS: Array<{ re: RegExp; hint: string }> = [
  { re: /(^|\/)app\/api\/auth\//, hint: "ruta API de auth" },
  { re: /(^|\/)(login|signin|sign-in|register|signup|sign-up)\.(t|j)sx?$/i, hint: "pantalla de login/registro" },
  { re: /(^|\/)middleware\.(t|j)s$/, hint: "middleware (posible protección de rutas)" },
]

/** Detect whether the workspace app has real authentication code. */
export function detectWorkspaceAuth(
  files: Record<string, FileLike | string> | null | undefined,
): WorkspaceAuthState {
  if (!files || typeof files !== "object") return { hasAuth: false, evidence: [] }
  const evidence: AuthEvidence[] = []
  const seen = new Set<string>()
  const push = (path: string, hint: string) => {
    const key = `${path}:${hint}`
    if (seen.has(key)) return
    seen.add(key)
    evidence.push({ path, hint })
  }
  for (const [path, file] of Object.entries(files)) {
    for (const { re, hint } of PATH_HINTS) {
      if (re.test(path)) push(path, hint)
    }
    const content = typeof file === "string" ? file : file?.content
    if (typeof content !== "string" || !content) continue
    for (const { re, hint } of CONTENT_HINTS) {
      if (re.test(content)) push(path, hint)
    }
  }
  // A middleware file alone isn't auth — require at least one non-middleware signal.
  const strong = evidence.filter((row) => !row.hint.startsWith("middleware"))
  return { hasAuth: strong.length > 0, evidence: evidence.slice(0, 20) }
}

export type AuthPrefs = {
  email: boolean
  google: boolean
  github: boolean
  requireVerifiedEmail: boolean
  sessionDays: number
}

/** Build the agent instruction that implements login per the tool's toggles. */
export function buildAuthAgentPrompt(prefs: AuthPrefs): string {
  const providers = [
    prefs.email ? "email y contraseña" : null,
    prefs.google ? "Google OAuth" : null,
    prefs.github ? "GitHub OAuth" : null,
  ].filter(Boolean)
  const providerText = providers.length > 0 ? providers.join(", ") : "email y contraseña"
  const days = Math.max(1, Math.min(90, Math.round(prefs.sessionDays || 30)))
  return [
    `Implementa autenticación en la app de este workspace con login por ${providerText}.`,
    `Incluye pantalla de login/registro, manejo de sesión con expiración de ${days} día(s) y protección de las rutas privadas.`,
    prefs.requireVerifiedEmail ? "Requiere email verificado antes de permitir el acceso." : null,
    "Usa la estructura y stack existentes del proyecto (no lo migres a otro framework) y deja la app funcionando.",
  ]
    .filter(Boolean)
    .join(" ")
}

/** Agent instruction to run an Automations rule right now. */
export function buildAutomationAgentPrompt(label: string): string {
  const clean = String(label || "").trim().slice(0, 200)
  return [
    `Ejecuta ahora esta automatización del workspace: "${clean}".`,
    "Revisa el proyecto, realiza las acciones que correspondan y termina con un resumen corto de lo que hiciste y lo que encontraste.",
  ].join(" ")
}
