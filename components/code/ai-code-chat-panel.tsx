"use client"

/**
 * AICodeChatPanel — coding chat column for the /code workspace. A focused
 * coding chat that:
 *
 *   - Sends the user's prompt to the existing AI streaming endpoint
 *     (`apiClient.generateAIStream`), reusing the same auth/ token
 *     plumbing the rest of the app already uses.
 *   - Auto-prepends a small system-style hint so the model knows it
 *     is working inside an in-memory workspace and which files are
 *     open. The user can opt-out with the "Sin contexto" toggle.
 *   - Renders model output as markdown-ish text and parses fenced
 *     code blocks. Each block becomes a card with copy + apply +
 *     diff actions, mediated by the workspace context so the editor
 *     and preview update atomically.
 *
 * We deliberately keep this self-contained: no shared state with the
 * /chat page so a refresh on /code is fast and the user's main chat
 * history is unaffected.
 */

import * as React from "react"
import {
  AlertTriangle,
  ArrowUp,
  BookOpen,
  BrainCircuit,
  Bug,
  Check,
  ChevronDown,
  Clock3,
  CircleHelp,
  ExternalLink,
  FileCode2,
  History,
  Image as ImageIcon,
  LayoutGrid,
  ListChecks,
  PackagePlus,
  Plus,
  Rocket,
  Search,
  Server,
  Sparkles,
  StopCircle,
} from "lucide-react"
import { BrowserVoicePlayer } from "@/components/code/browser-voice-player"
import { tierForModelChoice } from "@/lib/codex/model-tiers"
import { pullProjectFiles } from "@/lib/code-agent/codex-file-pull"
import { buildSpokenSummary } from "@/lib/code-agent/spoken-summary"
import { CodeChatErrorBoundary } from "@/components/code/code-chat-error-boundary"
import { toast } from "sonner"

import { DictationButton } from "@/components/codex/dictation-button"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { apiClient } from "@/lib/api"
import { normalizeChatInput, shouldWarnUser } from "@/lib/chat-input-normalize"
import { useAuth } from "@/lib/auth-context-integrated"
import { useChat } from "@/lib/chat-context-integrated"
import { CODE_OPEN_TOOL_LAUNCHER_EVENT, useCodeWorkspace } from "@/lib/code-workspace-context"
import { intakeService, type GenerateResult, type ScaffoldFile } from "@/lib/builder/intake-service"
import type { CodeAgentPhase, CodeChatTurn } from "@/lib/code-chat-sessions"
import { computeLineDiff, parseCodeBlocks, type CodeBlock } from "@/lib/code-workspace-utils"
import { detectBlocker } from "@/lib/code-chat-blocker"
import { extractPlanLabel } from "@/lib/code-chat-plan-label"
import {
  buildWriteMetrics,
  formatUsd,
  formatWorked,
  glyphForAction,
  type CodeChatAction,
  type CodeChatMetrics,
} from "@/lib/code-chat-metrics"
import { defaultAgentState, type AgentBuildContext, type AgentPhase, type BuildErrorVerdict } from "@/lib/code-agent/types"
import {
  classifyBuildError,
  buildDeterministicPreviewPatches,
  isBuildRequest,
  briefFromConversation,
  isBareBuildCommand,
  isConversationalMessage,
  isQuickGreeting,
  mergeOverridesIntoPackageJson,
  nextAgentAction,
  promptFromContext,
  renderFiveSections,
} from "@/lib/code-agent/orchestrator"
import {
  FULL_STACK_APP_CONTRACT_PATHS,
  engineTransportInstructions,
  landingSystemPrompt,
  sreSystemPrompt,
  streamOutputFormat,
} from "@/lib/code-agent/prompts"
import { isSlowModel, recommendFastModel } from "@/lib/code-agent/model-policy"
import { opencodeService } from "@/lib/opencode/opencode-service"
import { useOpencodeEngine } from "@/lib/opencode/use-opencode-engine"
import { codexApi } from "@/lib/codex/codex-api"
import { openRunStream } from "@/lib/codex/run-stream"
import { useCodexHealth } from "@/lib/codex/use-codex-health"
import {
  codexLiveActionsMarkdown,
  codexLiveContent,
  foldCodexEvent,
  initialCodexEngineFold,
  type CodexEngineFoldState,
} from "@/lib/code-agent/codex-engine-mapping"
import {
  CODE_SELECT_TARGET_EVENT,
  CODE_SELECTION_CANCEL_EVENT,
  CODE_SELECTION_CAPTURED_EVENT,
  type CodePreviewSelectionCancelDetail,
  type CodePreviewSelectionDetail,
} from "@/lib/code-preview-selection"

import { DiffView } from "./diff-view"

import { DotmCircular15, THINKING_GLYPH_COLOR } from "@/components/ui/dotm-circular-15"

type ComposerMode = "app" | "build" | "deps" | "plan" | "debug" | "ask" | "image"

const CODE_OPEN_PREVIEW_EVENT = "siragpt:code-open-preview"
const CODE_RUN_PREVIEW_EVENT = "siragpt:code-run-preview"

function CodeTargetSelectIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="3.75"
        y="3.75"
        width="14"
        height="14"
        rx="2.75"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="2.9 3.8"
      />
      <path
        d="M8.32 6.34c-.28-.78.54-1.48 1.26-1.08l10.2 5.72c.72.4.64 1.46-.12 1.75l-3.74 1.41c-.24.09-.43.28-.52.52l-1.41 3.74c-.29.77-1.35.84-1.75.12L8.32 6.34Z"
        fill="currentColor"
      />
    </svg>
  )
}

// Coalesce the (possibly many) file-apply batches an agent emits within a
// single turn into ONE forced preview restart. We deliberately do NOT gate on
// whether THIS batch contains a package.json: editing a file inside an
// already-open Vite/Next project or a cloned GitHub repo must still refresh the
// preview. PreviewPane owns the decision of whether a dev server is actually
// needed (real node project / bound repo) vs a static srcdoc preview, so the
// owner never has to press ▶ Ejecutar.
let autoRunDebounceTimer: ReturnType<typeof setTimeout> | null = null
let autoRunKeySeq = 0

function openPreviewAndMaybeRun(_files: Array<{ path: string; content: string }>): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(CODE_OPEN_PREVIEW_EVENT))
  if (autoRunDebounceTimer) clearTimeout(autoRunDebounceTimer)
  autoRunDebounceTimer = setTimeout(() => {
    autoRunDebounceTimer = null
    autoRunKeySeq += 1
    const detail = { source: "agent", auto: true, force: true, runKey: autoRunKeySeq }
    window.dispatchEvent(new CustomEvent(CODE_RUN_PREVIEW_EVENT, { detail }))
    window.dispatchEvent(new CustomEvent("siragpt:code-run-app", { detail }))
  }, 600)
}

function escapeGeneratedHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

// Wrap a /code build order in the Codex "APPS mode" envelope. The backend
// agent-loop keys `appsMode` off the literal "MODO APPS TIPO CODEX" marker —
// without it, the run neither forces the Vite SPA stack nor runs the
// ensureAppsVitePreviewable auto-repair, so the agent drifts into broken
// React/Next+Vite hybrids that render an error overlay. Same envelope the
// /apps composer uses (components/codex/codex-agent-panel.tsx).
function buildAppsModePrompt(userText: string): string {
  return [
    "MODO APPS TIPO CODEX:",
    "- No hagas preguntas de intake ni esperes confirmacion del usuario.",
    "- Si falta contexto, propone internamente un brief completo con defaults razonables.",
    "- Primero genera un plan tecnico concreto; si la ejecucion continua, construye, prueba/itera y entrega el resultado en preview/codigo.",
    "- Solo pide accion del usuario si hay un bloqueo externo real: creditos, secreto, permisos o servicio caido.",
    "",
    "SOLICITUD DEL USUARIO:",
    userText,
  ].join("\n")
}

function selectionValue(value: unknown, max = 240): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  if (!text) return "sin dato"
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function buildSelectedElementPrompt(detail: CodePreviewSelectionDetail, existingInstruction: string): string {
  const rect = detail.rect
    ? `${detail.rect.width}x${detail.rect.height} en x:${detail.rect.x}, y:${detail.rect.y}`
    : "sin dato"
  const point = detail.relativePoint
    ? `${detail.relativePoint.percentX}% / ${detail.relativePoint.percentY}% del preview`
    : "sin dato"
  const parent = detail.parent
    ? `${selectionValue(detail.parent.selector, 160)} · ${selectionValue(detail.parent.text, 180)}`
    : "sin dato"
  const currentInstruction = existingInstruction.trim()
  return [
    "Modifica el elemento que acabo de seleccionar en el preview de APPS.",
    "",
    "Elemento seleccionado:",
    `- método de selección: ${selectionValue(detail.selectionMethod || "dom", 80)}`,
    `- selector CSS: ${selectionValue(detail.selector)}`,
    `- etiqueta: ${selectionValue(detail.tagName, 80)}`,
    `- texto visible: ${selectionValue(detail.text)}`,
    `- contenedor padre: ${parent}`,
    `- clases: ${selectionValue(detail.className)}`,
    `- id: ${selectionValue(detail.id, 120)}`,
    `- role/aria: ${selectionValue([detail.role, detail.ariaLabel].filter(Boolean).join(" / "), 160)}`,
    `- href/src: ${selectionValue([detail.href, detail.src].filter(Boolean).join(" / "), 180)}`,
    `- caja visual: ${rect}`,
    `- punto relativo: ${point}`,
    `- preview: ${selectionValue(detail.previewKind, 80)} · ${selectionValue(detail.entry || detail.pageUrl, 180)}`,
    `- archivo activo probable: ${selectionValue(detail.activePath, 180)}`,
    "",
    currentInstruction
      ? `Cambio solicitado por el usuario:\n${currentInstruction}`
      : "Cambio solicitado:\n",
    "",
    detail.selectionMethod === "region"
      ? "Si la selección vino como región visual, usa las coordenadas, el archivo activo y el texto visible del preview para localizar el componente más probable antes de editar."
      : "Usa el selector DOM y el contenedor padre para localizar el componente correcto antes de editar.",
    "Aplica el cambio en los archivos correctos del workspace, conserva el resto del diseño y verifica que el preview siga funcionando.",
  ].join("\n")
}

