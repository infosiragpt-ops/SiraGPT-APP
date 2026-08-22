#!/usr/bin/env node
/**
 * scripts/add-code-doc-locale-keys.js
 *
 * Adds the `documents.docBridge` i18n block (Frente 6: /chat ↔ /code document
 * bridge) to every messages/<locale>.json. Spanish is the SOURCE of truth;
 * English mirrors it as the base fallback; the major locales get hand
 * translations and the remaining locales receive English strings — next-intl
 * deep-merges to en, so shipping en text instead of holes keeps both the UI
 * and scripts/check-locales.js green.
 *
 * Idempotent: re-running overwrites ONLY documents.docBridge, preserving all
 * other keys in each file.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const MESSAGES_DIR = path.resolve(__dirname, "..", "messages");

// Source of truth = Spanish.
const ES = {
  sendToCode: "Enviar a /code",
  sendToCodeTitle: "Envía el Markdown actual como docs/<nombre>.md al proyecto del Agente en /code",
  sentToCode: "Documento enviado al proyecto del Agente ({name})",
  sendToCodeNoProject: "Abre o crea un proyecto en /code y vuelve a intentarlo",
  sendToCodeFailed: "No se pudo enviar a /code",
  openInEditor: "Abrir en el editor de documentos (/chat)",
  openInEditorAria: "Abrir {path} en el editor de documentos",
  openedAsDocument: "{name} abierta como documento editable en /chat",
  openInEditorEmpty: "El archivo está vacío o no tiene texto exportable",
  openInEditorNoProject: "Abre una tarea del Agente para sincronizar este archivo primero",
  openInEditorFailed: "No se pudo abrir en el editor de documentos",
};

// Base fallback for every other locale.
const EN = {
  sendToCode: "Send to /code",
  sendToCodeTitle: "Send the current Markdown as docs/<name>.md to the Agent project in /code",
  sentToCode: "Document sent to the Agent project ({name})",
  sendToCodeNoProject: "Open or create a project in /code and try again",
  sendToCodeFailed: "Could not send to /code",
  openInEditor: "Open in the document editor (/chat)",
  openInEditorAria: "Open {path} in the document editor",
  openedAsDocument: "{name} opened as an editable document in /chat",
  openInEditorEmpty: "The file is empty or has no exportable text",
  openInEditorNoProject: "Open an Agent task first so this file can be synced",
  openInEditorFailed: "Could not open in the document editor",
};

// Hand translations for the major locales; the rest fall back to EN.
const TRANSLATIONS = {
  es: ES,
  en: EN,
  pt: {
    ...EN,
    sendToCode: "Enviar para /code",
    sendToCodeTitle: "Envia o Markdown atual como docs/<nome>.md ao projeto do Agente em /code",
    sentToCode: "Documento enviado ao projeto do Agente ({name})",
    sendToCodeNoProject: "Abra ou crie um projeto em /code e tente novamente",
    sendToCodeFailed: "Não foi possível enviar para /code",
    openInEditor: "Abrir no editor de documentos (/chat)",
    openInEditorAria: "Abrir {path} no editor de documentos",
    openedAsDocument: "{name} aberto como documento editável em /chat",
    openInEditorEmpty: "O arquivo está vazio ou não tem texto exportável",
    openInEditorNoProject: "Abra uma tarefa do Agente antes para sincronizar este arquivo",
    openInEditorFailed: "Não foi possível abrir no editor de documentos",
  },
  fr: {
    ...EN,
    sendToCode: "Envoyer vers /code",
    sendToCodeTitle: "Envoie le Markdown actuel comme docs/<nom>.md au projet Agent dans /code",
    sentToCode: "Document envoyé au projet Agent ({name})",
    sendToCodeNoProject: "Ouvrez ou créez un projet dans /code puis réessayez",
    sendToCodeFailed: "Impossible d'envoyer vers /code",
    openInEditor: "Ouvrir dans l'éditeur de documents (/chat)",
    openInEditorAria: "Ouvrir {path} dans l'éditeur de documents",
    openedAsDocument: "{name} ouvert comme document modifiable dans /chat",
    openInEditorEmpty: "Le fichier est vide ou sans texte exportable",
    openInEditorNoProject: "Ouvrez d'abord une tâche Agent pour synchroniser ce fichier",
    openInEditorFailed: "Impossible d'ouvrir dans l'éditeur de documents",
  },
  de: {
    ...EN,
    sendToCode: "An /code senden",
    sendToCodeTitle: "Sendet das aktuelle Markdown als docs/<name>.md an das Agent-Projekt in /code",
    sentToCode: "Dokument an das Agent-Projekt gesendet ({name})",
    sendToCodeNoProject: "Öffne oder erstelle ein Projekt in /code und versuche es erneut",
    sendToCodeFailed: "Senden an /code fehlgeschlagen",
    openInEditor: "Im Dokumenteneditor öffnen (/chat)",
    openInEditorAria: "{path} im Dokumenteneditor öffnen",
    openedAsDocument: "{name} als bearbeitbares Dokument in /chat geöffnet",
    openInEditorEmpty: "Die Datei ist leer oder hat keinen exportierbaren Text",
    openInEditorNoProject: "Öffne zuerst eine Agent-Aufgabe, um diese Datei zu synchronisieren",
    openInEditorFailed: "Öffnen im Dokumenteneditor fehlgeschlagen",
  },
  it: {
    ...EN,
    sendToCode: "Invia a /code",
    sendToCodeTitle: "Invia il Markdown attuale come docs/<nome>.md al progetto Agente in /code",
    sentToCode: "Documento inviato al progetto Agente ({name})",
    sendToCodeNoProject: "Apri o crea un progetto in /code e riprova",
    sendToCodeFailed: "Impossibile inviare a /code",
    openInEditor: "Apri nell'editor di documenti (/chat)",
    openInEditorAria: "Apri {path} nell'editor di documenti",
    openedAsDocument: "{name} aperto come documento modificabile in /chat",
    openInEditorEmpty: "Il file è vuoto o non ha testo esportabile",
    openInEditorNoProject: "Apri prima un task dell'Agente per sincronizzare questo file",
    openInEditorFailed: "Impossibile aprire nell'editor di documenti",
  },
};

function main() {
  const files = fs.readdirSync(MESSAGES_DIR).filter((f) => f.endsWith(".json")).sort();
  let updated = 0;
  for (const file of files) {
    const locale = file.replace(/.json$/, "");
    const filePath = path.join(MESSAGES_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    data.documents = data.documents && typeof data.documents === "object"
      ? data.documents
      : {};
    data.documents.docBridge = TRANSLATIONS[locale] || EN;
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    updated += 1;
  }
  console.log(`[add-code-doc-locale-keys] documents.docBridge written to ${updated} locale files`);
}

if (require.main === module) main();

module.exports = { ES, EN, TRANSLATIONS };
