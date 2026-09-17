#!/usr/bin/env node
/**
 * scripts/add-chat-search-locale-keys.js
 *
 * Adds the `chatSearch` i18n namespace (full-text ⌘K chat search) to every
 * messages/<locale>.json, keeping full key parity with en.json
 * (scripts/check-locales.js enforces it).
 *
 * Hand-written translations for the major locales; every other locale gets
 * the English strings — next-intl's deep merge already falls back to en for
 * missing keys, so shipping en text (instead of holes) only changes WHERE
 * the fallback lives while keeping the drift checker green.
 *
 * Idempotent: re-running overwrites the `chatSearch` namespace only.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MESSAGES_DIR = path.resolve(__dirname, '..', 'messages');

const EN = {
  placeholder: 'Search your chats…',
  noResults: 'No results',
  noResultsFor: 'We couldn\'t find chats matching “{query}”',
  serverFallback: 'Couldn\'t reach server search; showing local title matches.',
  emptyHistory: 'You have no chats yet',
  emptyHistoryHint: 'Start a conversation and it will show up here',
  resultCountOne: '{count} chat',
  resultCountMany: '{count} chats',
};

// Hand-written for the locales we can translate well; the rest fall back
// to EN via the spread in main().
const TRANSLATIONS = {
  es: {
    placeholder: 'Buscar en tus chats…',
    noResults: 'Sin resultados',
    noResultsFor: 'No encontramos chats para «{query}»',
    serverFallback: 'No se pudo buscar en el servidor; mostramos coincidencias de títulos locales.',
    emptyHistory: 'Aún no tienes chats',
    emptyHistoryHint: 'Empieza una conversación para verla aquí',
    resultCountOne: '{count} chat',
    resultCountMany: '{count} chats',
  },
  pt: {
    placeholder: 'Pesquisar nos seus chats…',
    noResults: 'Sem resultados',
    noResultsFor: 'Não encontramos chats para «{query}»',
    serverFallback: 'Não foi possível pesquisar no servidor; mostrando correspondências de títulos locais.',
    emptyHistory: 'Você ainda não tem chats',
    emptyHistoryHint: 'Inicie uma conversa para vê-la aqui',
    resultCountOne: '{count} chat',
    resultCountMany: '{count} chats',
  },
  fr: {
    placeholder: 'Rechercher dans vos chats…',
    noResults: 'Aucun résultat',
    noResultsFor: 'Aucun chat trouvé pour « {query} »',
    serverFallback: 'La recherche serveur a échoué ; affichage des correspondances de titres locales.',
    emptyHistory: 'Vous n\'avez pas encore de chats',
    emptyHistoryHint: 'Commencez une conversation pour la voir ici',
    resultCountOne: '{count} chat',
    resultCountMany: '{count} chats',
  },
  de: {
    placeholder: 'Chats durchsuchen…',
    noResults: 'Keine Ergebnisse',
    noResultsFor: 'Keine Chats für „{query}" gefunden',
    serverFallback: 'Serversuche nicht erreichbar; lokale Titeltreffer werden angezeigt.',
    emptyHistory: 'Noch keine Chats',
    emptyHistoryHint: 'Starten Sie eine Unterhaltung, um sie hier zu sehen',
    resultCountOne: '{count} Chat',
    resultCountMany: '{count} Chats',
  },
  it: {
    placeholder: 'Cerca nelle tue chat…',
    noResults: 'Nessun risultato',
    noResultsFor: 'Nessuna chat trovata per «{query}»',
    serverFallback: 'Ricerca sul server non riuscita; mostriamo le corrispondenze dei titoli locali.',
    emptyHistory: 'Non hai ancora chat',
    emptyHistoryHint: 'Inizia una conversazione per vederla qui',
    resultCountOne: '{count} chat',
    resultCountMany: '{count} chat',
  },
  ja: {
    placeholder: 'チャットを検索…',
    noResults: '結果なし',
    noResultsFor: '「{query}」に一致するチャットは見つかりませんでした',
    serverFallback: 'サーバー検索に失敗しました。ローカルのタイトル一致を表示しています。',
    emptyHistory: 'まだチャットがありません',
    emptyHistoryHint: '会話を始めるとここに表示されます',
    resultCountOne: '{count} 件のチャット',
    resultCountMany: '{count} 件のチャット',
  },
  zh: {
    placeholder: '搜索你的聊天…',
    noResults: '无结果',
    noResultsFor: '未找到与「{query}」匹配的聊天',
    serverFallback: '服务器搜索不可用；显示本地标题匹配。',
    emptyHistory: '还没有聊天',
    emptyHistoryHint: '开始对话后会显示在这里',
    resultCountOne: '{count} 个聊天',
    resultCountMany: '{count} 个聊天',
  },
};

function main() {
  const files = fs.readdirSync(MESSAGES_DIR).filter((f) => f.endsWith('.json')).sort();
  let updated = 0;
  for (const file of files) {
    const locale = file.replace(/\.json$/, '');
    const filePath = path.join(MESSAGES_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.chatSearch = { ...EN, ...(TRANSLATIONS[locale] || (locale === 'en' ? EN : {})) };
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    updated += 1;
  }
  console.log(`[add-chat-search-locale-keys] chatSearch namespace written to ${updated} locale files`);
}

if (require.main === module) main();