function compactGeneratedTitle(prompt: string, ctx?: AgentBuildContext): string {
  const raw = ctx?.brand || ctx?.productType || prompt || "Nueva app"
  const cleaned = raw
    .replace(/\b(crea|crear|creame|crearme|hazme|hacer|construye|construir|genera|generar|quiero|necesito|dame|una|un|app|landing|pagina|página|web)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
  const title = cleaned || raw || "Nueva app"
  return title.length > 64 ? `${title.slice(0, 61)}...` : title
}

function buildLocalIndexFallbackFiles(prompt: string, ctx?: AgentBuildContext): Array<{ path: string; content: string }> {
  const title = compactGeneratedTitle(prompt, ctx)
  const description = prompt.trim() || "App creada desde el chat de APPS."
  const featureText = ctx?.features || "Landing, captura de datos, estados claros y lista para iterar desde el chat"
  const entityText = ctx?.dataEntities || "Registros"
  const seedItems = [
    { title: "Ajustar contenido principal", status: "En progreso" },
    { title: "Agregar datos reales", status: "Pendiente" },
    { title: "Publicar cuando este listo", status: "Pendiente" },
  ]
  const storageKey = `siragpt-apps-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "index"}`
  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeGeneratedHtml(title)}</title>
  <style>
    :root { --accent: #FF0000; --ink: #111113; --muted: #6f7178; --line: #e9e9ec; --soft: #fff5f5; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: #fafafa; }
    .shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
    header { height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 28px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,.86); backdrop-filter: blur(16px); }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; letter-spacing: -.01em; }
    .mark { width: 28px; height: 28px; border-radius: 8px; background: var(--accent); box-shadow: 0 12px 30px rgba(255,0,0,.2); }
    .pill { border: 1px solid rgba(255,0,0,.18); background: var(--soft); color: #c40000; border-radius: 999px; padding: 7px 11px; font-size: 12px; font-weight: 700; }
    main { width: min(1120px, calc(100vw - 40px)); margin: 0 auto; padding: 56px 0; }
    .hero { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(320px, .85fr); gap: 28px; align-items: stretch; }
    .hero-copy { padding: 34px 0; }
    .eyebrow { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 18px; color: #c40000; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    h1 { max-width: 720px; margin: 0; font-size: clamp(42px, 7vw, 78px); line-height: .94; letter-spacing: -.055em; }
    .lead { max-width: 620px; margin: 22px 0 0; color: var(--muted); font-size: 18px; line-height: 1.65; }
    .actions { margin-top: 30px; display: flex; flex-wrap: wrap; gap: 12px; }
    .btn { border: 0; border-radius: 8px; background: var(--accent); color: white; padding: 13px 18px; font-weight: 800; box-shadow: 0 18px 34px rgba(255,0,0,.22); cursor: pointer; }
    .btn.secondary { background: white; color: var(--ink); border: 1px solid var(--line); box-shadow: none; }
    .panel { border: 1px solid var(--line); border-radius: 12px; background: white; box-shadow: 0 24px 70px rgba(17,17,19,.08); overflow: hidden; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid var(--line); }
    .panel-head strong { font-size: 14px; }
    .status { display: inline-flex; align-items: center; gap: 7px; color: #0f9f5f; font-size: 12px; font-weight: 800; }
    .dot { width: 7px; height: 7px; border-radius: 999px; background: currentColor; }
    form { display: grid; grid-template-columns: 1fr auto; gap: 10px; padding: 16px; }
    input { min-width: 0; height: 42px; border: 1px solid var(--line); border-radius: 8px; padding: 0 12px; font: inherit; outline: none; }
    input:focus { border-color: rgba(255,0,0,.45); box-shadow: 0 0 0 3px rgba(255,0,0,.08); }
    .list { display: grid; gap: 8px; padding: 0 16px 16px; }
    .item { display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fff; }
    .item span:first-child { font-weight: 700; }
    .tag { border-radius: 999px; background: #f4f4f5; color: var(--muted); padding: 5px 9px; font-size: 12px; font-weight: 700; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 28px; }
    .metric { border: 1px solid var(--line); border-radius: 10px; background: white; padding: 16px; }
    .metric b { display: block; font-size: 28px; letter-spacing: -.04em; }
    .metric span { color: var(--muted); font-size: 13px; }
    @media (max-width: 820px) { header { padding: 0 18px; } main { width: min(100vw - 28px, 1120px); padding: 34px 0; } .hero { grid-template-columns: 1fr; } .hero-copy { padding: 10px 0; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand"><span class="mark"></span><span>${escapeGeneratedHtml(title)}</span></div>
      <span class="pill">Generado por chat · index.html</span>
    </header>
    <main>
      <section class="hero">
        <div class="hero-copy">
          <div class="eyebrow">APPS · localhost / index.html</div>
          <h1>${escapeGeneratedHtml(title)}</h1>
          <p class="lead">${escapeGeneratedHtml(description)}</p>
          <div class="actions">
            <button class="btn" type="button" onclick="document.getElementById('quick-title').focus()">Agregar registro</button>
            <button class="btn secondary" type="button" onclick="resetDemo()">Restablecer demo</button>
          </div>
          <div class="grid" aria-label="Resumen">
            <div class="metric"><b id="metric-count">3</b><span>${escapeGeneratedHtml(entityText)}</span></div>
            <div class="metric"><b>1</b><span>Archivo renderizado</span></div>
            <div class="metric"><b>#FF0000</b><span>Color de marca</span></div>
          </div>
        </div>
        <aside class="panel" aria-label="Panel funcional">
          <div class="panel-head">
            <strong>Panel operativo</strong>
            <span class="status"><span class="dot"></span>Activo</span>
          </div>
          <form id="quick-form">
            <input id="quick-title" autocomplete="off" placeholder="Nuevo item para ${escapeGeneratedHtml(title)}" />
            <button class="btn" type="submit">Agregar</button>
          </form>
          <div class="list" id="items"></div>
        </aside>
      </section>
      <p class="lead" style="font-size:14px;margin-top:28px">Funciones base: ${escapeGeneratedHtml(featureText)}. Pide otro cambio en el chat y el agente editará este workspace.</p>
    </main>
  </div>
  <script>
    const storageKey = ${safeJsonForScript(storageKey)};
    const seedItems = ${safeJsonForScript(seedItems)};
    let items = JSON.parse(localStorage.getItem(storageKey) || "null") || seedItems;
    const list = document.getElementById("items");
    const metric = document.getElementById("metric-count");
    function htmlEscape(value){
      return String(value).replace(/[&<>"']/g, function(char){
        if (char === "&") return "&amp;";
        if (char === "<") return "&lt;";
        if (char === ">") return "&gt;";
        if (char === '"') return "&quot;";
        return "&#39;";
      });
    }
    function persist(){ localStorage.setItem(storageKey, JSON.stringify(items)); }
    function render(){
      list.innerHTML = items.map((item, index) => '<div class="item"><span>' + htmlEscape(item.title) + '</span><button class="tag" onclick="toggleItem(' + index + ')">' + htmlEscape(item.status) + '</button></div>').join("");
      metric.textContent = String(items.length);
    }
    function toggleItem(index){
      items[index].status = items[index].status === "Listo" ? "Pendiente" : "Listo";
      persist();
      render();
    }
    function resetDemo(){
      items = seedItems.slice();
      persist();
      render();
    }
    document.getElementById("quick-form").addEventListener("submit", function(event){
      event.preventDefault();
      const input = document.getElementById("quick-title");
      const title = input.value.trim();
      if (!title) return;
      items.unshift({ title, status: "Pendiente" });
      input.value = "";
      persist();
      render();
    });
    render();
  </script>
</body>
</html>`
  const readme = `# ${title}

Generado desde el chat de APPS como \`index.html\` autocontenido.

## Prompt
${description}

## Como verlo
Abre \`index.html\` en el preview. No requiere instalar dependencias ni levantar un runner.
`
  return [
    { path: "README.md", content: readme },
    { path: "index.html", content: html },
  ]
}

function hasGeneratedPath(files: Array<Pick<ScaffoldFile, "path">>, matcher: RegExp): boolean {
  return files.some((file) => matcher.test(file.path))
}

function countGeneratedPaths(files: Array<Pick<ScaffoldFile, "path">>, matcher: RegExp): number {
  return files.filter((file) => matcher.test(file.path)).length
}

function generatedFileSummary(result: GenerateResult, files: Array<Pick<ScaffoldFile, "path">>): string {
  const entities = result.brief.dataEntities.map((e) => e.name).join(", ") || "sin entidades"
  const hasPackage = hasGeneratedPath(files, /^package\.json$/i)
  const hasDb = hasGeneratedPath(files, /^prisma\/schema\.prisma$/i)
  const apiCount = countGeneratedPaths(files, /^app\/api\/[^/]+\/route\.tsx?$/i)
  const pageCount = countGeneratedPaths(files, /^app\/.*page\.tsx$/i)
  const projectLine = hasPackage
    ? "proyecto Next.js 14 + TypeScript listo para ejecutar"
    : "preview HTML autocontenido"
  const dbLine = hasDb
    ? "Prisma + PostgreSQL con schema.prisma, .env.example y docker-compose.yml"
    : result.brief.platform === "landing"
      ? "sin base de datos porque el brief es landing"
      : "sin base de datos generada para este brief"
  const backendLine = apiCount > 0
    ? `${apiCount} route handler(s) en app/api`
    : "sin rutas API porque no hay entidades persistentes"

  return [
    `✅ Software generado — ${files.length} archivo(s).`,
    ``,
    `- **Plataforma:** ${result.brief.platform}`,
    `- **Arquitectura:** ${projectLine}`,
    `- **Frontend:** ${pageCount || 1} pantalla(s) React/Next.js con preview automático del dev server`,
    `- **Backend:** ${backendLine}`,
    `- **Base de datos:** ${dbLine}`,
    `- **Entidades:** ${entities}`,
    ``,
    hasPackage
      ? `Estoy levantando el preview automático del proyecto Next.js. Para correr la app completa con base de datos, usa los comandos del \`README.md\`: \`docker compose up -d db\`, \`npm install\`, \`cp .env.example .env\`, \`npm run db:push\`, \`npm run db:seed\`, \`npm run dev\`.`
      : `Estoy abriendo **localhost / index.html** automáticamente para validar la interfaz al instante.`,
  ].join("\n")
}

function orderFilesForWorkspaceApply<T extends { path: string; content?: string }>(files: T[]): T[] {
  const hasNextApp =
    files.some((file) => /^app\/page\.tsx$/i.test(file.path)) ||
    files.some((file) => /^package\.json$/i.test(file.path) && /"next"\s*:/.test(file.content || ""))
  const priority = (path: string) => {
    if (hasNextApp) {
      if (/^index\.html?$/i.test(path)) return 10
      if (/^app\/page\.tsx$/i.test(path)) return 100
      return 50
    }
    return /^index\.html?$/i.test(path) ? 100 : 50
  }
  return [...files].sort((a, b) => priority(a.path) - priority(b.path))
}

const COMPOSER_MODE_LABEL: Record<ComposerMode, string> = {
  app: "App",
  build: "Build",
  deps: "Deps",
  plan: "Plan",
  debug: "Debug",
  ask: "Ask",
  image: "Image",
}

const COMPOSER_PLACEHOLDER: Record<ComposerMode, string> = {
  app: "Crea, prueba, itera…",
  build: "Pide un cambio, pega código o / para comandos",
  deps: "Instala paquetes y úsalos en el código…",
  plan: "Objetivo o plan antes de editar archivos…",
  debug: "Error, stack trace o comportamiento esperado…",
  ask: "Pregunta sobre tu app o tu código — respondo sin tocar archivos…",
  image: "Describe UI, asset o captura…",
}

const COMPOSER_MODE_INSTRUCTION: Record<ComposerMode, string> = {
  app:
    "Modo App (construir desde cero, estilo Replit/Codex): tu meta es entregar un SOFTWARE FULL-STACK profesional que el usuario pueda abrir en APPS, ejecutar y evolucionar desde el chat.\n" +
    "1) AUTONOMÍA TOTAL — NO hagas preguntas de intake. Si falta contexto, PROPÓN internamente un brief completo con defaults razonables (producto, marca, público, estética, módulos, entidades, datos demo) y ejecuta.\n" +
    "2) PLAN + EJECUCIÓN — diseña internamente arquitectura, UX, modelo de datos, API, validaciones, estados, responsive, accesibilidad y pasos de ejecución. No esperes confirmación; convierte ese plan en archivos aplicables.\n" +
    "3) GENERAR — entrega un proyecto Next.js 14 + TypeScript + Prisma + PostgreSQL con tres capas claras:\n" +
    "   • Frontend: app/page.tsx y app/<entidad>/page.tsx con formularios, tablas, loading/empty/error states y navegación.\n" +
    "   • Backend: app/api/<entidad>/route.ts con GET/POST reales por cada entidad.\n" +
    "   • Base de datos: prisma/schema.prisma, lib/db.ts, prisma/seed.ts, .env.example y docker-compose.yml para Postgres local.\n" +
    "   • README.md con comandos: docker compose up -d db, npm install, cp .env.example .env, npm run db:push, npm run db:seed, npm run dev.\n" +
    "   • PROHIBIDO usar arrays globales o almacenamiento en memoria como persistencia primaria. Los datos deben pasar por Prisma.\n" +
    streamOutputFormat({ strictStart: false, paths: FULL_STACK_APP_CONTRACT_PATHS }) +
    "\n" +
    "3) Cierra con 1-3 siguientes pasos sugeridos para iterar (ej. 'añade sección de precios', 'conecta un formulario', 'modo claro/oscuro').",
  build:
    "Modo Build: implementa cambios de código concretos. Si creas o modificas archivos, entrega bloques aplicables con ruta.",
  deps:
    "Modo Deps: actúa como un ingeniero de dependencias. Primero inspecciona package.json y el stack actual. Si el usuario pide instalar/agregar un paquete, actualiza package.json de forma mínima, instala con el gestor del workspace, ejecuta verificación y usa la dependencia en el código solo si el usuario lo pidió. No inventes paquetes; si un paquete requiere API key, variables o configuración externa, crea .env.example con placeholders y explica el requisito. Mantén el preview vivo funcionando.",
  plan:
    "Modo Plan: analiza primero, propone una arquitectura o pasos claros, identifica riesgos y no cambies archivos hasta que el usuario lo pida.",
  debug:
    "Modo Debug: diagnostica el error con hipótesis verificables, pide el dato mínimo faltante si hace falta y entrega un parche concreto cuando sea posible.",
  ask:
    "Modo Ask (igual que el modo Ask de Replit): responde de forma clara y directa preguntas sobre la app, el código o cómo funciona, con referencias a archivos cuando ayude. NO modifiques ni generes archivos. Si el usuario pide construir, crear o cambiar algo, explícale brevemente cómo se haría y sugiérele cambiar al modo Agent para que lo construya por él.",
  image:
    "Modo Image: ayuda a razonar sobre assets, interfaces, capturas o diseño visual. Si se requiere implementación, tradúcelo a cambios de código.",
}

// Gather config files from the workspace to give the SRE agent enough context
// to propose real overrides (package.json, lockfile, next.config, tsconfig…).
function collectConfigFiles(
  files: Record<string, { path: string; language: string; content: string }>,
): string {
  const wanted = new Set([
    "package.json",
    "package-lock.json",
    "next.config.mjs",
    "next.config.js",
    "vite.config.ts",
    "vite.config.js",
    "tsconfig.json",
    ".npmrc",
  ])
  return Object.values(files)
    .filter((f) => wanted.has(f.path.split("/").pop() || ""))
    .map((f) => `// ${f.path}\n${f.content}`)
    .join("\n\n")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value
}

function removePrismaPostinstall(pkgText: string): string | null {
  try {
    const pkg = JSON.parse(pkgText)
    const postinstall = String(pkg?.scripts?.postinstall || "")
    if (!/prisma\s+generate/i.test(postinstall)) return null
    delete pkg.scripts.postinstall
    return JSON.stringify(pkg, null, 2) + "\n"
  } catch {
    return null
  }
}

function buildDeterministicSrePatches(
  files: Record<string, { path: string; language: string; content: string }>,
  verdict: BuildErrorVerdict,
  log: string,
): Array<{ path: string; content: string }> {
  const patches: Array<{ path: string; content: string }> = []
  const renames = Object.entries(verdict.suggestedPrismaModelRenames || {})

  if (renames.length > 0) {
    for (const file of Object.values(files)) {
      if (!/\.(prisma|tsx?|jsx?)$/i.test(file.path)) continue
      let next = file.content
      for (const [fromModel, toModel] of renames) {
        next = next.replace(
          new RegExp(`\\bmodel\\s+${escapeRegExp(fromModel)}\\b`, "g"),
          `model ${toModel}`,
        )
        next = next.replace(
          new RegExp(`\\bprisma\\.${escapeRegExp(lowerFirst(fromModel))}\\b`, "g"),
          `prisma.${lowerFirst(toModel)}`,
        )
      }
      if (next !== file.content) patches.push({ path: file.path, content: next })
    }
  }

  const pkg = files["package.json"]
  if (pkg && /prisma\s+generate|postinstall|schema\.prisma/i.test(log)) {
    const withoutPostinstall = removePrismaPostinstall(pkg.content)
    if (withoutPostinstall && withoutPostinstall !== pkg.content) {
      patches.push({ path: "package.json", content: withoutPostinstall })
    }
  }

  return patches
}

// Agent-style narration block (docs/code/code-chat-agent-style-prompt.md): makes
// every assistant reply read like the live-dashboard agent — first-person,
// technical, step-by-step, validating env constraints by name. The badges /
// action-glyph rows / Worked Summary are added by the UI from REAL data; the
// model must NOT fabricate them.
const AGENT_STYLE_BLOCK = [
  "ESTILO DE RESPUESTA (obligatorio):",
  "- Eres un Agente de Ingeniería de Software Senior: planificas, ejecutas y reportas como un dashboard de desarrollo en vivo.",
  "- Escribe en PRIMERA PERSONA y en PRESENTE, con tono técnico, objetivo y proactivo: \"Analizo todos los errores en paralelo\", \"Veo los problemas claramente\", \"Tengo el panorama completo\", \"Los ordeno por prioridad\". Frases cortas (1-2 líneas), sin relleno.",
  "- Abre SIEMPRE con una línea de planificación que empiece con un GERUNDIO y nombre la operación (\"Planificando la verificación de la migración…\", \"Revisando el código de memoria…\", \"Buscando las queries SQL…\"). Ponla como primera línea, sola, seguida del resto en líneas aparte.",
  "- Narra PASO A PASO: una frase breve anuncia la acción → realizas la acción (generas el archivo / usas la herramienta) → describes lo que observas → siguiente acción. No vuelques un bloque de código gigante sin narrar.",
  "- REVISA primero el código que YA existe en el proyecto antes de cambiar nada: nombra los archivos y carpetas que abres para entender la estructura (\"Reviso `src/App.tsx` y la carpeta `src/components/`…\"). Trabaja sobre lo que existe; NO reescribas la app entera por un cambio pequeño.",
  "- Haz cambios QUIRÚRGICOS y mínimos: toca solo los archivos necesarios para lo que se pide. ANTES de editar, di EXPLÍCITAMENTE qué carpeta o archivo vas a modificar y por qué (\"Estoy modificando la carpeta `src/components` — edito `Button.tsx` para añadir el estado de carga…\"). Conserva intacto el resto del código.",
  "- Antes de cambiar o ejecutar código, VALIDA los supuestos del entorno y NÓMBRALOS: columnas/tablas que quizá no existan (p. ej. column \"embedding\" does not exist), dependencias, variables. No asumas que algo existe sin verificarlo.",
  "- Si la app necesita una API key o variable de entorno para funcionar (p. ej. `OPENAI_API_KEY`, `DATABASE_URL`, `STRIPE_SECRET_KEY`), DÍSELO al usuario con claridad: qué clave es, para qué sirve y dónde colocarla (`.env` / `.env.example`). Nunca inventes el valor de una clave: deja un placeholder y avisa que debe configurarla.",
  "- Cierra con una síntesis del panorama (\"Tengo el panorama completo: identifico N problemas distintos. Los ordeno por prioridad:\").",
  "- NO inventes resultados ni métricas (tiempo, acciones, líneas, tokens y costo se miden y se muestran solos). Si algo falla por falta de créditos/cuota/clave (402), detente, no reintentes en bucle, y explica qué quedó bloqueado.",
].join("\n")

// System prompt for the CONVERSATION tier: the user is talking to the agent
// (question / doubt / meta), not asking it to build. The UI adds the real
// action rows; the model must answer, not fabricate work.
const CONVERSATION_SYSTEM_PROMPT = [
  "[MODO CONVERSACIÓN]",
  "Eres el agente de apps de SiraGPT dentro del workspace /code. El usuario NO pidió construir ni cambiar código: te está hablando (una pregunta, una duda o un comentario).",
  "Responde útil, cercano y BREVE (2-6 frases), en el idioma del usuario.",
  "Si pregunta qué sabes hacer: creas apps, landings y juegos desde una descripción; editas el proyecto actual; instalas dependencias npm cuando el proyecto lo necesita; lo ejecutas en vivo en el preview; lo corriges y lo publicas.",
  "PROHIBIDO generar código, bloques de archivos, o afirmar que hiciste cambios — en este turno solo conversas.",
  "Cierra invitando a pedir la construcción o el cambio cuando quiera.",
].join("\n")

const CODE_AGENT_PHASE_BLUEPRINT = [
  { key: "plan", label: "Plan" },
  { key: "context", label: "Contexto" },
  { key: "generate", label: "Generar" },
  { key: "apply", label: "Aplicar" },
  { key: "verify", label: "Verificar" },
] as const

type CodeAgentPhaseKey = (typeof CODE_AGENT_PHASE_BLUEPRINT)[number]["key"]

function buildCodeAgentPhases(
  activeKey: CodeAgentPhaseKey,
  overrides: Partial<Record<CodeAgentPhaseKey, Partial<CodeAgentPhase>>> = {},
): CodeAgentPhase[] {
  const activeIndex = Math.max(0, CODE_AGENT_PHASE_BLUEPRINT.findIndex((phase) => phase.key === activeKey))
  return CODE_AGENT_PHASE_BLUEPRINT.map((phase, index) => {
    const override = overrides[phase.key]
    const status =
      override?.status ??
      (index < activeIndex ? "done" : index === activeIndex ? "running" : "pending")
    return {
      key: phase.key,
      label: phase.label,
      status,
      ...(override?.detail ? { detail: override.detail } : {}),
    }
  })
}

function buildSystemContext(
  files: Record<string, { path: string; language: string; content: string }>,
  activePath: string | null,
  folder: { name: string; description?: string | null; instructions?: string | null } | null,
  mode?: ComposerMode,
) {
  const fileList = Object.values(files)
    .map((f) => `- ${f.path} (${f.language})`)
    .join("\n")
  const active = activePath && files[activePath] ? files[activePath] : null
  const activeBlock = active
    ? `\n\nArchivo activo: ${active.path}\n\n\u0060\u0060\u0060${active.language} ${active.path}\n${active.content}\n\u0060\u0060\u0060`
    : ""
  const folderBlock = folder
    ? [
        "",
        `Carpeta activa: ${folder.name}`,
        folder.description ? `Descripción: ${folder.description}` : "",
        folder.instructions ? `Instrucciones del proyecto:\n${folder.instructions}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : ""
  const hasNodeProject = Object.keys(files).some((p) => /(^|\/)package\.json$/.test(p))
  // App mode builds the full-stack APPS contract even on an empty workspace —
  // emitting the static-preview rules there would contradict the builder.
  const expectNodeProject = hasNodeProject || mode === "app" || mode === "deps"
  const previewBlock = mode === "app"
    ? [
        "El workspace alojará un SOFTWARE FULL-STACK real: Next.js 14 App Router",
        "+ TypeScript + Prisma + PostgreSQL. Usa package.json, app/**,",
        "app/api/**, lib/db.ts, prisma/schema.prisma, .env.example y",
        "docker-compose.yml. El preview se arranca automáticamente con el dev server",
        "y prepara la base de datos con db:push/db:seed. NO uses arrays globales",
        "ni almacenamiento en memoria como persistencia primaria.",
        "Si existe app/page.tsx, los cambios visuales del home/dashboard se hacen",
        "en app/page.tsx y app/globals.css. NO edites index.html ni README.md",
        "para cambios que deban verse en el preview vivo de Next.",
      ].join("\n")
    : mode === "deps"
    ? [
        hasNodeProject
          ? "El workspace contiene package.json: trata este turno como gestión real de dependencias."
          : "El usuario está pidiendo dependencias, pero aún no hay package.json. Si el pedido requiere un proyecto ejecutable, crea un starter Vite mínimo con package.json; si solo pregunta, explica qué falta.",
        "Inspecciona package.json antes de cambiarlo. Instala paquetes solo por nombre/version válidos, sin flags arbitrarios ni scripts interactivos.",
        "Después de instalar o editar dependencias, ejecuta type_check y dev_server_check; si aparece un import roto o módulo faltante, corrige package.json/código y verifica otra vez.",
      ].join("\n")
    : expectNodeProject
    ? [
        hasNodeProject
          ? "El workspace contiene un PROYECTO Node REAL (hay package.json) — típicamente"
          : "El workspace alojará un PROYECTO Node REAL.",
        "Usa imports npm normales y extensiones .tsx/.ts; el usuario lo ejecuta",
        "con dev server autoejecutado en preview. Respeta el stack ya presente en package.json",
        "si existe.",
      ].join("\n")
    : [
        "El workspace tiene un PREVIEW EN VIVO (navegador embebido) que se",
        "actualiza solo. Escribe SIEMPRE código que se pueda previsualizar sin",
        "build ni npm:",
        "- Web estática: un único index.html autocontenido (puedes usar el CDN de",
        "  Tailwind y enlazar styles.css / app.js locales).",
        "- React/JSX: define un componente App exportado por defecto (export default",
        "  function App()). React 18 y los globales Recharts, d3, lucide, motion y",
        "  AnimatePresence, además de Tailwind, ya están disponibles — NO uses",
        "  imports de paquetes npm (no hay bundler). Importar archivos locales",
        "  .css/.json sí funciona.",
        "- Mantén cada entrega autocontenida y lista para renderizar.",
      ].join("\n")
  return [
    "Eres un asistente de programación que trabaja en un workspace en memoria del navegador.",
    "Cuando devuelvas código pensado para un archivo, usa SIEMPRE este formato para que la app pueda aplicarlo:",
    "",
    "\u0060\u0060\u0060<lenguaje> <ruta>",
    "<contenido COMPLETO del archivo>",
    "\u0060\u0060\u0060",
    "(la ruta va SOLO en el encabezado del bloque — NO añadas líneas `// path:` dentro del contenido;",
    "en package.json un comentario rompe el JSON)",
    folderBlock,
    "",
    previewBlock,
    "",
    AGENT_STYLE_BLOCK,
    "",
    "Archivos disponibles:",
    fileList || "(workspace vacío)",
    activeBlock,
  ].join("\n")
}

// ── Persistent chat→Codex-project mapping ───────────────────────────────────
// The in-memory ref used to be the ONLY record of which Codex project a chat
// session drives, so a reload created a fresh empty project and iterate then
// edited THAT one and overwrote the local workspace (audit 3.1-ALTA). Backed
// by localStorage, keyed by chatSessionId; every access is try/catch'd and
// SSR-safe (storage may be unavailable or full — the in-memory ref still works
// for the lifetime of the panel).
const CODEX_PROJECT_STORE_PREFIX = "siragpt:codex-project:"

function readPersistedCodexProject(sid: string): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(`${CODEX_PROJECT_STORE_PREFIX}${sid}`)
  } catch {
    return null
  }
}

function persistCodexProject(sid: string, projectId: string): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(`${CODEX_PROJECT_STORE_PREFIX}${sid}`, projectId)
  } catch {
    /* storage unavailable/full — the in-memory ref still covers this session */
  }
}

function clearPersistedCodexProject(sid: string): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(`${CODEX_PROJECT_STORE_PREFIX}${sid}`)
  } catch {
    /* ignore */
  }
}

