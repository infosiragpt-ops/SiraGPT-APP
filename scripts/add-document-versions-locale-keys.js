#!/usr/bin/env node
/**
 * scripts/add-document-versions-locale-keys.js
 *
 * Adds the `documents.versions` i18n sub-namespace (version history UI of the
 * /chat document editor) to every messages/<locale>.json. Spanish is the
 * SOURCE; English mirrors it as the fallback base; the major locales get hand
 * translations and every other locale gets the English strings (next-intl
 * deep-merges to en, so shipping en text instead of holes keeps the drift
 * checker green).
 *
 * Idempotent: re-running overwrites ONLY `documents.versions`, preserving all
 * other keys (and manual edits elsewhere) in each file.
 *
 * Usage:
 *   node scripts/add-document-versions-locale-keys.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const MESSAGES_DIR = path.resolve(__dirname, "..", "messages");

// Source of truth = Spanish. English mirrors it as the fallback base.
const ES = {
  "tabHistory": "Historial",
  "tabCompare": "Comparar",
  "loading": "Cargando historial…",
  "calculatingDiff": "Calculando diferencias…",
  "emptyTitle": "Aún no hay versiones guardadas",
  "emptyBody": "Cada vez que guardes una edición aparecerá aquí con su fecha y su tipo.",
  "loadMore": "Cargar más",
  "retry": "Reintentar",
  "current": "Actual",
  "unvalidated": "Sin validar",
  "kindManual": "Edición manual",
  "kindSurgical": "Edición quirúrgica",
  "kindRestore": "Restauración",
  "fromChat": "desde un chat",
  "restore": "Restaurar esta versión",
  "restoring": "Restaurando…",
  "confirmRestore": "Confirmar restauración",
  "confirmQuestion": "¿Crear una nueva versión con el contenido de la v{version}?",
  "cancel": "Cancelar",
  "closeDiff": "Cerrar comparación",
  "totalVersions": "{count, plural, one {# versión en total} other {# versiones en total}}",
  "diffHeader": "Comparando v{version} con la versión actual ({additions} añadidas, {deletions} eliminadas)",
  "readOnly": "Solo lectura",
  "selectToCompare": "Selecciona una versión del historial para compararla con la actual.",
  "noComparableText": "Esta versión no guarda texto comparable",
  "loadError": "No se pudo cargar el historial de versiones",
  "readContentError": "No se pudo leer el contenido de esta versión",
  "restoreError": "No se pudo restaurar la versión",
};

const EN = {
  "tabHistory": "History",
  "tabCompare": "Compare",
  "loading": "Loading history…",
  "calculatingDiff": "Calculating differences…",
  "emptyTitle": "No saved versions yet",
  "emptyBody": "Every saved edit will appear here with its date and type.",
  "loadMore": "Load more",
  "retry": "Retry",
  "current": "Current",
  "unvalidated": "Unvalidated",
  "kindManual": "Manual edit",
  "kindSurgical": "Surgical edit",
  "kindRestore": "Restore",
  "fromChat": "from a chat",
  "restore": "Restore this version",
  "restoring": "Restoring…",
  "confirmRestore": "Confirm restore",
  "confirmQuestion": "Create a new version with the content of v{version}?",
  "cancel": "Cancel",
  "closeDiff": "Close comparison",
  "totalVersions": "{count, plural, one {# version in total} other {# versions in total}}",
  "diffHeader": "Comparing v{version} with the current version ({additions} added, {deletions} removed)",
  "readOnly": "Read-only",
  "selectToCompare": "Select a version from the history to compare it with the current one.",
  "noComparableText": "This version has no comparable text",
  "loadError": "Could not load the version history",
  "readContentError": "Could not read this version's content",
  "restoreError": "Could not restore the version",
};

// Hand translations for the major locales (the rest fall back to EN).
const TRANSLATIONS = {
  es: ES,
  en: EN,
  pt: {
    ...EN,
    tabHistory: "Histórico",
    tabCompare: "Comparar",
    loading: "Carregando histórico…",
    calculatingDiff: "Calculando diferenças…",
    emptyTitle: "Ainda não há versões salvas",
    emptyBody: "Cada edição salva aparecerá aqui com sua data e tipo.",
    loadMore: "Carregar mais",
    retry: "Tentar novamente",
    current: "Atual",
    kindManual: "Edição manual",
    kindSurgical: "Edição cirúrgica",
    kindRestore: "Restauração",
    fromChat: "de um chat",
    restore: "Restaurar esta versão",
    restoring: "Restaurando…",
    confirmRestore: "Confirmar restauração",
    confirmQuestion: "Criar uma nova versão com o conteúdo da v{version}?",
    cancel: "Cancelar",
    closeDiff: "Fechar comparação",
    readOnly: "Somente leitura",
    selectToCompare: "Selecione uma versão do histórico para compará-la com a atual.",
    loadError: "Não foi possível carregar o histórico de versões",
    readContentError: "Não foi possível ler o conteúdo desta versão",
    restoreError: "Não foi possível restaurar a versão",
  },
  fr: {
    ...EN,
    tabHistory: "Historique",
    tabCompare: "Comparer",
    loading: "Chargement de l'historique…",
    calculatingDiff: "Calcul des différences…",
    emptyTitle: "Aucune version enregistrée pour le moment",
    emptyBody: "Chaque édition enregistrée apparaîtra ici avec sa date et son type.",
    loadMore: "Charger plus",
    retry: "Réessayer",
    current: "Actuelle",
    kindManual: "Édition manuelle",
    kindSurgical: "Édition chirurgicale",
    kindRestore: "Restauration",
    fromChat: "depuis une conversation",
    restore: "Restaurer cette version",
    restoring: "Restauration…",
    confirmRestore: "Confirmer la restauration",
    confirmQuestion: "Créer une nouvelle version avec le contenu de la v{version} ?",
    cancel: "Annuler",
    closeDiff: "Fermer la comparaison",
    readOnly: "Lecture seule",
    selectToCompare: "Sélectionnez une version de l'historique pour la comparer à l'actuelle.",
    loadError: "Impossible de charger l'historique des versions",
    readContentError: "Impossible de lire le contenu de cette version",
    restoreError: "Impossible de restaurer la version",
  },
  de: {
    ...EN,
    tabHistory: "Verlauf",
    tabCompare: "Vergleichen",
    loading: "Verlauf wird geladen…",
    calculatingDiff: "Unterschiede werden berechnet…",
    emptyTitle: "Noch keine gespeicherten Versionen",
    emptyBody: "Jede gespeicherte Bearbeitung erscheint hier mit Datum und Typ.",
    loadMore: "Mehr laden",
    retry: "Erneut versuchen",
    current: "Aktuell",
    kindManual: "Manuelle Bearbeitung",
    kindSurgical: "Gezielte Bearbeitung",
    kindRestore: "Wiederherstellung",
    fromChat: "aus einem Chat",
    restore: "Diese Version wiederherstellen",
    restoring: "Wird wiederhergestellt…",
    confirmRestore: "Wiederherstellung bestätigen",
    confirmQuestion: "Eine neue Version mit dem Inhalt von v{version} erstellen?",
    cancel: "Abbrechen",
    closeDiff: "Vergleich schließen",
    readOnly: "Nur Lesen",
    selectToCompare: "Wähle eine Version aus dem Verlauf, um sie mit der aktuellen zu vergleichen.",
    loadError: "Versionsverlauf konnte nicht geladen werden",
    readContentError: "Inhalt dieser Version konnte nicht gelesen werden",
    restoreError: "Version konnte nicht wiederhergestellt werden",
  },
  it: {
    ...EN,
    tabHistory: "Cronologia",
    tabCompare: "Confronta",
    loading: "Caricamento cronologia…",
    calculatingDiff: "Calcolo delle differenze…",
    emptyTitle: "Nessuna versione salvata",
    emptyBody: "Ogni modifica salvata apparirà qui con data e tipo.",
    loadMore: "Carica altre",
    retry: "Riprova",
    current: "Attuale",
    kindManual: "Modifica manuale",
    kindSurgical: "Modifica chirurgica",
    kindRestore: "Ripristino",
    fromChat: "da una chat",
    restore: "Ripristina questa versione",
    restoring: "Ripristino in corso…",
    confirmRestore: "Conferma ripristino",
    confirmQuestion: "Creare una nuova versione con il contenuto della v{version}?",
    cancel: "Annulla",
    closeDiff: "Chiudi confronto",
    readOnly: "Sola lettura",
    selectToCompare: "Seleziona una versione dalla cronologia per confrontarla con quella attuale.",
    loadError: "Impossibile caricare la cronologia delle versioni",
    readContentError: "Impossibile leggere il contenuto di questa versione",
    restoreError: "Impossibile ripristinare la versione",
  },
  ja: {
    ...EN,
    tabHistory: "履歴",
    tabCompare: "比較",
    loading: "履歴を読み込み中…",
    calculatingDiff: "差分を計算中…",
    emptyTitle: "保存されたバージョンはまだありません",
    emptyBody: "保存した編集は、日付と種類とともにここに表示されます。",
    loadMore: "さらに読み込む",
    retry: "再試行",
    current: "現在",
    kindManual: "手動編集",
    kindSurgical: "部分編集",
    kindRestore: "復元",
    fromChat: "チャットから",
    restore: "このバージョンを復元",
    restoring: "復元中…",
    confirmRestore: "復元を確認",
    confirmQuestion: "v{version} の内容で新しいバージョンを作成しますか？",
    cancel: "キャンセル",
    closeDiff: "比較を閉じる",
    readOnly: "読み取り専用",
    selectToCompare: "履歴からバージョンを選択すると、現在のバージョンと比較できます。",
    loadError: "バージョン履歴を読み込めませんでした",
    readContentError: "このバージョンの内容を読み取れませんでした",
    restoreError: "バージョンを復元できませんでした",
  },
  zh: {
    ...EN,
    tabHistory: "历史版本",
    tabCompare: "对比",
    loading: "正在加载历史记录…",
    calculatingDiff: "正在计算差异…",
    emptyTitle: "尚无已保存的版本",
    emptyBody: "每次保存的修改都会显示在这里，并带有日期和类型。",
    loadMore: "加载更多",
    retry: "重试",
    current: "当前",
    kindManual: "手动编辑",
    kindSurgical: "精准编辑",
    kindRestore: "恢复",
    fromChat: "来自某个对话",
    restore: "恢复此版本",
    restoring: "正在恢复…",
    confirmRestore: "确认恢复",
    confirmQuestion: "是否用 v{version} 的内容创建新版本？",
    cancel: "取消",
    closeDiff: "关闭对比",
    readOnly: "只读",
    selectToCompare: "从历史记录中选择一个版本与当前版本进行对比。",
    loadError: "无法加载版本历史",
    readContentError: "无法读取该版本的内容",
    restoreError: "无法恢复该版本",
  },
};

function main() {
  const files = fs.readdirSync(MESSAGES_DIR).filter((f) => f.endsWith(".json")).sort();
  let updated = 0;
  for (const file of files) {
    const locale = file.replace(/.json$/, "");
    const filePath = path.join(MESSAGES_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!data.documents || typeof data.documents !== "object") {
      throw new Error(`${file}: missing canonical documents namespace`);
    }
    data.documents.versions = TRANSLATIONS[locale] || EN;
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}
`, "utf8");
    updated += 1;
  }
  console.log(`[add-document-versions-locale-keys] documents.versions written to ${updated} locale files`);
}

if (require.main === module) main();

module.exports = { ES, EN, TRANSLATIONS };
