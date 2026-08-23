#!/usr/bin/env node
/**
 * scripts/add-routines-locale-keys.js
 *
 * Adds the `code.routines` i18n namespace (Rutinas panel under the
 * department computer in /code — founder visual target 2026-08-22) to every
 * messages/<locale>.json. Spanish is the SOURCE; English is the fallback
 * base; major locales get hand translations and the rest get English so the
 * drift checker stays green.
 *
 * Idempotent: overwrites ONLY `code.routines`, preserving everything else.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const MESSAGES_DIR = path.resolve(__dirname, "..", "messages");

const ES = {
  title: "Rutinas",
  refresh: "Actualizar",
  new: "Nueva",
  empty: "Sin rutinas programadas. Crea una para que el agente trabaje de forma recurrente.",
  next: "próxima",
  pause: "Pausar rutina",
  resume: "Reanudar rutina",
  delete: "Eliminar rutina",
  stale: "No se pudo refrescar ahora; mostrando la última lista conocida.",
  status: {
    idle: "programada",
    running: "en ejecución",
    ok: "completada",
    error: "error",
    disabled: "en pausa",
    skipped: "omitida",
  },
  create: {
    title: "Nueva rutina",
    name: "Nombre",
    namePlaceholder: "Mejora constante chat y code",
    cron: "Programación (cron)",
    prompt: "Instrucción para el agente",
    promptPlaceholder: "Revisa y mejora el chat y el /code…",
    submit: "Crear rutina",
    failed: "No se pudo crear la rutina: {error}",
  },
};

const EN = {
  title: "Routines",
  refresh: "Refresh",
  new: "New",
  empty: "No scheduled routines yet. Create one so the agent works on a recurring basis.",
  next: "next",
  pause: "Pause routine",
  resume: "Resume routine",
  delete: "Delete routine",
  stale: "Could not refresh just now; showing the last known list.",
  status: {
    idle: "scheduled",
    running: "running",
    ok: "completed",
    error: "error",
    disabled: "paused",
    skipped: "skipped",
  },
  create: {
    title: "New routine",
    name: "Name",
    namePlaceholder: "Constant chat & code improvement",
    cron: "Schedule (cron)",
    prompt: "Instruction for the agent",
    promptPlaceholder: "Review and improve chat and /code…",
    submit: "Create routine",
    failed: "Could not create the routine: {error}",
  },
};

// Hand translations for major locales; the rest fall back to EN.
const TRANSLATIONS = {
  es: ES,
  en: EN,
  pt: {
    ...EN,
    title: "Rotinas",
    new: "Nova",
    empty: "Sem rotinas programadas. Crie uma para que o agente trabalhe de forma recorrente.",
    next: "próxima",
    pause: "Pausar rotina",
    resume: "Retomar rotina",
    delete: "Excluir rotina",
    status: { ...EN.status, idle: "programada", running: "em execução", ok: "concluída", disabled: "pausada", skipped: "ignorada" },
    create: { ...EN.create, title: "Nova rotina", name: "Nome", cron: "Agendamento (cron)", prompt: "Instrução para o agente", submit: "Criar rotina" },
  },
  fr: {
    ...EN,
    title: "Routines",
    new: "Nouvelle",
    empty: "Aucune routine programmée. Créez-en une pour que l’agent travaille de façon récurrente.",
    next: "prochaine",
    pause: "Suspendre la routine",
    resume: "Reprendre la routine",
    delete: "Supprimer la routine",
    status: { ...EN.status, idle: "programmée", running: "en cours", ok: "terminée", disabled: "en pause", skipped: "ignorée" },
    create: { ...EN.create, title: "Nouvelle routine", name: "Nom", cron: "Planification (cron)", prompt: "Instruction pour l’agent", submit: "Créer la routine" },
  },
  de: {
    ...EN,
    title: "Routinen",
    new: "Neu",
    empty: "Keine geplanten Routinen. Erstelle eine, damit der Agent wiederkehrend arbeitet.",
    next: "nächste",
    pause: "Routine pausieren",
    resume: "Routine fortsetzen",
    delete: "Routine löschen",
    status: { ...EN.status, idle: "geplant", running: "läuft", ok: "abgeschlossen", disabled: "pausiert", skipped: "übersprungen" },
    create: { ...EN.create, title: "Neue Routine", name: "Name", cron: "Zeitplan (cron)", prompt: "Anweisung für den Agenten", submit: "Routine erstellen" },
  },
  it: {
    ...EN,
    title: "Routine",
    new: "Nuova",
    empty: "Nessuna routine programmata. Creane una perché l’agente lavori in modo ricorrente.",
    next: "prossima",
    pause: "Metti in pausa la routine",
    resume: "Riprendi la routine",
    delete: "Elimina routine",
    status: { ...EN.status, idle: "programmata", running: "in esecuzione", ok: "completata", disabled: "in pausa", skipped: "saltata" },
    create: { ...EN.create, title: "Nuova routine", name: "Nome", cron: "Pianificazione (cron)", prompt: "Istruzione per l’agente", submit: "Crea routine" },
  },
  ja: {
    ...EN,
    title: "ルーティン",
    new: "新規",
    empty: "予約済みのルーティンはありません。作成するとエージェントが定期的に作業します。",
    next: "次回",
    pause: "ルーティンを一時停止",
    resume: "ルーティンを再開",
    delete: "ルーティンを削除",
    status: { ...EN.status, idle: "予定", running: "実行中", ok: "完了", disabled: "一時停止中", skipped: "スキップ" },
    create: { ...EN.create, title: "新しいルーティン", name: "名前", cron: "スケジュール（cron）", prompt: "エージェントへの指示", submit: "作成" },
  },
  zh: {
    ...EN,
    title: "例行任务",
    new: "新建",
    empty: "暂无已计划的例行任务。创建一个，让智能体定期工作。",
    next: "下次",
    pause: "暂停例行任务",
    resume: "恢复例行任务",
    delete: "删除例行任务",
    status: { ...EN.status, idle: "已计划", running: "运行中", ok: "已完成", error: "错误", disabled: "已暂停", skipped: "已跳过" },
    create: { ...EN.create, title: "新建例行任务", name: "名称", cron: "计划（cron）", prompt: "给智能体的指令", submit: "创建" },
  },
};

function main() {
  const files = fs.readdirSync(MESSAGES_DIR).filter((f) => f.endsWith(".json")).sort();
  let updated = 0;
  for (const file of files) {
    const locale = file.replace(/.json$/, "");
    const filePath = path.join(MESSAGES_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!data.code || typeof data.code !== "object") data.code = {};
    data.code.routines = TRANSLATIONS[locale] || EN;
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}
`, "utf8");
    updated += 1;
  }
  console.log(`[add-routines-locale-keys] code.routines written to ${updated} locale files`);
}

if (require.main === module) main();

module.exports = { ES, EN, TRANSLATIONS };
