#!/usr/bin/env node
/**
 * scripts/add-codex-locale-keys.js
 *
 * Adds the `codex` i18n namespace (Codex Agent V2 UI: timeline, cards,
 * composer, tabs, preview, files, errors, panel) to every
 * messages/<locale>.json. Spanish is the SOURCE; English is the base
 * fallback; the major locales get hand translations and every other locale
 * gets the English strings (next-intl deep-merges to en, so shipping en text
 * instead of holes keeps the drift checker green).
 *
 * Idempotent: re-running overwrites ONLY the `codex` namespace, preserving any
 * other keys (and manual edits to other namespaces) in each file.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const MESSAGES_DIR = path.resolve(__dirname, "..", "messages");

// Source of truth = Spanish. English mirrors it as the fallback base.
const ES = {
  "timeline": {
    "actions": "{count, plural, one {# acción} other {# acciones}}",
    "scrollToLatest": "Ir a lo último",
    "running": "En curso",
    "done": "Listo",
    "error": "Error",
    "reasoning": "Razonando",
    "durationSeconds": "({seconds} s)",
    "unknownTool": "herramienta desconocida: {name}"
  },
  "plan": {
    "title": "Plan propuesto",
    "waiting": "esperando aprobación",
    "approved": "aprobado",
    "approve": "Aprobar y construir",
    "adjust": "Ajustar",
    "pages": "Páginas",
    "components": "Componentes",
    "tasks": "Tareas"
  },
  "checkpoint": {
    "rollback": "Rollback here",
    "changes": "Changes",
    "viewPreview": "View preview",
    "confirmTitle": "¿Hacer rollback a este checkpoint?",
    "confirmBody": "Se descartarán todos los cambios posteriores a este commit en el workspace. Esta acción no se puede deshacer.",
    "confirm": "Hacer rollback",
    "cancel": "Cancelar",
    "diffTitle": "Cambios · +{additions} −{deletions} · {files} archivos",
    "truncated": "Diff truncado (muy largo).",
    "rolledBack": "Rollback al checkpoint {sha}",
    "rollbackFailed": "El rollback falló",
    "export": "Copiar a mi disco",
    "exported": "{count} archivos copiados a {path}",
    "exportedHint": "En tu disco:",
    "exportFailed": "No se pudo copiar a disco"
  },
  "summary": {
    "workedFor": "Trabajó {duration}",
    "timeWorked": "Tiempo",
    "workDone": "Trabajo",
    "itemsRead": "Leído",
    "codeChanged": "Código",
    "agentUsage": "Uso del agente",
    "estimated": "estimado",
    "actions": "{count, plural, one {# acción} other {# acciones}}",
    "lines": "{count, plural, one {# línea} other {# líneas}}",
    "usageDetail": "Detalle de uso",
    "model": "Modelo",
    "inputTokens": "Tokens de entrada",
    "outputTokens": "Tokens de salida",
    "inputCost": "Costo de entrada",
    "outputCost": "Costo de salida",
    "totalCost": "Costo total",
    "thisRun": "Esta ejecución",
    "sessionUsage": "Sesión",
    "sessionRuns": "{count, plural, one {# ejecución} other {# ejecuciones}}"
  },
  "actionRequired": {
    "title": "Acción requerida de su parte",
    "copy": "Copiar",
    "copied": "¡Copiado!",
    "blockedCapabilities": "Capacidades bloqueadas:",
    "remediate": "Remediar"
  },
  "composer": {
    "placeholder": "Describe tu idea — la IA propone el plan y ejecuta…",
    "plan": "Plan",
    "planTooltip": "El agente planifica internamente y ejecuta en modo automático.",
    "send": "Enviar",
    "stop": "Detener",
    "dictate": "Dictar",
    "stopDictation": "Detener dictado",
    "attach": "Adjuntar archivo",
    "tierEco": "Eco",
    "tierStandard": "Estándar",
    "tierPower": "Power",
    "tierEcoDesc": "Rápido y gratis (FlashGPT)",
    "tierStandardDesc": "Equilibrio calidad/costo",
    "tierPowerDesc": "Máxima capacidad",
    "free": "gratis"
  },
  "tabs": {
    "preview": "Preview",
    "agent": "Agent",
    "web": "Web",
    "connections": "Conexiones",
    "checklist": "Checklist",
    "files": "Archivos"
  },
  "preview": {
    "start": "▶ Iniciar / Recargar",
    "hint": "Levanta el dev server de este proyecto y carga la vista previa."
  },
  "files": {
    "title": "Código",
    "refresh": "Actualizar",
    "loading": "Cargando…",
    "empty": "Aún no hay archivos en el workspace.",
    "none": "Selecciona un archivo para ver su contenido."
  },
  "errors": {
    "createProject": "No se pudo crear el proyecto",
    "startRun": "No se pudo iniciar la corrida",
    "approvePlan": "No se pudo aprobar el plan",
    "stopRun": "No se pudo detener la corrida",
    "loadDiff": "No se pudo cargar el diff",
    "openPreview": "No se pudo abrir el preview",
    "readFile": "No se pudo leer {name}"
  },
  "panel": {
    "newProject": "Nuevo",
    "selectProject": "Selecciona un proyecto…",
    "loading": "Cargando…",
    "emptyDescribe": "Describe qué quieres construir para proponer un plan.",
    "emptySelect": "Crea o selecciona un proyecto para empezar.",
    "filesHint": "El árbol de archivos del workspace se abre desde el editor de /code.",
    "webUnavailable": "El preview aún no está disponible. Arráncalo desde un checkpoint o el botón Ejecutar.",
    "openInTab": "Abrir en pestaña nueva",
    "checklistEmpty": "Aún no hay un plan aprobado con tareas.",
    "defaultProjectName": "Proyecto {n}",
    "defaultAppName": "Nueva app {n}",
    "appsTitle": "APPS",
    "newApp": "Nueva app",
    "disabledTitle": "APPS aún no está activo",
    "disabledBody": "El motor Codex V2 está apagado en este entorno. Activa CODEX_AGENT_V2 para construir apps con chat, runs y preview real.",
    "forbiddenTitle": "Acceso restringido",
    "forbiddenBody": "Tu cuenta no está autorizada para ejecutar APPS en producción. Pide acceso de admin o agrega tu usuario al allowlist."
  }
};

const EN = {
  "timeline": {
    "actions": "{count, plural, one {# action} other {# actions}}",
    "scrollToLatest": "Scroll to latest",
    "running": "Running",
    "done": "Done",
    "error": "Error",
    "reasoning": "Reasoning",
    "durationSeconds": "({seconds}s)",
    "unknownTool": "unknown tool: {name}"
  },
  "plan": {
    "title": "Proposed plan",
    "waiting": "waiting for approval",
    "approved": "approved",
    "approve": "Approve and build",
    "adjust": "Adjust",
    "pages": "Pages",
    "components": "Components",
    "tasks": "Tasks"
  },
  "checkpoint": {
    "rollback": "Rollback here",
    "changes": "Changes",
    "viewPreview": "View preview",
    "confirmTitle": "Roll back to this checkpoint?",
    "confirmBody": "All changes made after this commit will be discarded from the workspace. This cannot be undone.",
    "confirm": "Roll back",
    "cancel": "Cancel",
    "diffTitle": "Changes · +{additions} −{deletions} · {files} files",
    "truncated": "Diff truncated (too long).",
    "rolledBack": "Rolled back to checkpoint {sha}",
    "rollbackFailed": "Rollback failed",
    "export": "Copy to my disk",
    "exported": "{count} files copied to {path}",
    "exportedHint": "On your disk:",
    "exportFailed": "Could not copy to disk"
  },
  "summary": {
    "workedFor": "Worked for {duration}",
    "timeWorked": "Time worked",
    "workDone": "Work done",
    "itemsRead": "Items read",
    "codeChanged": "Code changed",
    "agentUsage": "Agent Usage",
    "estimated": "estimated",
    "actions": "{count, plural, one {# action} other {# actions}}",
    "lines": "{count, plural, one {# line} other {# lines}}",
    "usageDetail": "Usage detail",
    "model": "Model",
    "inputTokens": "Input tokens",
    "outputTokens": "Output tokens",
    "inputCost": "Input cost",
    "outputCost": "Output cost",
    "totalCost": "Total cost",
    "thisRun": "This run",
    "sessionUsage": "Session",
    "sessionRuns": "{count, plural, one {# run} other {# runs}}"
  },
  "actionRequired": {
    "title": "Action required from you",
    "copy": "Copy",
    "copied": "Copied!",
    "blockedCapabilities": "Blocked capabilities:",
    "remediate": "Fix it"
  },
  "composer": {
    "placeholder": "Describe the idea — AI plans and builds…",
    "plan": "Plan",
    "planTooltip": "The agent plans internally and builds automatically.",
    "send": "Send",
    "stop": "Stop",
    "dictate": "Dictate",
    "stopDictation": "Stop dictation",
    "attach": "Attach file",
    "tierEco": "Eco",
    "tierStandard": "Standard",
    "tierPower": "Power",
    "tierEcoDesc": "Fast and free (FlashGPT)",
    "tierStandardDesc": "Quality/cost balance",
    "tierPowerDesc": "Maximum capability",
    "free": "free"
  },
  "tabs": {
    "preview": "Preview",
    "agent": "Agent",
    "web": "Web",
    "connections": "Connections",
    "checklist": "Checklist",
    "files": "Files"
  },
  "preview": {
    "start": "▶ Start / Reload",
    "hint": "Boots this project's dev server and loads the preview."
  },
  "files": {
    "title": "Code",
    "refresh": "Refresh",
    "loading": "Loading…",
    "empty": "No files in the workspace yet.",
    "none": "Select a file to view its content."
  },
  "errors": {
    "createProject": "Could not create the project",
    "startRun": "Could not start the run",
    "approvePlan": "Could not approve the plan",
    "stopRun": "Could not stop the run",
    "loadDiff": "Could not load the diff",
    "openPreview": "Could not open the preview",
    "readFile": "Could not read {name}"
  },
  "panel": {
    "newProject": "New",
    "selectProject": "Select a project…",
    "loading": "Loading…",
    "emptyDescribe": "Describe what you want to build to propose a plan.",
    "emptySelect": "Create or select a project to start.",
    "filesHint": "The workspace file tree opens from the /code editor.",
    "webUnavailable": "The preview is not available yet. Start it from a checkpoint or the Run button.",
    "openInTab": "Open in new tab",
    "checklistEmpty": "No approved plan with tasks yet.",
    "defaultProjectName": "Project {n}",
    "defaultAppName": "New app {n}",
    "appsTitle": "APPS",
    "newApp": "New app",
    "disabledTitle": "APPS is not active yet",
    "disabledBody": "The Codex V2 engine is off in this environment. Enable CODEX_AGENT_V2 to build apps with chat, runs, and real preview.",
    "forbiddenTitle": "Restricted access",
    "forbiddenBody": "Your account is not authorized to run APPS in production. Ask for admin access or add your user to the allowlist."
  }
};

// Hand translations for the major locales (the rest fall back to EN).
const TRANSLATIONS = {
  es: ES,
  en: EN,
  pt: {
    ...EN,
    composer: { ...EN.composer, placeholder: "Descreva sua ideia — a IA propõe o plano e executa…", send: "Enviar", stop: "Parar" },
    plan: { ...EN.plan, approve: "Aprovar e construir", adjust: "Ajustar" },
  },
  fr: {
    ...EN,
    plan: { ...EN.plan, approve: "Approuver et construire", adjust: "Ajuster" },
    composer: { ...EN.composer, send: "Envoyer", stop: "Arrêter" },
  },
};

function main() {
  const files = fs.readdirSync(MESSAGES_DIR).filter((f) => f.endsWith(".json")).sort();
  let updated = 0;
  for (const file of files) {
    const locale = file.replace(/.json$/, "");
    const filePath = path.join(MESSAGES_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    data.codex = TRANSLATIONS[locale] || EN;
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}
`, "utf8");
    updated += 1;
  }
  console.log(`[add-codex-locale-keys] codex namespace written to ${updated} locale files`);
}

if (require.main === module) main();

module.exports = { ES, EN, TRANSLATIONS };