// Backend import caps (POST /api/codex/projects/:id/files): 200 files, 500KB
// per file, 5MB total. Filter/trim the local workspace to fit so a huge asset
// never turns the whole sync into a 400.
const CODEX_IMPORT_MAX_FILES = 200
const CODEX_IMPORT_MAX_FILE_BYTES = 500 * 1024
const CODEX_IMPORT_MAX_TOTAL_BYTES = 5 * 1024 * 1024

function collectWorkspaceFilesForImport(
  files: Record<string, { path: string; language: string; content: string }>,
): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = []
  let total = 0
  const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null
  const byteLen = (s: string) => (encoder ? encoder.encode(s).length : s.length)
  for (const [path, file] of Object.entries(files)) {
    if (!path || typeof file?.content !== "string") continue
    if (path.length > 500) continue
    if (/(^|\/)(node_modules|\.git|dist|build|\.next)\//.test(path)) continue
    const bytes = byteLen(file.content)
    if (bytes > CODEX_IMPORT_MAX_FILE_BYTES) continue
    if (total + bytes > CODEX_IMPORT_MAX_TOTAL_BYTES) break
    out.push({ path, content: file.content })
    total += bytes
    if (out.length >= CODEX_IMPORT_MAX_FILES) break
  }
  return out
}

export function AICodeChatPanel() {
  const { user, token } = useAuth()
  const {
    selectedModel,
    selectProvider,
    availableModels,
  } = useChat()
  const {
    files,
    activePath,
    applyBlock,
    registerChatFocusHandler,
    activeFolder,
    codeChatSessions,
    activeCodeChatSessionId,
    activeCodeChatSession,
    createCodeChatSession,
    setActiveCodeChatSession,
    patchCodeChatSessionTurns,
    patchAgentState,
  } = useCodeWorkspace()

  const sessionId = activeCodeChatSessionId
  const turns = React.useMemo(
    () => activeCodeChatSession?.turns ?? [],
    [activeCodeChatSession?.turns],
  )
  const agentPhase = activeCodeChatSession?.agent?.phase ?? "idle"

  const setTurns = React.useCallback(
    (updater: React.SetStateAction<CodeChatTurn[]>) => {
      if (!sessionId) return
      patchCodeChatSessionTurns(sessionId, (prev) =>
        typeof updater === "function" ? (updater as (p: CodeChatTurn[]) => CodeChatTurn[])(prev) : updater,
      )
    },
    [patchCodeChatSessionTurns, sessionId],
  )

  const [input, setInput] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [buildingApp, setBuildingApp] = React.useState(false)
  const agentsActive =
    busy || buildingApp || agentPhase === "generating" || agentPhase === "debugging"
  const [includeContext, setIncludeContext] = React.useState(true)
  const [composerMode, setComposerMode] = React.useState<ComposerMode>("app")
  const [selectingTarget, setSelectingTarget] = React.useState(false)

  // The /code chat picks its OWN model — a fast, streaming one — independent of
  // the main chat (whose default may be a slow reasoning model that times out
  // the live stream). Auto-selected from the catalog, persisted, user-overridable.
  const [codeModel, setCodeModel] = React.useState<{ name: string; provider?: string } | null>(null)

  // FREE-plan / sparse catalogs return models:[] but the backend still ships a
  // policy.fallbackModel it will route to. Surface it so the composer never gets
  // stuck on "Cargando modelos…" and Ask can stream. (Agent's first build is
  // LLM-free and works even with no model at all.)
  const [fallbackModel, setFallbackModel] = React.useState<{
    name: string
    provider?: string
    displayName?: string
  } | null>(null)

  React.useEffect(() => {
    if ((availableModels && availableModels.length > 0) || fallbackModel) return
    let cancelled = false
    void (async () => {
      try {
        const res = await apiClient.getAIModels("TEXT")
        const fb = (
          res as {
            policy?: { fallbackModel?: { name?: string; provider?: string; displayName?: string } }
          }
        )?.policy?.fallbackModel
        if (!cancelled && fb?.name) {
          setFallbackModel({ name: fb.name, provider: fb.provider, displayName: fb.displayName })
        }
      } catch {
        /* best-effort: deterministic Agent build still works without a model */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [availableModels, fallbackModel])

  React.useEffect(() => {
    if (codeModel || !availableModels || availableModels.length === 0) return
    let restored: { name: string; provider?: string } | null = null
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem("code-workspace:model") : null
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed?.name && availableModels.some((m) => m.name === parsed.name)) restored = parsed
      }
    } catch {
      /* ignore corrupt value */
    }
    const chosen = restored || recommendFastModel(availableModels) || availableModels[0]
    if (chosen) setCodeModel({ name: chosen.name, provider: chosen.provider })
  }, [availableModels, codeModel])

  const chooseCodeModel = React.useCallback((m: { name: string; provider?: string }) => {
    setCodeModel(m)
    try {
      window.localStorage.setItem("code-workspace:model", JSON.stringify(m))
    } catch {
      /* quota / private mode */
    }
  }, [])

  // If a real catalog loads later (e.g. an admin activates models) and our
  // persisted choice is the policy fallback — which isn't in the catalog — drop
  // it so the picker reflects the real list instead of pinning "Gema4".
  React.useEffect(() => {
    if (!availableModels || availableModels.length === 0 || !codeModel) return
    if (availableModels.some((m) => m.name === codeModel.name)) return
    const next = recommendFastModel(availableModels) || availableModels[0]
    if (next) chooseCodeModel({ name: next.name, provider: next.provider })
  }, [availableModels, codeModel, chooseCodeModel])

  // Resolved model the code chat actually uses. Priority:
  //  1. an explicit code-chat choice (codeModel),
  //  2. a fast model derived inline from the catalog (so the FIRST request is
  //     already fast even before the auto-pick effect has run),
  //  3. the main-chat selection as a last resort (may be a slow model).
  const autoFastModel = React.useMemo(
    () => recommendFastModel(availableModels || []),
    [availableModels],
  )
  const activeModelName =
    codeModel?.name || autoFastModel?.name || selectedModel || fallbackModel?.name || ""
  const activeProvider =
    codeModel?.provider || autoFastModel?.provider || selectProvider || fallbackModel?.provider
  // What the model picker shows: the real catalog when present, else the single
  // policy fallback so the user sees "Gema4" rather than an endless spinner.
  const pickerModels = React.useMemo<ModelOption[]>(() => {
    if (availableModels && availableModels.length > 0) return availableModels as ModelOption[]
    if (fallbackModel) {
      return [
        {
          name: fallbackModel.name,
          displayName: fallbackModel.displayName,
          provider: fallbackModel.provider,
        } as ModelOption,
      ]
    }
    return []
  }, [availableModels, fallbackModel])
  // Fast = streaming-friendly (good for the live preview); slow = reasoning/heavy.
  const modelIsFast = !!activeModelName && !isSlowModel(activeModelName)

  // OpenCode engine (opt-in): when configured/reachable, the chat can route
  // prompts through the real agent engine instead of the LLM/builder path.
  const { available: engineAvailable } = useOpencodeEngine()
  const [engineMode, setEngineMode] = React.useState(false)
  // Map<chatSessionId, engineSessionId> so each code chat reuses one engine session.
  const engineSessionRef = React.useRef<Record<string, string>>({})
  // Codex Agent V2 — the REAL server-driven agent (plan→build runs, durable
  // SSE). Health-gated: when the backend flag is off everything below falls
  // back to the OpenCode/deterministic tiers exactly as before.
  const codexHealth = useCodexHealth()
  const codexAvailable = codexHealth.enabled === true
  // Map<chatSessionId, codexProjectId> so each code chat reuses ONE project.
  // In-memory cache only — the durable mapping lives in localStorage (see
  // readPersistedCodexProject/persistCodexProject), so a reload reattaches to
  // the SAME project instead of iterating on a fresh empty one.
  const codexProjectRef = React.useRef<Record<string, string>>({})

  const abortRef = React.useRef<AbortController | null>(null)
  // Turn ids whose `voice` was created in THIS panel instance. La voz ya no
  // se auto-reproduce nunca (solo al clic del usuario), pero el marcador se
  // conserva por si hace falta distinguir turnos frescos de rehidratados.
  const freshVoiceIdsRef = React.useRef<Set<string>>(new Set())
  const markVoiced = React.useCallback((turnId: string) => {
    freshVoiceIdsRef.current.add(turnId)
  }, [])
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)
  const scrollerRef = React.useRef<HTMLDivElement | null>(null)
  const selectionRequestRef = React.useRef(0)
  // Allow Cmd/Ctrl+L from anywhere in the workspace to focus the
  // composer. The provider exposes a small bus so we don't drill refs.
  React.useEffect(() => {
    return registerChatFocusHandler(() => {
      inputRef.current?.focus()
    })
  }, [registerChatFocusHandler])

  // The shell's "Composer" button (⌘I) emits a window event so this
  // panel can switch into the multi-step "build" mode and focus the
  // input without coupling shell ↔ panel through props.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const handler = () => {
      setComposerMode("build")
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
    window.addEventListener("siragpt:code-composer-mode", handler)
    return () => window.removeEventListener("siragpt:code-composer-mode", handler)
  }, [])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const onSelectionCaptured = (event: Event) => {
      const detail = (event as CustomEvent<CodePreviewSelectionDetail>).detail
      if (!detail) return
      setSelectingTarget(false)
      setComposerMode((mode) => (mode === "plan" || mode === "ask" || mode === "image" ? "build" : mode))
      setInput((prev) => buildSelectedElementPrompt(detail, prev))
      window.requestAnimationFrame(() => {
        const inputEl = inputRef.current
        inputEl?.focus()
        if (inputEl) {
          const end = inputEl.value.length
          inputEl.setSelectionRange(end, end)
        }
      })
      toast.success("Elemento seleccionado. Describe el cambio y envíalo.")
    }
    const onSelectionCancel = (event: Event) => {
      setSelectingTarget(false)
      const reason = (event as CustomEvent<CodePreviewSelectionCancelDetail>).detail?.reason
      if (reason) toast.message(reason)
    }
    window.addEventListener(CODE_SELECTION_CAPTURED_EVENT, onSelectionCaptured)
    window.addEventListener(CODE_SELECTION_CANCEL_EVENT, onSelectionCancel)
    return () => {
      window.removeEventListener(CODE_SELECTION_CAPTURED_EVENT, onSelectionCaptured)
      window.removeEventListener(CODE_SELECTION_CANCEL_EVENT, onSelectionCancel)
    }
  }, [])

  const toggleTargetSelection = React.useCallback(() => {
    if (typeof window === "undefined") return
    if (selectingTarget) {
      setSelectingTarget(false)
      window.dispatchEvent(
        new CustomEvent<CodePreviewSelectionCancelDetail>(CODE_SELECTION_CANCEL_EVENT, {
          detail: { reason: "Selección cancelada.", source: "chat" },
        }),
      )
      return
    }
    selectionRequestRef.current += 1
    setSelectingTarget(true)
    setComposerMode((mode) => (mode === "plan" || mode === "ask" || mode === "image" ? "build" : mode))
    window.dispatchEvent(new CustomEvent(CODE_OPEN_PREVIEW_EVENT))
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent(CODE_SELECT_TARGET_EVENT, {
          detail: { requestId: selectionRequestRef.current },
        }),
      )
    }, 90)
    inputRef.current?.blur()
    toast("Selecciona en el preview la parte que quieres modificar.")
  }, [selectingTarget])

  // Auto-scroll on new content while the user is at the bottom — if
  // they scrolled up to read history, leave them alone.
  React.useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const threshold = 80
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    if (nearBottom) {
      el.scrollTop = el.scrollHeight
    }
  }, [turns])

  React.useEffect(() => {
    setInput("")
    setBusy(false)
    abortRef.current?.abort()
    abortRef.current = null
    // Also clear the BUILD latch and any parked/repair state on a session
    // switch — otherwise an in-flight build (buildingApp) from the previous
    // session keeps the composer wedged and would drain a parked message into
    // the wrong chat.
    setBuildingApp(false)
    pendingInputRef.current = []
    repairInFlightRef.current = false
  }, [sessionId])

  React.useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = "0px"
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 28), 140)}px`
  }, [input])

  const cancelStream = React.useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setTurns((prev) =>
      prev.map((t) => (t.streaming ? { ...t, streaming: false } : t)),
    )
  }, [setTurns])

  const sendPrompt = React.useCallback(
    async (
      prompt: string,
      override?: {
        systemPrompt?: string
        autoApply?: boolean
        /** Skip AGENT_STYLE_BLOCK (dashboard narration) — plain chat answers. */
        plainStyle?: boolean
        /** Phrasing for the spoken completion digest (default "patch");
         *  the SRE/auto-repair callers pass "debug" ("Arreglado…"). */
        spokenKind?: "patch" | "debug"
      },
    ) => {
      const normalized = normalizeChatInput(prompt)
      if (shouldWarnUser(normalized)) {
        toast.error(
          `El mensaje supera el límite (${normalized.originalLength.toLocaleString()} caracteres). Se recortó.`,
          { duration: 4500 },
        )
      }
      const text = normalized.value.trim()
      if (!text || busy) return
      if (!user || !token) {
        toast.error("Inicia sesión para usar el chat de código.")
        return
      }
      if (!activeModelName) {
        toast.error("Cargando modelos… intenta de nuevo en un momento.")
        return
      }

      if (!sessionId) {
        toast.error("Selecciona o crea un agente de código.")
        return
      }

      // Intake / routing is decided by the agent FSM (nextAgentAction) in
      // `dispatch`; sendPrompt is now a pure LLM-streaming executor. The system
      // prompt can be overridden per role (landing generator, SRE, …).
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const assistantId = `${id}-a`
      setTurns((prev) => [
        ...prev,
        { id, role: "user", content: text },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          streaming: true,
          agentLabel: "Planificando el turno",
          agentPhases: buildCodeAgentPhases("plan"),
        },
      ])
      setInput("")
      setBusy(true)

      const controller = new AbortController()
      abortRef.current = controller

      const patchAssistant = (patch: Partial<CodeChatTurn>) => {
        setTurns((prev) =>
          prev.map((t) => (t.id === assistantId ? { ...t, ...patch } : t)),
        )
      }

      const modeInstruction = COMPOSER_MODE_INSTRUCTION[composerMode]
      // Include the recent conversation so the agent actually accumulates the
      // intake context across turns. Without this the chat was stateless per
      // message — it kept re-asking the same questions and never had enough
      // context to generate. `turns` here is the state BEFORE this message was
      // appended, i.e. the genuine prior history.
      const transcript = turns
        .filter((t) => !t.streaming && t.content.trim())
        .slice(-12)
        .map((t) => `${t.role === "user" ? "Usuario" : "Asistente"}: ${t.content}`)
        .join("\n\n")
      const convoBlock = transcript ? `Conversación hasta ahora:\n${transcript}\n\n---\n\n` : ""
      const finalPrompt = override?.systemPrompt
        ? `${override.plainStyle ? "" : `${AGENT_STYLE_BLOCK}\n\n`}${override.systemPrompt}\n\n${convoBlock}Usuario: ${text}`
        : includeContext
          ? `${buildSystemContext(files, activePath, activeFolder, composerMode)}\n\n${modeInstruction}\n\n${convoBlock}Usuario: ${text}`
          : `${modeInstruction}\n\n${convoBlock}Usuario: ${text}`

      patchAssistant({
        agentLabel: includeContext ? "Leyendo contexto del workspace" : "Preparando generación",
        agentPhases: buildCodeAgentPhases("context", {
          context: {
            status: "running",
            detail: includeContext
              ? `${Object.keys(files).length} archivo(s) disponibles`
              : "Sin contexto del workspace",
          },
        }),
      })

      // Accumulate the streamed answer locally so onDone can auto-apply the
      // generated files without reading it back out of a setState updater
      // (updaters must stay pure — applyBlock is a side effect).
      let assistantText = ""
      const startedAt = Date.now()
      // Real token usage (+ optional USD cost) from the stream's `usage` frame,
      // delivered just before onClose so it's available when we build metrics.
      let usage: { tokensIn: number; tokensOut: number; costOriginalUsd?: number; costAppliedUsd?: number } | null = null

      try {
        patchAssistant({
          agentLabel: "Generando respuesta con el agente de código",
          agentPhases: buildCodeAgentPhases("generate", {
            context: { status: "done", detail: includeContext ? "Contexto inyectado" : "Omitido por usuario" },
          }),
        })
        await apiClient.generateAIStream(
          {
            provider: activeProvider,
            model: activeModelName,
            prompt: finalPrompt,
            streamId: id,
            // The code chat generates code blocks (e.g. a full index.html);
            // it must use a plain LLM stream, never the web_search/artifact
            // agentic loop (which times out and returns the empty fallback
            // for build-an-app prompts).
            disableAgentic: true,
          },
          (chunk) => {
            assistantText += chunk
            setTurns((prev) =>
              prev.map((t) => {
                if (t.id !== assistantId) return t
                const nextContent = t.content + chunk
                // The first completed line = the planning line is done → stamp the
                // REAL planning duration once (turn start → first line emitted).
                const planPatch =
                  t.planMs == null && nextContent.includes("\n")
                    ? { planMs: Date.now() - startedAt }
                    : {}
                return { ...t, content: nextContent, ...planPatch }
              }),
            )
          },
          () => {
            // Agentic write modes (app/build, plus debug/patch via explicit
            // override) = Replit-style "presented output": the agent applies the
            // generated files itself and opens the live preview, with NO manual
            // "Aplicar" button (the user asked the agentic system to do the
            // writing). Read-only modes (ask/plan/image) pass autoApply:false and
            // never apply. `applied` feeds the Worked-Summary/action-log metrics
            // on the turn (real numbers).
            let applied: Array<{ path: string; content: string }> = []
            patchAssistant({
              agentLabel: "Aplicando cambios al workspace",
              agentPhases: buildCodeAgentPhases("apply", {
                context: { status: "done", detail: includeContext ? "Contexto usado" : "Sin contexto" },
                generate: { status: "done", detail: "Stream completado" },
              }),
            })
            if (override?.autoApply ?? (composerMode === "app" || composerMode === "build")) {
              try {
                const blocks = parseCodeBlocks(assistantText).filter((b) => b.path)
                if (blocks.length > 0) {
                  for (const b of blocks) {
                    if (b.path) applyBlock(b.path, b.content)
                  }
                  applied = blocks.map((b) => ({ path: b.path as string, content: b.content }))
                  const hasPkg = blocks.some((b) => /(^|\/)package\.json$/i.test(b.path || ""))
                  const hasHtml = blocks.some((b) => /\.html?$/i.test(b.path || ""))
                  toast.success(
                    hasPkg
                      ? "Proyecto generado — levantando el dev server…"
                      : hasHtml
                        ? "App generada — revisa el preview en vivo →"
                        : `Generados ${blocks.length} archivo(s) — abriendo preview`,
                  )
                  // applyBlock already emits "siragpt:code-open-preview"; make
                  // sure the preview pane is shown even if it was collapsed, and
                  // auto-boot the dev server so the user sees the running result
                  // without hunting for ▶ Ejecutar. The PreviewPane only acts on
                  // this for real Vite/Next projects and degrades silently if the
                  // environment/user can't run apps.
                  openPreviewAndMaybeRun(applied)
                }
              } catch {
                // Auto-apply failed (parse/write error). There is no manual
                // "Aplicar" button anymore, so surface the failure explicitly and
                // tell the user they can still copy the code as a fallback.
                toast.error("No se pudieron aplicar los cambios automáticamente. Usa el botón Copiar de cada bloque.")
                patchAssistant({
                  agentLabel: "No se pudieron aplicar los cambios",
                  agentPhases: buildCodeAgentPhases("apply", {
                    context: { status: "done", detail: includeContext ? "Contexto usado" : "Sin contexto" },
                    generate: { status: "done", detail: "Stream completado" },
                    apply: { status: "error", detail: "Fallo al aplicar — copia manual disponible" },
                  }),
                })
              }
            }
            const verifyDetail = applied.length > 0
              ? `${applied.length} archivo(s) aplicado(s)`
              : "Respuesta sin escritura de archivos"
            if (applied.length > 0) markVoiced(assistantId)
            setTurns((prev) =>
              prev.map((t) => {
                if (t.id !== assistantId) return t
                const base = {
                  ...t,
                  streaming: false,
                  agentLabel: "Turno completado",
                  agentPhases: buildCodeAgentPhases("verify", {
                    context: { status: "done", detail: includeContext ? "Contexto usado" : "Sin contexto" },
                    generate: { status: "done", detail: "Respuesta generada" },
                    apply: { status: "done", detail: applied.length > 0 ? "Cambios escritos" : "Nada que aplicar" },
                    verify: { status: "done", detail: verifyDetail },
                  }),
                }
                // Attach the Worked Summary when the turn did file work OR the
                // stream reported real token usage (the Agent Usage figure).
                if (applied.length > 0 || usage) {
                  const { actions, metrics } = buildWriteMetrics(applied, {
                    startedAt,
                    now: Date.now(),
                    getPrevContent: (p) => files[p]?.content ?? "",
                  })
                  // Even a no-file text answer shows an action row (the model
                  // reasoned + produced the reply).
                  const effectiveActions =
                    actions.length > 0 ? actions : [{ kind: "reasoning" as const, label: "Genero la respuesta" }]
                  const withUsage = usage
                    ? {
                        ...metrics,
                        tokensIn: usage.tokensIn,
                        tokensOut: usage.tokensOut,
                        ...(usage.costOriginalUsd != null ? { costOriginalUsd: usage.costOriginalUsd } : {}),
                        ...(usage.costAppliedUsd != null ? { costAppliedUsd: usage.costAppliedUsd } : {}),
                      }
                    : metrics
                  return {
                    ...base,
                    actions: effectiveActions,
                    metrics: withUsage,
                    // Claude Code-style spoken completion digest — only when the
                    // turn did real multi-step file work (never for plain answers).
                    ...(applied.length > 0
                      ? {
                          voice: buildSpokenSummary({
                            kind: override?.spokenKind ?? "patch",
                            filesChanged: withUsage.filesChanged,
                            durationMs: withUsage.timeWorkedMs,
                          }),
                        }
                      : {}),
                  }
                }
                return base
              }),
            )
            // Only release the latch if this turn is still the active one — a
            // newer turn may have replaced abortRef, and clearing it here would
            // cancel that turn's busy state (mirrors runEngine/runCodexEngine).
            if (abortRef.current === controller) {
              abortRef.current = null
              setBusy(false)
            }
          },
          (err) => {
            // A cancelled/aborted stream (user started a new turn, navigated
            // away, or the SSE socket was cut) is NOT a failure — surface it as
            // a soft "stopped" state that keeps whatever partial content arrived,
            // instead of a scary red "Fetch is aborted" error turn.
            const aborted =
              err?.name === "AbortError" ||
              /\babort|cancel|operation was aborted/i.test(err?.message || "")
            const msg = err?.message || "Error en el chat de código"
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId
                  ? aborted
                    ? {
                        ...t,
                        streaming: false,
                        agentLabel: "Generación detenida",
                        agentPhases: buildCodeAgentPhases("generate", {
                          generate: { status: "done", detail: "Detenida" },
                        }),
                        content: t.content
                          ? `${t.content}\n\n_Generación detenida._`
                          : "_Generación detenida — vuelve a enviar para reintentar._",
                      }
                    : {
                        ...t,
                        streaming: false,
                        agentLabel: "Error en el turno",
                        agentPhases: buildCodeAgentPhases("generate", {
                          generate: { status: "error", detail: msg },
                        }),
                        content: t.content ? `${t.content}\n\n_${msg}_` : `_${msg}_`,
                      }
                  : t,
              ),
            )
            if (abortRef.current === controller) {
              abortRef.current = null
              setBusy(false)
            }
          },
          controller.signal,
          { onUsage: (u) => { usage = u } },
        )
      } catch (err: any) {
        const aborted =
          err?.name === "AbortError" ||
          /\babort|cancel|operation was aborted/i.test(err?.message || "")
        if (aborted) {
          patchAssistant({
            streaming: false,
            agentLabel: "Generación detenida",
            agentPhases: buildCodeAgentPhases("generate", {
              generate: { status: "done", detail: "Detenida" },
            }),
          })
        } else {
          toast.error(err?.message || "Error en el chat de código")
          patchAssistant({
            streaming: false,
            agentLabel: "Error en el turno",
            agentPhases: buildCodeAgentPhases("generate", {
              generate: { status: "error", detail: err?.message || "Error en el chat de código" },
            }),
          })
        }
        if (abortRef.current === controller) {
          abortRef.current = null
          setBusy(false)
        }
      }
    },
    [
      activePath,
      activeFolder,
      activeModelName,
      activeProvider,
      applyBlock,
      busy,
      composerMode,
      files,
      includeContext,
      markVoiced,
      sessionId,
      setTurns,
      token,
      turns,
      user,
    ],
  )

  // Deterministic "Construir app" path: sends the prompt to
  // /api/builder/generate (pure heuristics -> real project files plus a
  // self-contained index.html preview). This is the reliable APPS flow: prompt
  // in the chat, files written into the workspace, preview on localhost /
  // index.html, with a local index.html fallback if the backend is temporarily
  // unreachable.
  const buildApp = React.useCallback(
    async (
      prompt: string,
      ctx?: AgentBuildContext,
      // omitUserTurn: engine fallbacks (runCodexEngine/runEngine) already
      // rendered the user's message in their own turn — don't duplicate it.
      opts?: { omitUserTurn?: boolean },
    ) => {
      const text = prompt.trim()
      if (!text || busy || buildingApp) return
      if (!user || !token) {
        toast.error("Inicia sesión para construir la app.")
        return
      }
      if (!sessionId) {
        toast.error("Selecciona o crea un agente de código.")
        return
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setTurns((prev) => [
        ...prev,
        ...(opts?.omitUserTurn ? [] : [{ id, role: "user", content: text } as CodeChatTurn]),
        {
          id: `${id}-a`,
          role: "assistant",
          content: "⚙️ Analizando el brief y activando herramientas de construcción…",
          streaming: true,
          agentLabel: "Construyendo software",
          agentPhases: buildCodeAgentPhases("generate", {
            plan: { status: "done", detail: "Arquitectura definida" },
            context: { status: "done", detail: ctx ? "Contexto de intake listo" : "Brief inferido" },
            generate: { status: "running", detail: "Frontend, backend y datos" },
          }),
        },
      ])
      setInput("")
      setBuildingApp(true)
      const startedAt = Date.now()

      try {
        let appliedFiles: Array<{ path: string; content: string }>
        let summary: string
        let toastMsg: string
        try {
          const result = await intakeService.generate(text)
          appliedFiles = result.files || []
          if (appliedFiles.length === 0) {
            throw new Error("La generación no devolvió archivos.")
          }
          summary = generatedFileSummary(result, appliedFiles)
          toastMsg = "Software generado — abriendo preview →"
        } catch {
          appliedFiles = buildLocalIndexFallbackFiles(text, ctx)
          summary = [
            `✅ App generada localmente — ${appliedFiles.length} archivo(s).`,
            ``,
            `- **Archivo activo:** \`index.html\``,
            `- **Tipo:** HTML autocontenido listo para preview`,
            `- **Motivo:** el builder backend no respondió, así que usé el fallback local para no dejar el workspace vacío`,
            ``,
            `Estoy abriendo **localhost / index.html** automáticamente. Pídeme cualquier cambio y lo aplico desde este mismo chat.`,
          ].join("\n")
          toastMsg = "App generada localmente — abriendo index.html →"
        }
        // Keep the active editor aligned with the runnable entry: app/page.tsx
        // for generated Next apps, index.html for static fallbacks.
        const ordered = orderFilesForWorkspaceApply(appliedFiles)
        for (const file of ordered) {
          applyBlock(file.path, file.content)
        }
        openPreviewAndMaybeRun(appliedFiles)
        const { actions, metrics } = buildWriteMetrics(appliedFiles, {
          startedAt,
          now: Date.now(),
          getPrevContent: (p) => files[p]?.content ?? "",
        })
        // Claude Code-style spoken completion digest for the finished build:
        // what was built (entities/screens) AND what's honestly pending —
        // derived from REAL build facts, never invented.
        const spokenPending: string[] = []
        if (appliedFiles.some((f) => /schema\.prisma$/.test(f.path))) {
          spokenPending.push("conectar la base de datos real")
        }
        spokenPending.push("afinar el diseño a tu marca")
        const spoken = buildSpokenSummary({
          kind: "build",
          filesChanged: metrics.filesChanged,
          durationMs: metrics.timeWorkedMs,
          appName: ctx?.brand || ctx?.productType || "",
          entities: (ctx?.dataEntities || "").trim(),
          pending: spokenPending,
        })
        markVoiced(`${id}-a`)
        setTurns((prev) =>
          prev.map((t) =>
            t.id === `${id}-a`
              ? {
                  ...t,
                  content: summary,
                  streaming: false,
                  agentLabel: "Software construido",
                  agentPhases: buildCodeAgentPhases("verify", {
                    plan: { status: "done", detail: "Arquitectura validada" },
                    context: { status: "done", detail: ctx ? "Intake usado" : "Prompt directo" },
                    generate: { status: "done", detail: `${appliedFiles.length} archivo(s) generados` },
                    apply: { status: "done", detail: "Workspace actualizado" },
                    verify: { status: "done", detail: "Preview abierto" },
                  }),
                  actions,
                  metrics,
                  voice: spoken,
                }
              : t,
          ),
        )
        toast.success(toastMsg)
      } catch (err: any) {
        const msg = err?.message || "No se pudo generar la app"
        setTurns((prev) =>
          prev.map((t) =>
            t.id === `${id}-a`
              ? {
                  ...t,
                  content: `_${msg}_`,
                  streaming: false,
                  agentLabel: "Error al construir",
                  agentPhases: buildCodeAgentPhases("generate", {
                    generate: { status: "error", detail: msg },
                  }),
                }
              : t,
          ),
        )
        toast.error(msg)
      } finally {
        setBuildingApp(false)
      }
    },
    [applyBlock, busy, buildingApp, files, markVoiced, sessionId, setTurns, token, user],
  )

  // SRE tier-0: classify the build log locally (no LLM), render the strict
  // 5-section diagnosis, and auto-apply a package.json `overrides` patch when
  // the fix is deterministic. Works even with the model down.
  const runDeterministicSRE = React.useCallback(
    async (log: string, userText: string, sid: string) => {
      // Hold the busy latch for the whole turn (same pattern as the other
      // dispatch paths) so nothing else can be dispatched in parallel.
      setBusy(true)
      try {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        setTurns((prev) => [
          ...prev,
          { id, role: "user", content: userText },
          { id: `${id}-a`, role: "assistant", content: "🔧 Diagnosticando el build (modo determinista)…", streaming: true },
        ])
        setInput("")
        const verdict = classifyBuildError(log)
        let body = renderFiveSections(verdict)
        const patches = buildDeterministicSrePatches(files, verdict, log)
        const pkg = files["package.json"]
        if (verdict.suggestedOverrides && pkg) {
          const patched = mergeOverridesIntoPackageJson(pkg.content, verdict.suggestedOverrides)
          if (patched) {
            const existing = patches.find((patch) => patch.path === "package.json")
            if (existing) existing.content = patched
            else patches.push({ path: "package.json", content: patched })
          }
        }
        if (patches.length > 0) {
          for (const patch of patches) applyBlock(patch.path, patch.content)
          openPreviewAndMaybeRun(patches)
          body += `\n\n_${patches.map((p) => `\`${p.path}\``).join(", ")} actualizado(s) — reintentando el preview automáticamente._`
        }
        setTurns((prev) => prev.map((t) => (t.id === `${id}-a` ? { ...t, content: body, streaming: false } : t)))
        patchAgentState(sid, (s) => ({ ...s, phase: "idle" }))
      } finally {
        setBusy(false)
      }
    },
    [applyBlock, files, patchAgentState, setTurns],
  )

  // Auto-repair: a failed run (or the preview console "Arreglar con IA" button)
  // emits `siragpt:code-fix-error` with the captured logs. We hand those logs to
  // the agent and let it FIX the code automatically — NO manual submit. With a
  // model available it edits the code (SRE system prompt + autoApply); offline it
  // runs the deterministic SRE (classifies the build log and auto-patches
  // package.json overrides when the fix is deterministic).
  const busyRef = React.useRef(false)
  busyRef.current = busy
  const buildingAppRef = React.useRef(false)
  buildingAppRef.current = buildingApp
  // Synchronous latch so two same-tick events (e.g. an auto error + a manual
  // "Arreglar con IA" tap) can't start two repairs before React re-renders the
  // busy refs. Reset when the repair turn settles.
  const repairInFlightRef = React.useRef(false)
  // User messages submitted while the panel is busy (very often a BACKGROUND
  // auto-repair the live dev server triggered) are NEVER dropped: they are
  // queued here (FIFO) and auto-dispatched in arrival order, one at a time,
  // as the panel goes idle.
  const pendingInputRef = React.useRef<string[]>([])

  const repairFromLog = React.useCallback(
    async (log: string) => {
      const text = log.trim()
      if (!text || !user || !token || !sessionId) return
      const sid = sessionId
      patchAgentState(sid, (s) => ({ ...s, phase: "debugging", lastError: text }))
      const verdict = classifyBuildError(text)
      if (verdict.suggestedOverrides || verdict.suggestedPrismaModelRenames) {
        await runDeterministicSRE(text, "Detecté un error en el build — reparación automática.", sid)
        return
      }
      if (activeModelName) {
        await sendPrompt(
          "Detecté un error en el preview en vivo. Arréglalo en el código y déjalo funcionando.",
          {
            systemPrompt: sreSystemPrompt(text, collectConfigFiles(files)),
            autoApply: true,
            spokenKind: "debug",
          },
        )
      } else {
        await runDeterministicSRE(text, "Detecté un error en el build — diagnóstico automático.", sid)
      }
    },
    [activeModelName, files, patchAgentState, runDeterministicSRE, sendPrompt, sessionId, token, user],
  )
  const repairFromLogRef = React.useRef(repairFromLog)
  repairFromLogRef.current = repairFromLog

  React.useEffect(() => {
    if (typeof window === "undefined") return
    let cancelled = false
    let waitTimer: number | null = null
    const clearWait = () => {
      if (waitTimer !== null) {
        window.clearInterval(waitTimer)
        waitTimer = null
      }
    }
    const handler = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text?.trim()
      if (!text) return
      const fire = () => {
        if (cancelled || repairInFlightRef.current) return
        repairInFlightRef.current = true
        void repairFromLogRef.current(text).finally(() => {
          repairInFlightRef.current = false
        })
      }
      // Idle → repair immediately. Busy (a turn is still streaming) → wait for
      // it to settle, then auto-repair once. Latest error wins; cap the wait so
      // a wedged turn never leaves a timer running.
      if (!busyRef.current && !buildingAppRef.current) {
        fire()
        return
      }
      clearWait()
      let waited = 0
      waitTimer = window.setInterval(() => {
        if (cancelled) {
          clearWait()
          return
        }
        if (!busyRef.current && !buildingAppRef.current) {
          clearWait()
          fire()
          return
        }
        waited += 1
        if (waited > 240) clearWait() // ~120s ceiling (500ms × 240)
      }, 500)
    }
    window.addEventListener("siragpt:code-fix-error", handler)
    return () => {
      cancelled = true
      clearWait()
      window.removeEventListener("siragpt:code-fix-error", handler)
    }
  }, [])

  // Apply a set of {path,content} files to the workspace and keep the active
  // editor aligned with the runnable preview entry.
  const applyFilesToWorkspace = React.useCallback(
    (files: Array<{ path: string; content: string }>) => {
      const ordered = orderFilesForWorkspaceApply(files)
      for (const f of ordered) applyBlock(f.path, f.content)
      if (files.length > 0) openPreviewAndMaybeRun(files)
    },
    [applyBlock],
  )

  // Run the deterministic builder for a context and apply its files. Returns the
  // file count. Used as the reliable fallback when the engine yields no code.
  // It emits real project files and a self-contained index.html so APPS lands on
  // localhost / index.html immediately while the full stack remains editable.
  const runDeterministicInto = React.useCallback(
    // Returns the applied files so engine-fallback callers can hand them to
    // finish({written}) — that attaches the same actions/metrics/voice a
    // direct build gets (a fallback delivery still IS a completed build).
    async (ctx: AgentBuildContext): Promise<Array<{ path: string; content: string }>> => {
      const prompt = promptFromContext(ctx)
      try {
        const result = await intakeService.generate(prompt)
        const files = result.files || []
        if (files.length > 0) {
          applyFilesToWorkspace(files)
          return files
        }
      } catch {
        /* backend unreachable -> offline index.html shell below */
      }
      const fallback = buildLocalIndexFallbackFiles(prompt, ctx)
      applyFilesToWorkspace(fallback)
      return fallback
    },
    [applyFilesToWorkspace],
  )

  const runDeterministicPatch = React.useCallback(
    (instruction: string, sid: string): boolean => {
      const patches = buildDeterministicPreviewPatches(files, instruction)
      if (patches.length === 0) return false

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const assistantId = `${id}-a`
      const startedAt = Date.now()
      const { actions, metrics } = buildWriteMetrics(patches, {
        startedAt,
        now: Date.now(),
        getPrevContent: (p) => files[p]?.content ?? "",
      })

      setInput("")
      applyFilesToWorkspace(patches)
      patchAgentState(sid, (s) => ({ ...s, phase: "preview" }))
      markVoiced(assistantId)
      setTurns((prev) => [
        ...prev,
        { id, role: "user", content: instruction },
        {
          id: assistantId,
          role: "assistant",
          content: [
            `✅ Cambio aplicado — ${patches.length} archivo(s).`,
            ``,
            `- Actualicé \`${patches.map((p) => p.path).join("`, `")}\`.`,
            `- Reabrí el preview automático para validar el resultado vivo.`,
          ].join("\n"),
          streaming: false,
          agentLabel: "Cambio aplicado",
          agentPhases: buildCodeAgentPhases("verify", {
            plan: { status: "done", detail: "Cambio interpretado" },
            context: { status: "done", detail: "Proyecto Next detectado" },
            generate: { status: "done", detail: "Parche determinista" },
            apply: { status: "done", detail: `${patches.length} archivo(s) aplicado(s)` },
            verify: { status: "done", detail: "Preview reabierto" },
          }),
          actions,
          metrics,
          voice: buildSpokenSummary({ kind: "patch", filesChanged: metrics.filesChanged, durationMs: metrics.timeWorkedMs }),
        },
      ])
      toast.success(`Cambio aplicado — ${patches.length} archivo(s) →`)
      return true
    },
    [applyFilesToWorkspace, files, markVoiced, patchAgentState, setTurns],
  )

  // OpenCode engine path. For a normal chat turn it sends the text; for a BUILD
  // (opts.buildContext) it sends the Vite 7 + React 18 + TS contract prompt and
  // the engine writes the project files into its /workspace (write/edit tools);
  // runEngine then reads the whole tree back into the editor. If the engine
  // yields no usable code (or errors), it falls back to the deterministic
  // builder in the SAME turn — so a build always produces a result.
  const runEngine = React.useCallback(
    async (text: string, sid: string, opts?: { buildContext?: AgentBuildContext; iterate?: boolean; displayText?: string }) => {
      const ctx = opts?.buildContext
      const isBuild = !!ctx
      const iterate = !!opts?.iterate
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const assistantId = `${id}-a`
      setTurns((prev) => [
        ...prev,
        { id, role: "user", content: opts?.displayText ?? text },
        {
          id: assistantId,
          role: "assistant",
          content: isBuild ? "⚙️ Motor OpenCode construyendo…" : "⚙️ Motor OpenCode trabajando…",
          streaming: true,
          agentLabel: isBuild ? "Construyendo con Motor OpenCode" : "Motor OpenCode trabajando",
          agentPhases: buildCodeAgentPhases("plan", {
            plan: { status: "running", detail: isBuild ? "Preparando build" : "Preparando turno" },
          }),
        },
      ])
      setInput("")
      setBusy(true)
      const controller = new AbortController()
      abortRef.current = controller
      // "Detener" (cancelStream) and the session-switch cleanup both abort AND
      // clear abortRef; a new turn replaces it. Internal aborts (closing the
      // events stream below) do NOT touch the ref — so `abortRef !== controller`
      // unambiguously means THIS turn was cancelled/superseded and must neither
      // apply files nor run fallbacks nor touch the shared busy latch.
      const cancelledTurn = () => abortRef.current !== controller

      // Live progress rail for the Motor (OpenCode) path — mirrors the
      // deterministic buildApp/sendPrompt rail so Motor turns show the same
      // Plan → Contexto → Generar → Aplicar → Verificar steps.
      const setEnginePhase = (label: string, phases: CodeAgentPhase[]) =>
        setTurns((prev) =>
          prev.map((t) => (t.id === assistantId ? { ...t, agentLabel: label, agentPhases: phases } : t)),
        )

      const startedAt = Date.now()
      const finish = (
        content: string,
        meta?: {
          written?: Array<{ path: string; content: string }>
          read?: Array<{ path: string; content: string }>
          label?: string
          phases?: CodeAgentPhase[]
        },
      ) => {
        // Claude Code-style spoken digest when the engine turn wrote files
        // (mark BEFORE setTurns so the fresh-voice flag exists at render).
        if (meta?.written && meta.written.length > 0) markVoiced(assistantId)
        setTurns((prev) =>
          prev.map((t) => {
            if (t.id !== assistantId) return t
            const wrote = !!(meta?.written && meta.written.length > 0)
            const base = {
              ...t,
              content,
              streaming: false,
              agentLabel: meta?.label ?? "Turno completado",
              agentPhases:
                meta?.phases ??
                buildCodeAgentPhases("verify", {
                  plan: { status: "done", detail: "Sesión del motor lista" },
                  context: { status: "done", detail: isBuild ? "Contexto de build listo" : "Workspace leído" },
                  generate: { status: "done", detail: "Motor OpenCode" },
                  apply: {
                    status: "done",
                    detail: wrote ? `${meta!.written!.length} archivo(s) aplicados` : "Sin escritura de archivos",
                  },
                  verify: { status: "done", detail: wrote ? "Workspace actualizado" : "Respuesta entregada" },
                }),
            }
            if (wrote) {
              const { actions, metrics } = buildWriteMetrics(meta!.written!, {
                startedAt,
                now: Date.now(),
                getPrevContent: (p) => files[p]?.content ?? "",
                read: meta?.read,
              })
              return {
                ...base,
                actions,
                metrics,
                voice: buildSpokenSummary({
                  kind: isBuild ? "engine" : "patch",
                  filesChanged: metrics.filesChanged,
                  durationMs: metrics.timeWorkedMs,
                  appName: isBuild ? ctx?.brand || ctx?.productType || "" : "",
                }),
              }
            }
            return base
          }),
        )
      }

      // Terminal turn state when the user pressed Detener: no files applied,
      // no deterministic fallback — the cancelled work must stay cancelled.
      const finishStopped = () =>
        finish("_Generación detenida._", {
          label: "Generación detenida",
          phases: buildCodeAgentPhases("generate", {
            generate: { status: "done", detail: "Detenida por el usuario" },
          }),
        })

      try {
        let esid = engineSessionRef.current[sid]
        if (!esid) {
          const s = await opencodeService.createSession({})
          esid = String((s && (s.id as string)) || "")
          if (!esid) throw new Error("El motor no devolvió un id de sesión.")
          engineSessionRef.current[sid] = esid
        }

        setEnginePhase(
          isBuild ? "Leyendo contexto del workspace" : "Preparando turno del motor",
          buildCodeAgentPhases("context", {
            plan: { status: "done", detail: "Sesión del motor lista" },
            context: { status: "running", detail: isBuild ? "Preparando build" : "Leyendo workspace" },
          }),
        )

        const sendText = ctx
          ? `${landingSystemPrompt(ctx)}\n\n${engineTransportInstructions()}`
          : iterate
            ? `MODIFICA los archivos que YA existen en tu workspace para lograr: ${text}.\n\nPrimero LEE el código actual con tus herramientas, haz cambios DIRIGIDOS solo donde corresponde y CONSERVA el resto intacto. NO regeneres todo desde cero — edita los archivos existentes (write/edit). Si el proyecto es Vite + React + TypeScript, RESPETA su contrato: extensiones .tsx/.ts y Tailwind v4 vía @tailwindcss/vite (PROHIBIDO crear tailwind.config.js/postcss.config.js o usar directivas v3 \`@tailwind\`).`
            : text

        // OpenCode is event-driven: the POST /message returns an empty shell and
        // the assistant reply arrives over the SSE event stream. We accumulate
        // text parts (by part.id, dropping the echoed user prompt) and resolve
        // when the session goes idle.
        const byId = new Map<string, string>()
        const order: string[] = []
        let resolveIdle: () => void = () => {}
        const idle = new Promise<void>((r) => {
          resolveIdle = r
        })
        // "Detener" aborts the controller: resolve `idle` right away so the
        // race below exits immediately instead of zombie-waiting the full
        // engine timeout (up to 150s) and then applying files post-cancel.
        controller.signal.addEventListener("abort", () => resolveIdle(), { once: true })
        const assistantText = () =>
          order
            .map((pid) => byId.get(pid) || "")
            .filter((txt) => txt && txt !== sendText)
            .join("\n")
            .trim()

        const streamP = opencodeService
          .streamEvents((ev) => {
            const d = ev?.data as any
            if (!d || d.sessionID !== esid) return
            if (ev.type === "message.part.updated" && d.part?.type === "text" && typeof d.part.text === "string") {
              if (!byId.has(d.part.id)) order.push(d.part.id)
              byId.set(d.part.id, d.part.text)
              const live = assistantText()
              if (live) setTurns((prev) => prev.map((t) => (t.id === assistantId ? { ...t, content: live.slice(0, 12000) } : t)))
            } else if (ev.type === "session.idle" || ev.type === "session.error") {
              resolveIdle()
            }
          }, controller.signal)
          .catch(() => {})

        setEnginePhase(
          "Generando con Motor OpenCode",
          buildCodeAgentPhases("generate", {
            plan: { status: "done", detail: "Sesión del motor lista" },
            context: { status: "done", detail: isBuild ? "Contexto de build listo" : "Workspace leído" },
            generate: { status: "running", detail: "El motor está trabajando" },
          }),
        )

        // Kick off the turn (fire-and-forget; content comes via events) and wait
        // for idle, with a safety timeout so we never hang the UI.
        opencodeService.prompt(esid, sendText).catch(() => {})
        // Safety net only: the engine resolves `idle` as soon as it finishes, so
        // simple builds return in seconds and we never wait the full window.
        // This cap only fires if the engine *hangs*. Keep it generous so the
        // agent can build real, larger systems (full web app / ecommerce), then
        // fall back to the deterministic builder so a result is always produced.
        const engineTimeoutMs = isBuild ? 150_000 : 60_000
        await Promise.race([idle, new Promise<void>((r) => setTimeout(r, engineTimeoutMs))])
        // Captured BEFORE our own internal abort below: at this point an
        // aborted turn can only mean the user pressed Detener (or switched
        // sessions / started a new turn) — bail out without applying anything.
        const stoppedByUser = cancelledTurn()
        controller.abort() // close the events stream
        await streamP.catch(() => {})
        if (stoppedByUser) {
          finishStopped()
          return
        }

        const reply = assistantText()
        const blocks = parseCodeBlocks(reply).filter((b) => b.path)

        if (ctx) {
          // BUILD: read back the ENTIRE project the agent wrote to its /workspace
          // — a real multi-file tree (index.html, styles, scripts, components,
          // config…), not just one file. Falls back to known entry paths + reply
          // code blocks if the listing is empty.
          let engineFiles = await opencodeService.listProjectFiles()
          if (engineFiles.length === 0) {
            const candidates = [
              "package.json",
              "vite.config.ts",
              "tsconfig.json",
              "index.html",
              "src/main.tsx",
              "src/index.css",
              "src/App.tsx",
              // Legacy single-html era entries (old engine sessions).
              "styles.css",
              "style.css",
              "app.js",
              "script.js",
              "main.js",
            ]
            for (const p of candidates) {
              try {
                const c = await opencodeService.readFile(p)
                if (c && c.trim()) engineFiles.push({ path: p, content: c })
              } catch {
                /* missing file → skip */
              }
            }
          }
          const seen = new Set<string>()
          const merged: Array<{ path: string; content: string }> = []
          for (const f of [...engineFiles, ...blocks.map((b) => ({ path: b.path as string, content: b.content }))]) {
            if (f.path && !seen.has(f.path)) {
              seen.add(f.path)
              merged.push(f)
            }
          }
          // Cancelled while reading the tree back → never apply post-cancel.
          if (cancelledTurn()) {
            finishStopped()
            return
          }
          // Accept a real project: a runnable/known entry, or simply ≥2 files.
          const hasEntry = merged.some((f) => /(^|\/)(index\.html?|package\.json)$/i.test(f.path))
          if (merged.length > 0 && (hasEntry || merged.length >= 2)) {
            applyFilesToWorkspace(merged)
            finish(
              reply ? `${reply}\n\n_(Motor OpenCode: ${merged.length} archivo(s) →)_` : `✅ Motor OpenCode — ${merged.length} archivo(s) →`,
              { written: merged, read: engineFiles },
            )
            toast.success(`Motor OpenCode — ${merged.length} archivo(s) →`)
            return
          }
          // Engine produced nothing usable → reliable deterministic fallback.
          const fallbackFiles = await runDeterministicInto(ctx)
          finish(
            reply
              ? `${reply}\n\n_(El motor no dejó archivos; usé el builder determinista: ${fallbackFiles.length} archivos.)_`
              : `✅ App generada (builder determinista, ${fallbackFiles.length} archivos).`,
            { written: fallbackFiles },
          )
          toast.success("App generada (builder determinista) →")
          return
        }

        // Iterate: the agent edited files in its workspace ("change the header").
        // Read the whole project back and sync it so edits land in the tree +
        // preview — this is the Replit-style "modify what's not well done" loop.
        if (iterate) {
          const projectFiles = await opencodeService.listProjectFiles()
          const seen = new Set<string>()
          const synced: Array<{ path: string; content: string }> = []
          for (const f of [...projectFiles, ...blocks.map((b) => ({ path: b.path as string, content: b.content }))]) {
            if (f.path && !seen.has(f.path)) {
              seen.add(f.path)
              synced.push(f)
            }
          }
          if (cancelledTurn()) {
            finishStopped()
            return
          }
          if (synced.length > 0) {
            applyFilesToWorkspace(synced)
            finish(
              reply ? `${reply}\n\n_(Motor OpenCode: ${synced.length} archivo(s) →)_` : `✅ Cambios aplicados — ${synced.length} archivo(s) →`,
              { written: synced },
            )
            toast.success(`Cambios aplicados — ${synced.length} archivo(s) →`)
            return
          }
        }

        // Plain engine chat: render the reply + apply any code blocks it returned.
        if (blocks.length > 0) {
          applyFilesToWorkspace(blocks.map((b) => ({ path: b.path as string, content: b.content })))
          finish(reply || `✅ Motor OpenCode — ${blocks.length} archivo(s) aplicados →`, {
            written: blocks.map((b) => ({ path: b.path as string, content: b.content })),
          })
          toast.success(`Motor OpenCode — ${blocks.length} archivo(s) →`)
          return
        }

        finish(reply || "_(el motor no devolvió texto)_")
      } catch (err: any) {
        // A cancelled turn must not run the deterministic fallback (it would
        // build the app the user just stopped) nor render a fake error.
        if (cancelledTurn()) {
          finishStopped()
          return
        }
        if (ctx) {
          // Engine unreachable/error during a build → still deliver via the builder.
          try {
            const fallbackFiles = await runDeterministicInto(ctx)
            finish(`✅ App generada (builder determinista, ${fallbackFiles.length} archivos). El motor no respondió.`, {
              written: fallbackFiles,
            })
            toast.success("App generada (builder determinista) →")
            return
          } catch {
            /* fall through to error */
          }
        }
        finish(`_${err?.message || "El motor OpenCode no respondió"}_`, {
          label: "Error en el turno",
          phases: buildCodeAgentPhases("generate", {
            plan: { status: "done", detail: "Sesión del motor lista" },
            context: { status: "done", detail: isBuild ? "Contexto de build listo" : "Workspace leído" },
            generate: { status: "error", detail: err?.message || "El motor OpenCode no respondió" },
          }),
        })
        toast.error(err?.message || "El motor OpenCode no respondió")
      } finally {
        try {
          controller.abort()
        } catch {
          /* already closed */
        }
        // Only release the shared latch if THIS turn is still the active one —
        // a zombie turn settling after Detener (or after a newer turn started)
        // must not knock down the new turn's busy/abort state.
        if (abortRef.current === controller) {
          abortRef.current = null
          setBusy(false)
        }
      }
    },
    [applyFilesToWorkspace, files, markVoiced, runDeterministicInto, setTurns],
  )

  // Codex Agent V2 path — the REAL agent behind the SAME chat UI. Creates one
  // Codex project per chat session, drives a plan run → auto-approves → build
  // run, folds the durable SSE events onto the assistant turn (narrative,
  // phases, file/command counts), then pulls the files the run wrote back into
  // the workspace. Deterministic buildApp fallback inside, so a build ALWAYS
  // lands even if the agent errors — mirroring runEngine's guarantees.
  const runCodexEngine = React.useCallback(
    async (text: string, sid: string, opts?: { iterate?: boolean; displayText?: string }) => {
      const iterate = !!opts?.iterate
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const assistantId = `${id}-a`
      setTurns((prev) => [
        ...prev,
        { id, role: "user", content: opts?.displayText ?? text },
        {
          id: assistantId,
          role: "assistant",
          content: iterate ? "⚙️ Agente Codex trabajando…" : "⚙️ Agente Codex construyendo…",
          streaming: true,
          agentLabel: iterate ? "Agente Codex trabajando" : "Construyendo con Agente Codex",
          agentPhases: buildCodeAgentPhases("plan", {
            plan: { status: "running", detail: iterate ? "Preparando turno" : "Preparando build" },
          }),
        },
      ])
      setInput("")
      setBusy(true)
      const controller = new AbortController()
      abortRef.current = controller
      // "Detener" (cancelStream) aborts the controller and clears abortRef; the
      // only internal abort lives in `finally`. So during the turn body either
      // signal.aborted or a replaced/cleared abortRef means the user stopped
      // (or superseded) THIS turn — never apply files or fall back afterwards.
      const cancelledTurn = () => controller.signal.aborted || abortRef.current !== controller

      const setEnginePhase = (label: string, phases: CodeAgentPhase[]) =>
        setTurns((prev) =>
          prev.map((t) => (t.id === assistantId ? { ...t, agentLabel: label, agentPhases: phases } : t)),
        )

      const startedAt = Date.now()
      // finish() mirrors runEngine.finish: on a write it attaches the
      // Worked-Summary actions/metrics from REAL data + the spoken digest.
      const finish = (
        content: string,
        meta?: {
          written?: Array<{ path: string; content: string }>
          read?: Array<{ path: string; content: string }>
          label?: string
          phases?: CodeAgentPhase[]
        },
      ) => {
        if (meta?.written && meta.written.length > 0) markVoiced(assistantId)
        setTurns((prev) =>
          prev.map((t) => {
            if (t.id !== assistantId) return t
            const wrote = !!(meta?.written && meta.written.length > 0)
            const base = {
              ...t,
              content,
              streaming: false,
              agentLabel: meta?.label ?? "Turno completado",
              agentPhases:
                meta?.phases ??
                buildCodeAgentPhases("verify", {
                  plan: { status: "done", detail: "Plan listo" },
                  context: { status: "done", detail: iterate ? "Workspace leído" : "Contexto de build listo" },
                  generate: { status: "done", detail: "Agente Codex" },
                  apply: {
                    status: "done",
                    detail: wrote ? `${meta!.written!.length} archivo(s) aplicados` : "Sin escritura de archivos",
                  },
                  verify: { status: "done", detail: wrote ? "Workspace actualizado" : "Respuesta entregada" },
                }),
            }
            if (wrote) {
              const { actions, metrics } = buildWriteMetrics(meta!.written!, {
                startedAt,
                now: Date.now(),
                getPrevContent: (p) => files[p]?.content ?? "",
                read: meta?.read,
              })
              return {
                ...base,
                actions,
                metrics,
                voice: buildSpokenSummary({
                  kind: iterate ? "patch" : "engine",
                  filesChanged: metrics.filesChanged,
                  durationMs: metrics.timeWorkedMs,
                }),
              }
            }
            return base
          }),
        )
      }

      // Stream a single Codex run to a terminal status, folding its events onto
      // the assistant turn. Returns the final fold state (status + collected
      // written/read paths + narrative). Reject only for a hard transport error.
      const streamRun = (runId: string, fold: CodexEngineFoldState) =>
        new Promise<CodexEngineFoldState>((resolve, reject) => {
          let state = fold
          let lastPhase = state.phase
          const applyRender = () => {
            // Narrative + the Claude Code-style live action feed (⏺ Escribiendo
            // `src/App.tsx`… → ✓) so the user watches the agent work in vivo.
            const live = `${codexLiveContent(state)}${codexLiveActionsMarkdown(state)}`.trim()
            const phaseDetail =
              state.status === "waiting_approval"
                ? "Plan propuesto"
                : state.writtenPaths.length > 0
                  ? `${state.writtenPaths.length} archivo(s)`
                  : state.commandCount > 0
                    ? `${state.commandCount} comando(s)`
                    : "El agente está trabajando"
            const phaseKey = state.phase
            const label =
              phaseKey === "apply"
                ? "Aplicando cambios al workspace"
                : phaseKey === "verify"
                  ? "Verificando el resultado"
                  : "Generando con Agente Codex"
            const phases = buildCodeAgentPhases(phaseKey, {
              plan: { status: "done", detail: "Plan listo" },
              context: { status: "done", detail: iterate ? "Workspace leído" : "Contexto de build listo" },
              ...(phaseKey === "generate"
                ? { generate: { status: "running", detail: phaseDetail } }
                : {}),
              ...(phaseKey === "apply"
                ? { generate: { status: "done", detail: "Trabajo del agente" }, apply: { status: "running", detail: phaseDetail } }
                : {}),
            })
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId
                  ? { ...t, ...(live ? { content: live } : {}), agentLabel: label, agentPhases: phases }
                  : t,
              ),
            )
          }
          const handle = openRunStream({
            runId,
            onEvent: (ev) => {
              const nextState = foldCodexEvent(state, ev)
              if (nextState !== state) {
                state = nextState
                if (state.phase !== lastPhase || ev.type === "narrative_delta" || ev.type === "reasoning_delta" || ev.type === "action_start" || ev.type === "action_end") {
                  lastPhase = state.phase
                  applyRender()
                }
              }
            },
            onStatus: (status) => {
              state = { ...state, status }
            },
            token,
            // A plan run PARKS at waiting_approval (approval spawns a new build
            // run) — this engine auto-approves, so that status must resolve the
            // stream instead of reconnecting forever (found in live E2E).
            terminalStatuses: ["done", "error", "cancelled", "waiting_approval"],
          })
          // The stream resolves its `done` promise on a terminal run_status or
          // close(); if the user cancels the turn we abort it via the controller.
          const onAbort = () => handle.close()
          controller.signal.addEventListener("abort", onAbort)
          handle.done
            .then(() => resolve(state))
            .catch(reject)
            .finally(() => controller.signal.removeEventListener("abort", onAbort))
        })

      // Terminal turn state for Detener: streamRun RESOLVES on close() (it does
      // not reject), so without an explicit cancelled check the flow would fall
      // into the deterministic fallback and build the app the user just stopped.
      const finishStopped = () =>
        finish("_Generación detenida._", {
          label: "Generación detenida",
          phases: buildCodeAgentPhases("generate", {
            generate: { status: "done", detail: "Detenida por el usuario" },
          }),
        })

      try {
        // 1) Ensure ONE Codex project per chat session. The in-memory ref is a
        //    fast cache; localStorage is the durable record so a reload does
        //    NOT mint a fresh empty project that iterate would then edit and
        //    sync back over the local workspace. A persisted id is verified
        //    against the backend (it may have been deleted or belong to another
        //    account after a re-login) before being trusted.
        let projectId: string | undefined = codexProjectRef.current[sid]
        if (!projectId) {
          const persisted = readPersistedCodexProject(sid)
          if (persisted) {
            try {
              const existing = await codexApi.getProject(persisted)
              if (existing?.id) projectId = existing.id
            } catch {
              clearPersistedCodexProject(sid)
            }
          }
        }
        if (!projectId) {
          const title = compactGeneratedTitle(text)
          const project = await codexApi.createProject(title)
          projectId = project.id
        }
        codexProjectRef.current[sid] = projectId
        persistCodexProject(sid, projectId)

        setEnginePhase(
          iterate ? "Preparando turno del agente" : "Planificando la construcción",
          buildCodeAgentPhases("context", {
            plan: { status: "done", detail: "Proyecto Codex listo" },
            context: { status: "running", detail: iterate ? "Sincronizando workspace" : "Preparando build" },
          }),
        )

        // 1b) Iterate edits the REMOTE project and syncs the result back over
        //     the local workspace — so the remote tree must first BE the local
        //     tree. Push the browser workspace into the project before the run;
        //     if the import fails, abort this tier (editing a stale/foreign
        //     tree and overwriting the local files with it is strictly worse
        //     than falling back) and let dispatch use the next engine.
        if (iterate) {
          const workspaceFiles = collectWorkspaceFilesForImport(files)
          if (workspaceFiles.length > 0) {
            try {
              await codexApi.importFiles(projectId, workspaceFiles)
            } catch (err: any) {
              if (cancelledTurn()) {
                finishStopped()
                return
              }
              const detail = err?.message || "no se pudo sincronizar el workspace"
              finish(
                "_No pude sincronizar tu workspace con el proyecto del Agente Codex, así que no lo toco (editar otro árbol pisaría tus archivos). Sigo con otro motor…_",
                {
                  label: "Sincronización fallida",
                  phases: buildCodeAgentPhases("context", {
                    plan: { status: "done", detail: "Proyecto Codex listo" },
                    context: { status: "error", detail },
                  }),
                },
              )
              toast.error("No pude sincronizar el workspace con Codex; uso otro motor.")
              return "workspace_sync_failed"
            }
            if (cancelledTurn()) {
              finishStopped()
              return
            }
          }
        }

        // 2) Start a `plan` run for the user's order. Codex requires a plan run
        //    before a build; the plan auto-approves into build below.
        const planRun = await codexApi.createRun(projectId, {
          mode: "plan",
          // APPS-mode envelope → backend forces the Vite SPA stack + runs the
          // ensureAppsVitePreviewable auto-repair, so the generated app opens in
          // the preview instead of an error overlay (root cause of the overlays).
          prompt: buildAppsModePrompt(text),
          model: activeModelName || undefined,
          // The runs API speaks eco|standard|power — a provider name here used
          // to reach the backend as an unknown tier and always fell to Eco.
          tier: tierForModelChoice(activeProvider, activeModelName),
        })

        setEnginePhase(
          "Generando con Agente Codex",
          buildCodeAgentPhases("generate", {
            plan: { status: "done", detail: "Proyecto Codex listo" },
            context: { status: "done", detail: iterate ? "Workspace leído" : "Contexto de build listo" },
            generate: { status: "running", detail: "El agente está trabajando" },
          }),
        )

        // 3) Stream the plan run to its terminal / waiting_approval status, then
        //    approve it → build run, and stream that to a terminal status.
        let fold = await streamRun(planRun.id, initialCodexEngineFold())
        // Detener during the plan stream: the stream resolves (close(), not a
        // reject) — bail out before approving a plan the user just cancelled.
        if (cancelledTurn()) {
          finishStopped()
          return
        }
        if (fold.status === "waiting_approval") {
          const buildRun = await codexApi.approvePlan(projectId, planRun.id, tierForModelChoice(activeProvider, activeModelName))
          // Reset the fold for the build run's own event/seq stream.
          fold = await streamRun(buildRun.id, initialCodexEngineFold())
        }
        // Detener during the build stream: same shape — no files, no fallback.
        if (cancelledTurn()) {
          finishStopped()
          return
        }

        const narrative = codexLiveContent(fold)
        const succeeded = fold.status === "done"

        if (succeeded) {
          // 4) Pull the files the run wrote. Prefer the bounded set of
          //    file_write paths seen in the stream; else list the whole tree.
          let paths = fold.writtenPaths.filter(Boolean)
          if (paths.length === 0) {
            try {
              paths = await codexApi.listFiles(projectId)
            } catch {
              paths = []
            }
          }
          const sourcePaths = paths
            .filter((p) => !/(^|\/)(node_modules|\.git|dist|build|\.next)\//.test(p))
            .slice(0, 80)
          const { files: written, failed: pullFailed } = await pullProjectFiles(
            codexApi,
            projectId!,
            sourcePaths,
          )
          // Cancelled while pulling the files back → never apply post-cancel.
          if (cancelledTurn()) {
            finishStopped()
            return
          }
          // Iterate edits an EXISTING project: applying a partial tree mixes
          // stale local files with the remote edit — worse than not touching
          // anything. Refuse when >20% stayed unreadable after the retry.
          if (iterate && pullFailed.length > 0 && pullFailed.length * 5 > sourcePaths.length) {
            finish(
              `⚠️ No apliqué los cambios: ${pullFailed.length} de ${sourcePaths.length} archivo(s) no se pudieron leer del workspace remoto — aplicar un árbol parcial dejaría el proyecto mezclado. Reintenta la iteración.`,
            )
            toast.error(
              `Agente Codex — lectura incompleta (${pullFailed.length}/${sourcePaths.length}); no se aplicó nada`,
            )
            return
          }
          if (written.length > 0) {
            applyFilesToWorkspace(written)
            const tally =
              pullFailed.length > 0
                ? `${written.length} de ${sourcePaths.length} archivo(s) (${pullFailed.length} no se pudieron leer)`
                : `${written.length} archivo(s)`
            finish(
              narrative
                ? `${narrative}\n\n_(Agente Codex: ${tally} →)_`
                : `✅ Agente Codex — ${tally} →`,
              { written },
            )
            if (pullFailed.length > 0) toast.warning(`Agente Codex — ${tally}`)
            else toast.success(`Agente Codex — ${written.length} archivo(s) →`)
            return
          }
          // Run finished OK but produced no files (e.g. a pure Q&A/plan turn):
          // render the narrative if any, else fall through to the fallback.
          if (narrative && iterate) {
            finish(narrative)
            return
          }
        }

        // 5) FALLBACK: the run failed / produced nothing usable → deterministic
        //    builder so the user is NEVER left empty (mirrors runEngine). A
        //    cancelled turn NEVER reaches here (early returns above) — Detener
        //    must not trigger a build of the very app the user just stopped.
        if (!iterate) {
          // omitUserTurn: this codex turn already rendered the user's message.
          await buildApp(text, undefined, { omitUserTurn: true })
          finish(
            narrative
              ? `${narrative}\n\n_(El agente no dejó archivos; usé el builder determinista.)_`
              : "✅ App generada (builder determinista).",
          )
          return
        }
        finish(narrative || "_(el agente no devolvió cambios)_")
      } catch (err: any) {
        const aborted =
          cancelledTurn() ||
          err?.name === "AbortError" ||
          /\babort|cancel|operation was aborted/i.test(err?.message || "")
        if (aborted) {
          finish("_Generación detenida._", {
            label: "Generación detenida",
            phases: buildCodeAgentPhases("generate", {
              generate: { status: "done", detail: "Detenida" },
            }),
          })
        } else if (!opts?.iterate) {
          // Project provisioning / plan-run error during a BUILD → still deliver
          // via the deterministic builder in the same turn (omitUserTurn: this
          // codex turn already rendered the user's message).
          try {
            await buildApp(text, undefined, { omitUserTurn: true })
            finish("✅ App generada (builder determinista). El Agente Codex no respondió.")
            toast.success("App generada (builder determinista) →")
          } catch {
            finish(`_${err?.message || "El Agente Codex no respondió"}_`, {
              label: "Error en el turno",
              phases: buildCodeAgentPhases("generate", {
                generate: { status: "error", detail: err?.message || "El Agente Codex no respondió" },
              }),
            })
            toast.error(err?.message || "El Agente Codex no respondió")
          }
        } else {
          finish(`_${err?.message || "El Agente Codex no respondió"}_`, {
            label: "Error en el turno",
            phases: buildCodeAgentPhases("generate", {
              generate: { status: "error", detail: err?.message || "El Agente Codex no respondió" },
            }),
          })
          toast.error(err?.message || "El Agente Codex no respondió")
        }
      } finally {
        try {
          controller.abort()
        } catch {
          /* already closed */
        }
        // Only release the shared latch if THIS turn is still the active one —
        // a zombie turn settling after Detener (or after a newer turn started)
        // must not knock down the new turn's busy/abort state.
        if (abortRef.current === controller) {
          abortRef.current = null
          setBusy(false)
        }
      }
    },
    [activeModelName, activeProvider, applyFilesToWorkspace, buildApp, files, markVoiced, setTurns, token],
  )

  const dispatch = React.useCallback(
    async (rawInput: string, opts?: { forceDeterministic?: boolean }) => {
      const text = rawInput.trim()
      if (!text) return
      if (busy || buildingApp) {
        // The live dev server can fire a BACKGROUND auto-repair turn (it failed
        // to boot, e.g. a cold install over the 90s timeout) that holds the busy
        // latch. The user's explicit message must NEVER be lost to it: cancel a
        // background repair, then park the message so the idle-drain effect runs
        // it the moment the panel settles.
        if (repairInFlightRef.current) {
          abortRef.current?.abort()
          abortRef.current = null
          repairInFlightRef.current = false
        }
        pendingInputRef.current.push(rawInput)
        setInput("")
        toast("Recibido — lo proceso en cuanto termine la tarea en curso…")
        return
      }
      if (!user || !token) {
        toast.error("Inicia sesión para usar el chat de código.")
        return
      }
      if (!sessionId) {
        toast.error("Abre o crea un chat de código (la carpeta/agente no está activo). Recarga si abriste una carpeta local que no montó.")
        return
      }
      const sid = sessionId
      if (isQuickGreeting(text)) {
        // With a live model the greeting is a REAL chat turn (varied, aware of
        // the conversation) — the canned line is only the no-model fallback.
        if (activeModelName) {
          await sendPrompt(text, {
            systemPrompt: CONVERSATION_SYSTEM_PROMPT,
            autoApply: false,
            plainStyle: true,
          })
          patchAgentState(sid, (s) => ({ ...s, phase: s.phase === "intake" ? "idle" : s.phase }))
          return
        }
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const greeting =
          "¡Hola! 👋 Soy tu agente de apps. Dime qué quieres construir o cambiar y me pongo manos a la obra — escribo el código, lo ejecuto y lo corrijo."
        markVoiced(`${id}-a`)
        setTurns((prev) => [
          ...prev,
          { id, role: "user", content: text },
          {
            id: `${id}-a`,
            role: "assistant",
            content: greeting,
            streaming: false,
            // The action row for the greeting: honest, minimal steps the agent
            // took (no fabricated file work). Renders the "N acciones" chip.
            actions: [
              { kind: "reasoning", label: "Entendí tu saludo" },
              { kind: "reasoning", label: "Revisé el estado del proyecto" },
              { kind: "reasoning", label: "Preparé el plan de trabajo" },
            ],
            // Voice the greeting with the BROWSER's built-in speech synthesis
            // (Web Speech API) — 100% local, no API key, no server/credit cost.
            // ChatBubble renders an inline voice player from this text.
            voice: greeting,
          },
        ])
        setInput("")
        patchAgentState(sid, (s) => ({ ...s, phase: "idle" }))
        return
      }

      // CONVERSATION tier: questions / doubts / meta get a chat answer — never
      // the intake or the generator ("quiero preguntarte algo" used to build an
      // app because "quiero" counts as a build verb). Applies ALWAYS — a stalled
      // intake used to swallow "¿puedes ayudarme?" into a build; slot answers
      // ("una cafetería") are not conversational, so the FSM still gets them.
      if (isConversationalMessage(text)) {
        if (activeModelName) {
          await sendPrompt(text, {
            systemPrompt: CONVERSATION_SYSTEM_PROMPT,
            autoApply: false,
            plainStyle: true,
          })
        } else {
          const cid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const reply =
            "¡Claro! Dime tu pregunta — soy tu agente de apps: creo y edito proyectos, los ejecuto en el preview y los publico. Cuando quieras que construya o cambie algo, pídemelo."
          markVoiced(`${cid}-a`)
          setTurns((prev) => [
            ...prev,
            { id: cid, role: "user", content: text },
            {
              id: `${cid}-a`,
              role: "assistant",
              content: reply,
              streaming: false,
              actions: [{ kind: "reasoning", label: "Entendí tu mensaje" }],
              voice: reply,
            },
          ])
          setInput("")
          patchAgentState(sid, (s) => ({ ...s, phase: "idle" }))
        }
        return
      }

            // Deterministic build shortcut — ONLY when the real agent is unavailable.
      // With Codex up, classic build requests ("créame una app de X") must flow
      // to the agent below; this shortcut used to swallow them into a template.
      // "ok, créala" carries no substance of its own — recover the brief from
      // the recent conversation so EVERY build tier (codex / engine /
      // deterministic) receives what was actually discussed. The user bubble
      // keeps the literal words via displayText.
      const derivedBrief = isBareBuildCommand(text)
        ? briefFromConversation(turns.map((t) => ({ role: t.role, content: t.content })))
        : null
      const buildText = derivedBrief ?? text

      if ((composerMode === "app" || composerMode === "build") && !codexAvailable && isBuildRequest(buildText)) {
        const direct = nextAgentAction(defaultAgentState(), buildText, {
          mode: composerMode,
          hasModel: false,
        })
        if (direct.type === "generate") {
          patchAgentState(sid, (s) => ({ ...s, phase: "generating", context: direct.context }))
          await buildApp(promptFromContext(direct.context), { ...direct.context, productType: buildText })
          patchAgentState(sid, (s) => ({ ...s, phase: "preview", generator: "deterministic" }))
          return
        }
      }

      const agent = activeCodeChatSession?.agent ?? defaultAgentState()
      const action = nextAgentAction(agent, buildText, {
        mode: composerMode,
        forceDeterministic: opts?.forceDeterministic,
        hasModel: !!activeModelName,
      })

      switch (action.type) {
        case "generate": {
          patchAgentState(sid, (s) => ({ ...s, phase: "generating", context: action.context }))
          const hasIntake = !!(action.context.productType || action.context.brand)
          const genPrompt = hasIntake ? promptFromContext(action.context) : buildText
          // Deterministic tier: enrich a bare context with the raw prompt so the
          // local scaffold still produces niche-coherent copy.
          const buildCtx = hasIntake ? action.context : { ...action.context, productType: buildText }
          if (!opts?.forceDeterministic && codexAvailable) {
            // Codex Agent V2 (the REAL server-driven agent): drives a plan→build
            // run whose file writes are read back into the workspace, with a
            // deterministic buildApp fallback inside so a build always lands.
            await runCodexEngine(buildText, sid, { displayText: text })
            patchAgentState(sid, (s) => ({ ...s, phase: "preview", generator: "llm" }))
          } else if (!opts?.forceDeterministic && engineMode && engineAvailable) {
            // OpenCode agent (only truly available in Docker AND opt-in via the
            // "Motor" toggle): it writes the project files into its /workspace via
            // a funded model and runEngine reads them back — deterministic
            // fallback inside. Without an explicit Motor opt-in the deterministic
            // builder below is the primary path (fast, no ~30s GCLB stream cut).
            await runEngine(buildText, sid, { buildContext: action.context, displayText: text })
            patchAgentState(sid, (s) => ({ ...s, phase: "preview", generator: "llm" }))
          } else {
            // First build → the deterministic builder is the PRIMARY path. It is
            // LLM-free, returns in seconds, and emits full project files plus a
            // self-contained index.html live preview, so it never hits the ~30s
            // GCLB stream cut that left the chat-streaming generation "cargando"
            // forever on the Reserved VM.
            // (This branch previously streamed the whole project from the chat
            // model — the source of the hang/errors the user reported.)
            await buildApp(genPrompt, buildCtx)
            patchAgentState(sid, (s) => ({ ...s, phase: "preview", generator: "deterministic" }))
          }
          return
        }
        case "patch": {
          if (runDeterministicPatch(action.instruction, sid)) {
            return
          }
          if (codexAvailable) {
            // Codex build mode iterates on follow-ups (it syncs the local
            // workspace into the session's project, edits it and reads the
            // tree back). A failed workspace sync means Codex would edit the
            // WRONG tree — treat it as "Codex unavailable" for this turn.
            const out = await runCodexEngine(action.instruction, sid, { iterate: true })
            if (out !== "workspace_sync_failed") return
          }
          if (engineMode && engineAvailable) {
            await runEngine(action.instruction, sid, { iterate: true })
          } else {
            await sendPrompt(action.instruction, { autoApply: true })
          }
          return
        }
        case "debug": {
          patchAgentState(sid, (s) => ({ ...s, phase: "debugging", lastError: action.log }))
          if (composerMode === "debug" && activeModelName) {
            await sendPrompt(text, {
              systemPrompt: sreSystemPrompt(action.log, collectConfigFiles(files)),
              autoApply: true,
              spokenKind: "debug",
            })
          } else {
            await runDeterministicSRE(action.log, text, sid)
          }
          return
        }
        default:
          // Ask/Plan/Image are read-only: they must stream an answer via
          // sendPrompt (autoApply stays false because composerMode !== "app")
          // and must NEVER route into runCodexEngine/runEngine, which apply files.
          if ((composerMode === "app" || composerMode === "build") && codexAvailable) {
            // Codex build mode iterates on the session's existing project
            // (after syncing the local workspace into it). A failed sync falls
            // through to the next tier as if Codex were unavailable.
            const out = await runCodexEngine(buildText, sid, { iterate: true, displayText: text })
            if (out !== "workspace_sync_failed") return
          }
          if (
            (composerMode === "app" || composerMode === "build") &&
            engineMode &&
            engineAvailable
          ) {
            await runEngine(buildText, sid, { displayText: text })
          } else {
            await sendPrompt(text, { autoApply: composerMode === "app" || composerMode === "build" })
          }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeCodeChatSession,
      activePath,
      activeFolder,
      activeModelName,
      buildApp,
      busy,
      buildingApp,
      codexAvailable,
      composerMode,
      engineAvailable,
      engineMode,
      files,
      includeContext,
      patchAgentState,
      runCodexEngine,
      runDeterministicSRE,
      runDeterministicPatch,
      runEngine,
      sendPrompt,
      sessionId,
      setTurns,
      token,
      user,
    ],
  )

  // Stable ref to the latest dispatch so the idle-drain effect can run a parked
  // message without re-subscribing every time dispatch's identity changes.
  const dispatchRef = React.useRef(dispatch)
  dispatchRef.current = dispatch

  // Idle-drain: the instant the panel stops being busy, run the messages the
  // user submitted while it was busy (queued FIFO in pendingInputRef), in
  // arrival order and one at a time. If a dispatched message settles without
  // ever taking the busy latch (e.g. a canned greeting), busy never toggles and
  // this effect would not re-run — so the drain loops until the queue is empty
  // or the panel goes busy again (that turn's settle resumes the drain).
  React.useEffect(() => {
    if (busy || buildingApp) return
    if (pendingInputRef.current.length === 0) return
    let cancelled = false
    void (async () => {
      while (!cancelled && !busyRef.current && !buildingAppRef.current) {
        const parked = pendingInputRef.current.shift()
        if (!parked) return
        await dispatchRef.current?.(parked)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [busy, buildingApp])

  // Tool-initiated agent requests: workspace tools (Auth, Automations, …) emit
  // `siragpt:code-agent-request` with a plain instruction. It flows through the
  // SAME dispatch as a typed message — busy panels park it in pendingInputRef
  // and the idle-drain above runs it as soon as the current turn settles.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const handler = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text?.trim()
      if (!text) return
      if (busyRef.current || buildingAppRef.current) {
        pendingInputRef.current.push(text)
        return
      }
      void dispatchRef.current?.(text)
    }
    window.addEventListener("siragpt:code-agent-request", handler)
    return () => window.removeEventListener("siragpt:code-agent-request", handler)
  }, [])

  // Orphan-turn recovery: if the browser persisted a user message but the
  // assistant turn was never created/completed (tab reload, stale busy latch,
  // or a previous build that swallowed the submit), retry it automatically.
  const recoveredOrphanTurnRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    if (busy || buildingApp) return
    const last = turns[turns.length - 1]
    if (!last || last.role !== "user") return
    const text = last.content.trim()
    if (!text || recoveredOrphanTurnRef.current.has(last.id)) return

    recoveredOrphanTurnRef.current.add(last.id)
    setTurns((prev) => (prev[prev.length - 1]?.id === last.id ? prev.slice(0, -1) : prev))
    const timer = window.setTimeout(() => {
      void dispatchRef.current?.(text)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [busy, buildingApp, setTurns, turns])

  // Stale-busy watchdog: a streaming turn keeps abortRef set; if busy stays true
  // with NO stream in flight (abortRef cleared) past a grace period, the latch is
  // wedged — recover the composer so it (and any parked message) is never stuck.
  React.useEffect(() => {
    if (!busy) return
    const t = window.setTimeout(() => {
      if (!abortRef.current) {
        setBusy(false)
        repairInFlightRef.current = false
      }
    }, 30_000)
    return () => window.clearTimeout(t)
  }, [busy])

  // Stale-build watchdog: buildApp awaits a builder fetch that is now time-bound
  // (intakeService.generate aborts at 120s), but a wedged buildingApp would still
  // block the composer. As a backstop, recover the latch if it stays set past a
  // generous ceiling — a real build (local scaffold or bounded fetch) always
  // settles well within it.
  React.useEffect(() => {
    if (!buildingApp) return
    const t = window.setTimeout(() => setBuildingApp(false), 150_000)
    return () => window.clearTimeout(t)
  }, [buildingApp])

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    dispatch(input)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      dispatch(input)
    }
  }

  const activeFileLabel = activePath ? activePath.split("/").pop() || activePath : null
  const activeSessionTitle =
    codeChatSessions.find((session) => session.id === activeCodeChatSessionId)?.title?.trim() ||
    "Nuevo chat"

  // Replit-style "Plan" pill: flips the composer into plan mode and back to
  // whatever mode was active before (defaults to "app").
  const planReturnModeRef = React.useRef<ComposerMode>("app")
  const togglePlanMode = React.useCallback(() => {
    if (composerMode === "plan") {
      setComposerMode(planReturnModeRef.current)
    } else {
      planReturnModeRef.current = composerMode
      setComposerMode("plan")
    }
    inputRef.current?.focus()
  }, [composerMode])

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-50/70 text-foreground dark:bg-zinc-950">
      {/* Replit-style panel header: current thread title + history / new-chat
          actions (the session tabs collapsed into the history dropdown). */}
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border/60 bg-background px-3">
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground"
          title={activeSessionTitle}
        >
          {activeSessionTitle}
        </span>
        {activeFileLabel ? (
          <span
            className="min-w-0 shrink truncate rounded-md border border-border/50 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/85"
            title={activePath ?? undefined}
          >
            {activeFileLabel}
          </span>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
              aria-label="Historial de chats"
              title="Historial de chats"
            >
              <History className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60 rounded-lg border-border/70 p-1.5">
            <DropdownMenuLabel className="px-2 py-1 text-[11px] font-normal text-muted-foreground">
              Chats del proyecto
            </DropdownMenuLabel>
            {codeChatSessions.map((session) => (
              <DropdownMenuItem
                key={session.id}
                className={cn(
                  "gap-2 rounded-md text-[13px]",
                  session.id === activeCodeChatSessionId && "bg-muted/70 font-medium",
                )}
                onClick={() => setActiveCodeChatSession(session.id)}
              >
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                {session.id === activeCodeChatSessionId ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
          aria-label="Nuevo agente"
          title="Nuevo chat en paralelo"
          onClick={() => createCodeChatSession()}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {turns.length === 0 ? (
          <EmptyChat active={agentsActive} />
        ) : (
          <div className="space-y-3">
            {turns.map((turn) => (
              <CodeChatErrorBoundary key={turn.id} label="code-chat-turn">
                <ChatBubble
                  turn={turn}
                  lookupContent={(path) => files[path]?.content ?? ""}
                />
              </CodeChatErrorBoundary>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="shrink-0 px-3 pb-3 pt-2">
        {/* Replit-style composer card: the text field on top, then a footer
            row with + on the left and model / Plan / mic / send on the right. */}
        <div className="group rounded-xl border border-border/70 bg-background px-3 py-2.5 shadow-sm transition-[border-color,box-shadow] focus-within:border-[#0f87ff]/50 focus-within:shadow-[0_0_0_3px_rgba(15,135,255,0.10)]">
          <Textarea
            aria-label="Mensaje para el chat de código"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={COMPOSER_PLACEHOLDER[composerMode]}
            rows={1}
            className="max-h-[140px] min-h-[28px] resize-none border-0 bg-transparent px-1 py-0.5 text-[13px] leading-[1.45] shadow-none outline-none ring-0 placeholder:text-muted-foreground/55 focus-visible:ring-0"
          />
          <div className="mt-1.5 flex items-center gap-1">
            <ComposerPlusMenu
              mode={composerMode}
              includeContext={includeContext}
              activeFileLabel={activeFileLabel}
              engineAvailable={engineAvailable}
              engineMode={engineMode}
              onModeChange={(mode) => {
                setComposerMode(mode)
                inputRef.current?.focus()
              }}
              onIncludeContextChange={setIncludeContext}
              onEngineModeChange={setEngineMode}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={toggleTargetSelection}
              aria-pressed={selectingTarget}
              aria-label={selectingTarget ? "Cancelar selección visual" : "Seleccionar elemento del preview"}
              title={selectingTarget ? "Cancelar selección visual" : "Seleccionar elemento del preview"}
              className={cn(
                "code-target-select-button h-8 w-8 shrink-0 rounded-lg",
                selectingTarget && "code-target-select-button--active",
              )}
            >
              <CodeTargetSelectIcon className="code-target-select-button__icon h-6 w-6" />
            </Button>
            <span className="min-w-0 flex-1" />
            <ModelPickerInline
              models={pickerModels}
              selectedModel={activeModelName || ""}
              fast={modelIsFast}
              onSelect={(m) => chooseCodeModel({ name: m.name, provider: m.provider })}
            />
            <button
              type="button"
              onClick={togglePlanMode}
              aria-pressed={composerMode === "plan"}
              title="Planear antes de editar archivos"
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors",
                composerMode === "plan"
                  ? "border-[#0f87ff]/40 bg-[#0f87ff]/10 text-[#0b6ccc] dark:text-[#5ab3ff]"
                  : "border-border/45 text-muted-foreground hover:bg-muted/40 hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border transition-colors",
                  composerMode === "plan"
                    ? "border-[#0f87ff] bg-[#0f87ff] text-white"
                    : "border-border",
                )}
                aria-hidden="true"
              >
                {composerMode === "plan" ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
              </span>
              Plan
            </button>
            <DictationButton
              variant="light"
              locale={typeof navigator !== "undefined" ? navigator.language : "es-ES"}
              onTranscript={(text) => {
                const chunk = text.trim()
                if (!chunk) return
                setInput((prev) => normalizeChatInput(prev ? `${prev} ${chunk}` : chunk).value)
                inputRef.current?.focus()
              }}
            />
            {busy ? (
              <>
                {input.trim() ? (
                  <Button
                    type="submit"
                    size="icon"
                    className="h-8 w-8 shrink-0 rounded-full bg-[#0f87ff] text-white transition-colors hover:bg-[#0c74dd]"
                    aria-label="Enviar al terminar"
                    title="Enviar al terminar"
                  >
                    <ArrowUp className="h-4 w-4" strokeWidth={2.25} />
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0 rounded-full text-foreground hover:bg-muted"
                  onClick={cancelStream}
                  aria-label="Detener"
                >
                  <StopCircle className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <Button
                type="submit"
                size="icon"
                className={cn(
                  "h-8 w-8 shrink-0 rounded-full transition-colors",
                  input.trim()
                    ? "bg-[#0f87ff] text-white hover:bg-[#0c74dd]"
                    : "bg-muted text-muted-foreground/50",
                )}
                disabled={!input.trim()}
                aria-label="Enviar"
              >
                <ArrowUp className="h-4 w-4" strokeWidth={2.25} />
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}

function EmptyChat({ active }: { active: boolean }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[hsl(var(--accent-violet)/0.28)] bg-[hsl(var(--accent-violet)/0.10)] text-[hsl(var(--accent-violet))]">
        <Sparkles className={cn("h-5 w-5", active && "animate-pulse")} />
      </span>
      <h2 className="mt-4 text-base font-semibold tracking-tight text-foreground">
        ¿Qué quieres construir?
      </h2>
      <p className="mt-1.5 max-w-[18rem] text-[13px] leading-relaxed text-muted-foreground">
        Describe tu idea, pide paquetes npm y el agente crea, ejecuta, verifica y corrige el preview en vivo.
      </p>
    </div>
  )
}

function ChatBubble({
  turn,
  lookupContent,
}: {
  turn: CodeChatTurn
  lookupContent: (path: string) => string
}) {
  const isUser = turn.role === "user"
  const blocks = React.useMemo(
    () => (turn.role === "assistant" ? parseCodeBlocks(turn.content) : []),
    [turn.content, turn.role],
  )

  // USER messages: right-aligned dark-blue bubble with light text (the spec's
  // user style). No code-block parsing — the user types prompts, not code cards.
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-muted/55 px-3.5 py-2 text-sm leading-relaxed text-foreground shadow-sm">
          {turn.content}
        </div>
      </div>
    )
  }

  // ASSISTANT messages: left-aligned, plain background, clean typography (no
  // colored bubble) — direct text on the interface, with the code-block cards.
  const blocker = detectBlocker(turn.content)
  // Pull the model's gerund-led planning line into the status badge (like the
  // agent dashboard) and narrate the rest. Falls back to a generic badge while
  // streaming before the planning line lands.
  const { label: planLabel, body } = extractPlanLabel(turn.content)
  const liveAgentLabel = planLabel || turn.agentLabel || (turn.streaming ? "Pensando" : "")
  return (
    <div className="text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        Asistente
        {liveAgentLabel ? (
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 normal-case tracking-normal text-foreground/80">
            <BrainCircuit className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate font-medium">{liveAgentLabel}</span>
            {!turn.streaming && typeof turn.planMs === "number" ? (
              <span className="opacity-60">({formatWorked(turn.planMs)})</span>
            ) : null}
            {turn.streaming ? (
              <DotmCircular15 size={16} dotSize={2} color={THINKING_GLYPH_COLOR} ariaLabel="Pensando" className="inline shrink-0" />
            ) : null}
          </span>
        ) : null}
      </div>
      {/* 5-step agent progress rail (Plan → Contexto → Generar → Aplicar →
          Verificar). Populated from REAL turn state by the build/app/engine
          paths; renders nothing for turns that never set agentPhases. */}
      <CodeAgentProgress phases={turn.agentPhases} />
      {/* Voiced turn (e.g. the greeting): action rows + inline voice player
          ABOVE the text, so the reply reads actions → audio → text. The player
          generates ElevenLabs audio (voz femenina multilingüe) SOLO cuando el
          usuario pulsa play — nunca automático — con fallback local gratuito.
          Only for turns that carry `voice`; build turns keep their layout. */}
      {turn.voice ? (
        <div className="mb-2 space-y-2">
          {turn.actions && turn.actions.length > 0 ? <ChatActionLog actions={turn.actions} /> : null}
          <BrowserVoicePlayer text={turn.voice} />
        </div>
      ) : null}
      {/* An out-of-credits / quota error surfaces as a high-visibility panel
          instead of plain prose; otherwise render the assistant text normally. */}
      {blocker ? (
        <ChatBlockerPanel title={blocker.title} rawError={turn.content} url={blocker.url} />
      ) : (
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {/* `body` already drops the planning line (now in the badge); strip
              fenced blocks too so prose isn't shown twice (here + block cards). */}
          {blocks.length > 0 ? stripFences(body) : body}
        </div>
      )}
      {(() => {
        const applicable = blocks.filter((b) => b.path)
        return applicable.length >= 2 ? (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-2.5 py-1.5">
            <span className="text-[11px] text-muted-foreground">
              {applicable.length} archivos en esta respuesta
            </span>
          </div>
        ) : null
      })()}
      {blocks.map((block) => (
        <CodeBlockCard
          key={block.index}
          block={block}
          existingContent={block.path ? lookupContent(block.path) : ""}
        />
      ))}
      {/* Real action log + mandatory Worked Summary — only when the turn did
          measurable file work (build/app/engine paths populate these). A voiced
          turn already showed its actions above (next to the voice player). */}
      {!turn.voice && turn.actions && turn.actions.length > 0 ? <ChatActionLog actions={turn.actions} /> : null}
      {turn.metrics ? <ChatWorkedSummary metrics={turn.metrics} /> : null}
    </div>
  )
}

function stripFences(text: string): string {
  return text.replace(/```[^\n`]*\n[\s\S]*?```/g, "").trim()
}

function CodeAgentProgress({ phases }: { phases?: CodeAgentPhase[] }) {
  if (!phases || phases.length === 0) return null

  // Replit-style task checklist: one compact row per phase with a status
  // glyph, instead of a boxed grid — same real per-turn state underneath.
  return (
    <div className="mb-2 space-y-1">
      {phases.map((phase) => {
        const isDone = phase.status === "done"
        const isRunning = phase.status === "running"
        const isError = phase.status === "error"
        return (
          <div key={phase.key} className="flex min-w-0 items-center gap-2 text-[12px] leading-tight">
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                isDone && "border-emerald-500/40 bg-emerald-500 text-white",
                isRunning && "border-blue-500/40 bg-blue-500 text-white",
                isError && "border-red-500/40 bg-red-500 text-white",
                phase.status === "pending" && "border-border bg-background text-muted-foreground",
              )}
              aria-hidden="true"
            >
              {isDone ? <Check className="h-3 w-3" /> : isError ? <AlertTriangle className="h-3 w-3" /> : isRunning ? <DotmCircular15 size={14} dotSize={2} color="#ffffff" ariaLabel="Trabajando" className="shrink-0" /> : null}
            </span>
            <span
              className={cn(
                "truncate font-medium",
                isDone && "text-foreground/85",
                isRunning && "text-foreground",
                isError && "text-red-600 dark:text-red-400",
                phase.status === "pending" && "text-muted-foreground",
              )}
            >
              {phase.label}
            </span>
            {phase.detail ? (
              <span className="min-w-0 truncate text-muted-foreground/70">— {phase.detail}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

// Compact action log: the FULL ordered glyph sequence (">_ 📖 ✎ …") + an
// expandable list of the real file paths the agent wrote/read this turn.
function ChatActionLog({ actions }: { actions: CodeChatAction[] }) {
  const [open, setOpen] = React.useState(false)
  if (!actions.length) return null
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50"
        aria-expanded={open}
      >
        <span className="flex flex-wrap items-center gap-x-1 font-mono leading-none" aria-hidden="true">
          {actions.map((a, i) => (
            <span key={i}>{glyphForAction(a.kind)}</span>
          ))}
        </span>
        <span className="tabular-nums">
          {actions.length} {actions.length === 1 ? "acción" : "acciones"}
        </span>
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1 border-l border-border/60 pl-3 text-xs">
          {actions.map((a, i) => (
            <li key={i} className="flex items-center gap-1.5 text-muted-foreground">
              <span className="font-mono" aria-hidden="true">{glyphForAction(a.kind)}</span>
              <code className="truncate">{a.label}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// "Trabajó N s" — the mandatory Worked Summary, from REAL measured numbers.
// File/line groups show only when there was file work; tokens/cost show only
// when the stream reported real usage (cost omitted when the price is unknown).
function ChatWorkedSummary({ metrics }: { metrics: CodeChatMetrics }) {
  const hasFiles = metrics.filesChanged > 0
  const hasTokens = typeof metrics.tokensIn === "number" || typeof metrics.tokensOut === "number"
  const orig = metrics.costOriginalUsd
  const applied = typeof metrics.costAppliedUsd === "number" ? metrics.costAppliedUsd : orig
  const hasCost = typeof orig === "number" || typeof applied === "number"
  const showStrike = typeof orig === "number" && typeof applied === "number" && applied < orig
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 py-1 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground/85">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border/70">
          <Clock3 className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
        </span>
        Trabajó {formatWorked(metrics.timeWorkedMs)}
      </span>
      {hasFiles ? (
        <>
          <span>· {metrics.actionsCount} {metrics.actionsCount === 1 ? "acción" : "acciones"}</span>
          <span>· {metrics.filesChanged} archivo(s)</span>
          <span className="tabular-nums">· +{metrics.linesAdded} −{metrics.linesRemoved}</span>
        </>
      ) : null}
      {metrics.itemsReadLines > 0 ? (
        <span className="tabular-nums">· {metrics.itemsReadLines} líneas leídas</span>
      ) : null}
      {hasTokens ? (
        <span className="tabular-nums">
          · {(metrics.tokensIn ?? 0) + (metrics.tokensOut ?? 0)} tokens
        </span>
      ) : null}
      {hasCost ? (
        <span className="tabular-nums">
          ·{" "}
          {showStrike ? (
            <span className="mr-1 text-muted-foreground/60 line-through">{formatUsd(orig as number)}</span>
          ) : null}
          {formatUsd((applied ?? orig) as number)}
        </span>
      ) : null}
    </div>
  )
}

function ChatBlockerPanel({ title, rawError, url }: { title: string; rawError: string; url?: string }) {
  const isInternal = url?.startsWith("/")
  return (
    <div className="my-1 rounded-lg border border-[#FF0000]/30 bg-[#FF0000]/[0.08] p-3">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-[#C80000] dark:text-[#FF6B6B]">
        <AlertTriangle className="h-4 w-4" /> Acción requerida de su parte
      </div>
      <div className="mt-1 text-sm text-foreground">{title}</div>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/40 p-2.5 text-[11px] leading-relaxed text-zinc-300">
        {rawError.trim()}
      </pre>
      {url && (
        <a
          href={url}
          target={isInternal ? undefined : "_blank"}
          rel={isInternal ? undefined : "noopener noreferrer"}
          className="mt-2.5 inline-flex items-center gap-1.5 rounded-md bg-[#FF0000] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#E00000]"
        >
          Añadir créditos <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  )
}

function ComposerPlusMenu({
  mode,
  includeContext,
  activeFileLabel,
  engineAvailable,
  engineMode,
  onModeChange,
  onIncludeContextChange,
  onEngineModeChange,
}: {
  mode: ComposerMode
  includeContext: boolean
  activeFileLabel: string | null
  engineAvailable: boolean
  engineMode: boolean
  onModeChange: (mode: ComposerMode) => void
  onIncludeContextChange: (value: boolean) => void
  onEngineModeChange: React.Dispatch<React.SetStateAction<boolean>>
}) {
  const itemClass = "h-9 gap-2.5 rounded-md px-2.5 text-sm"
  const iconClass = "h-[18px] w-[18px] text-muted-foreground"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          aria-label="Modo, contexto y herramientas"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={10}
        className="w-[292px] rounded-lg border-border/70 p-1.5 shadow-xl"
      >
        <DropdownMenuLabel className="px-2.5 py-1.5 text-[11px] font-normal text-muted-foreground">
          {COMPOSER_MODE_LABEL[mode]}
          {activeFileLabel && includeContext ? ` · ${activeFileLabel}` : ""}
        </DropdownMenuLabel>
        <DropdownMenuItem
          className={itemClass}
          onClick={() => window.dispatchEvent(new CustomEvent(CODE_OPEN_TOOL_LAUNCHER_EVENT))}
        >
          <LayoutGrid className={iconClass} />
          <span>Todas las herramientas</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-2" />
        <DropdownMenuItem
          className={cn(itemClass, mode === "app" && "bg-muted/70 font-medium text-foreground")}
          onClick={() => onModeChange("app")}
        >
          <Rocket className={iconClass} />
          <span>App · construir desde cero</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "build" && "bg-muted/70 font-medium text-foreground")}
          onClick={() => onModeChange("build")}
        >
          <Sparkles className={iconClass} />
          <span>Build</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "deps" && "bg-muted/70 font-medium text-foreground")}
          onClick={() => onModeChange("deps")}
        >
          <PackagePlus className={iconClass} />
          <span>Deps · instalar paquetes</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "plan" && "bg-muted/70 font-medium text-foreground")}
          onClick={() => onModeChange("plan")}
        >
          <ListChecks className={iconClass} />
          <span>Plan</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "debug" && "bg-muted/70 font-medium text-foreground")}
          onClick={() => onModeChange("debug")}
        >
          <Bug className={iconClass} />
          <span>Debug</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "ask" && "bg-muted/70 font-medium text-foreground")}
          onClick={() => onModeChange("ask")}
        >
          <CircleHelp className={iconClass} />
          <span>Ask</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-2" />
        <DropdownMenuItem
          className={cn(itemClass, mode === "image" && "bg-muted/70 font-medium text-foreground")}
          onClick={() => onModeChange("image")}
        >
          <ImageIcon className={iconClass} />
          <span>Image</span>
        </DropdownMenuItem>
        {engineAvailable ? (
          <DropdownMenuCheckboxItem
            checked={engineMode}
            onCheckedChange={(checked) => onEngineModeChange(checked === true)}
            className="h-9 rounded-md text-sm"
          >
            Motor OpenCode
          </DropdownMenuCheckboxItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={itemClass}>
            <BookOpen className={iconClass} />
            <span>Skills</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52 rounded-lg p-1.5">
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onModeChange("plan")}>
              Plan de implementación
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onModeChange("debug")}>
              Diagnóstico de errores
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onModeChange("build")}>
              Edición de archivos
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={itemClass}>
            <Server className={iconClass} />
            <span>MCP Servers</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52 rounded-lg p-1.5">
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onModeChange("ask")}>
              Workspace local
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onModeChange("debug")}>
              Herramientas de código
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator className="my-2" />
        <DropdownMenuCheckboxItem
          checked={includeContext}
          onCheckedChange={(checked) => onIncludeContextChange(checked === true)}
          className="h-8 rounded-md text-sm"
        >
          Incluir contexto del workspace
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type ModelOption = { name: string; provider?: string; displayName?: string }

function ModelPickerInline({
  models,
  selectedModel,
  fast,
  onSelect,
}: {
  models: ModelOption[]
  selectedModel: string
  fast?: boolean
  onSelect: (model: ModelOption) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  const grouped = React.useMemo(() => {
    const map = new Map<string, ModelOption[]>()
    for (const m of models) {
      const provider = m.provider || "Otros"
      if (!map.has(provider)) map.set(provider, [])
      map.get(provider)!.push(m)
    }
    return Array.from(map.entries())
  }, [models])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return grouped
    return grouped
      .map(([provider, list]) => [
        provider,
        list.filter((m) => {
          const label = (m.displayName || m.name).toLowerCase()
          return label.includes(q) || provider.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
        }),
      ] as const)
      .filter(([, list]) => list.length > 0)
  }, [grouped, query])

  const active = models.find((m) => m.name === selectedModel)
  const label = active?.displayName || active?.name || selectedModel || "Modelo"

  React.useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 max-w-[min(168px,38vw)] shrink-0 items-center gap-1 rounded-md border px-2.5 text-[11px] font-medium transition-colors",
            "border-border/45 bg-background/60 text-foreground/75 hover:border-border hover:bg-muted/40 hover:text-foreground",
            "data-[state=open]:border-border data-[state=open]:bg-muted/60 data-[state=open]:text-foreground",
          )}
          aria-label="Seleccionar modelo"
          title={
            fast
              ? `${label} — recomendado para preview en vivo`
              : `${label} — modelo de razonamiento; puede ser más lento en preview`
          }
        >
          {!fast ? (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500/80" aria-hidden />
          ) : null}
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-45" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={8}
        collisionPadding={16}
        className="z-[1000] w-[min(300px,calc(100vw-24px))] overflow-hidden rounded-lg border border-border/60 bg-popover p-0 text-popover-foreground shadow-[0_16px_48px_rgba(15,23,42,0.14)]"
      >
        <div className="border-b border-border/50 px-2.5 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar modelo…"
              className="h-8 border-0 bg-muted/40 pl-8 text-xs shadow-none focus-visible:ring-1"
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        </div>
        <div className="max-h-[min(320px,calc(100vh-180px))] overflow-y-auto p-1">
          {models.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              Cargando modelos…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              Sin coincidencias
            </div>
          ) : (
            filtered.map(([provider, list], i) => (
              <React.Fragment key={provider}>
                {i > 0 ? <DropdownMenuSeparator className="my-1" /> : null}
                <DropdownMenuLabel className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
                  {provider}
                </DropdownMenuLabel>
                {list.map((m) => {
                  const selected = m.name === selectedModel
                  const itemLabel = m.displayName || m.name
                  const itemFast = !isSlowModel(m.name)
                  return (
                    <DropdownMenuItem
                      key={m.name}
                      onClick={() => {
                        onSelect(m)
                        setOpen(false)
                      }}
                      className={cn(
                        "cursor-pointer rounded-lg px-2 py-1.5 text-[13px] font-normal",
                        selected && "bg-muted/70 text-foreground",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{itemLabel}</span>
                      {itemFast ? (
                        <span className="ml-2 shrink-0 text-[10px] text-muted-foreground/70">Rápido</span>
                      ) : null}
                      {selected ? <Check className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                    </DropdownMenuItem>
                  )
                })}
              </React.Fragment>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function CodeBlockCard({
  block,
  existingContent,
}: {
  block: CodeBlock
  existingContent: string
}) {
  // Claude Code parity: the chat NEVER dumps code. Each block renders as a
  // compact, COLLAPSED file chip (path · line count · actions); the code (or
  // the diff, for files that exist in the workspace) only shows on demand.
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const lineCount = React.useMemo(() => block.content.split("\n").length, [block.content])
  const showDiff = !!block.path && existingContent.length > 0
  const diffLines = React.useMemo(
    () => (open && showDiff ? computeLineDiff(existingContent, block.content) : []),
    [block.content, existingContent, open, showDiff],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      toast.error("No se pudo copiar al portapapeles")
    }
  }

  return (
    <div className="mt-2 rounded-md border border-border/50 bg-muted/15">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted/30"
        aria-expanded={open}
      >
        <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
        <span className="min-w-0 truncate font-mono text-foreground/85">
          {block.path || `fragmento ${block.language || "de código"}`}
        </span>
        <span className="shrink-0 opacity-60">· {lineCount} líneas</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={(e) => {
              e.stopPropagation()
              void copy()
            }}
          >
            {copied ? "Copiado" : "Copiar"}
          </Button>
          <span className="text-[11px] opacity-70">{open ? "Ocultar" : showDiff ? "Ver diff" : "Ver código"}</span>
          <ChevronDown
            className={cn("h-3.5 w-3.5 opacity-60 transition-transform", open && "rotate-180")}
            aria-hidden="true"
          />
        </span>
      </button>
      {open ? (
        showDiff ? (
          <div className="border-t border-border/50 p-2">
            <DiffView lines={diffLines} />
          </div>
        ) : (
          <pre className="max-h-72 overflow-auto border-t border-border/50 p-3 font-mono text-[12px] leading-relaxed">
            {block.content}
          </pre>
        )
      ) : null}
    </div>
  )
}
