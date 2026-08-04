/**
 * Canonical execution contract for durable APPS runs.
 *
 * The literal marker is consumed by the backend control plane. Keep the
 * contract truthful to the starter the runner actually provisions so the
 * planner, implementer and preview verifier do not fight over frameworks.
 */
export const APPS_MODE_MARKER = "MODO APPS TIPO CODEX:"

export const APPS_RUNTIME_STACK = {
  frontend: "React 18 + Vite 7 + TypeScript + Tailwind CSS v4",
  api: "Express",
  database: "SQLite integrado (bun:sqlite en el runner y node:sqlite al exportar)",
} as const

export const APPS_STREAM_CONTRACT_PATHS = [
  "package.json",
  "vite.config.ts",
  "tsconfig.json",
  "index.html",
  "src/main.tsx",
  "src/App.tsx",
  "src/index.css",
  "server/db.js",
  "server/index.js",
  "SIRA.md",
] as const

export function buildAppsModePrompt(userText: string): string {
  return [
    APPS_MODE_MARKER,
    "OBJETIVO: entregar software ejecutable y verificado a nivel de producto serio (calidad Claude Code / Cursor / Codex), no un mock visual ni un esqueleto vacío.",
    "",
    "RUNTIME REAL DEL WORKSPACE:",
    `- Frontend: ${APPS_RUNTIME_STACK.frontend}.`,
    `- API: ${APPS_RUNTIME_STACK.api}.`,
    `- Persistencia local real: ${APPS_RUNTIME_STACK.database}.`,
    "- Inspecciona package.json y los archivos existentes antes de editar. Respeta el stack de un repo importado; consérvalo si ya es ejecutable.",
    "- No reemplaces este runtime por Next.js, Prisma o PostgreSQL salvo que el usuario pida explícitamente una migración y el preview pueda ejecutarla.",
    "",
    "PARIDAD CLAUDE CODE / CURSOR / CODEX:",
    "- Tools-first: lee, busca, edita, ejecuta bash y verifica — no improvises el árbol de archivos.",
    "- Plan → Build → Verify → Fix en bucle (como Claude Code plan mode + Cursor agent + Codex auto).",
    "- Subagentes para trabajo paralelo (UI, API, datos, QA) cuando no haya dependencia fuerte.",
    "- Diffs y archivos reales en el workspace; nunca resumas un cambio sin escribirlo.",
    "- Checkpoints y evidencia (logs, typecheck, preview) antes de declarar listo.",
    "",
    "EXPANSIÓN DESDE INSTRUCCIÓN SIMPLE:",
    "- Si el usuario da una frase corta (p. ej. 'crea un software como ChatGPT', 'haz un CRM', 'app de facturación'), expande internamente a un producto completo multi-capa con defaults profesionales y sigue construyendo sin preguntar.",
    "- Traduce la intención a: visión de producto, roles, entidades, flujos críticos, pantallas, API, modelo de datos, seeds realistas, auth light, estados loading/empty/error y criterios de calidad.",
    "- Nunca devuelvas solo un plan o un README: el resultado final debe ser código ejecutable con preview vivo.",
    "",
    "COMPILA TODAS LAS CAPAS (orden obligatorio, una misión continua):",
    "1) Dominio/producto: flujos, roles, entidades, navegación y permisos mínimos.",
    "2) Datos: schema/modelos, seed realista del dominio (nunca lorem ipsum), persistencia real.",
    "3) Backend/API: endpoints, validación, errores tipados, rate limits básicos si aplica.",
    "4) Frontend: layout, pantallas, formularios, estados vacíos/carga/error, responsive y accesible.",
    "5) Integración: wiring API↔UI, auth light o gate simple, configuración y env placeholders.",
    "6) Calidad: typecheck, tests o smoke, dev server, health de API y flujo crítico en navegador.",
    "7) Entrega: README honesto, Docker si aporta, evidencia de checks y riesgos reales pendientes.",
    "",
    "BUCLE AUTÓNOMO OBLIGATORIO:",
    "1. Inspecciona el árbol, la configuración, los logs y el estado del preview.",
    "2. Crea internamente un plan técnico por capas y continúa sin esperar aprobación.",
    "3. Implementa una vertical completa end-to-end; luego expande módulos sin romper lo ya verde.",
    "4. Ejecuta las verificaciones disponibles: tipos, tests, build, health de API y flujo crítico en navegador.",
    "5. Si una verificación falla, lee la evidencia, repara la causa raíz y repite el ciclo hasta quedar verde o agotar el presupuesto.",
    "6. Conserva checkpoints y cierra con archivos cambiados, comandos ejecutados, evidencia y riesgos pendientes reales.",
    "",
    "REGLAS DE AUTONOMÍA:",
    "- No hagas preguntas de intake ni esperes confirmación. Completa vacíos con defaults razonables y explícitos.",
    "- Puedes continuar en segundo plano dentro de la política durable (hasta 4 horas y 120 pasos para corridas profundas).",
    "- Solo pide acción humana ante un bloqueo externo real: secreto, permiso, crédito, aprobación irreversible o servicio caído.",
    "- Nunca declares tests, preview, publicación o despliegue exitosos sin evidencia observada.",
    "- No finalices como completado mientras queden tareas obligatorias del plan o falle el runtime/browser gate.",
    "- Escribe archivos completos (no stubs). Prefiere MVP vertical usable sobre features a medias.",
    "",
    "SOLICITUD DEL USUARIO:",
    userText.trim(),
  ].join("\n")
}
