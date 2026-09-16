'use strict';

/**
 * Chat RLHF export from durable Message.feedback rows.
 *
 * KTO: unpaired thumbs. DPO: liked vs disliked after the same user turn
 * (regenerate / same request), not cosine-invented pairs.
 * SFT: liked only. No GPU.
 */

const piiScrubber = require('./pii-scrubber');

const DISLIKE_REASONS = Object.freeze([
  'invented',
  'wrong_file',
  'bad_math',
  'wrong_tone',
  'incomplete',
]);

function mergeRlhfMetadata(existing, patch) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...existing }
    : {};
  const prev = base.rlhf && typeof base.rlhf === 'object' ? { ...base.rlhf } : {};
  base.rlhf = { ...prev, ...patch };
  return base;
}

function scrubText(text, { scrubPii, aggressive, piiHits }) {
  const raw = String(text || '');
  if (!scrubPii) return raw;
  const out = piiScrubber.scrub(raw, { aggressive });
  if (Array.isArray(out.hits)) piiHits.push(...out.hits);
  return out.scrubbed;
}

function filterRows(rows, agent) {
  const list = Array.isArray(rows) ? rows : [];
  if (!agent) return list;
  return list.filter((row) => row.agent === agent);
}

function requestKey(row) {
  return `${row.chatId || ''}::${String(row.request || '').trim()}`;
}

function dpoPairsFromRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = requestKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const pairs = [];
  for (const group of groups.values()) {
    const rejected = group.filter((row) => row.helpful === false);
    const chosen = group.filter((row) => row.helpful === true);
    const usedChosen = new Set();
    for (const rej of rejected) {
      const win = chosen.find((row) => !usedChosen.has(row.runId) && row.runId !== rej.runId);
      if (!win) continue;
      usedChosen.add(win.runId);
      pairs.push({ chosen: win, rejected: rej });
    }
  }
  return pairs;
}

function exportSFTFromRows(rows, { agent, scrubPii, aggressive } = {}) {
  const piiHits = [];
  const eligible = filterRows(rows, agent).filter((row) => row.helpful === true);
  const lines = eligible.map((row) => JSON.stringify({
    messages: [
      { role: 'user', content: scrubText(row.request, { scrubPii, aggressive, piiHits }) },
      { role: 'assistant', content: scrubText(row.response, { scrubPii, aggressive, piiHits }) },
    ],
    agent: row.agent || 'chat',
  }));
  return { lines, count: lines.length, piiHits };
}

function exportKTOFromRows(rows, { agent, scrubPii, aggressive } = {}) {
  const piiHits = [];
  const eligible = filterRows(rows, agent).filter((row) => typeof row.helpful === 'boolean');
  const lines = eligible.map((row) => JSON.stringify({
    prompt: scrubText(row.request, { scrubPii, aggressive, piiHits }),
    completion: scrubText(row.response, { scrubPii, aggressive, piiHits }),
    label: row.helpful === true,
    agent: row.agent || 'chat',
    reason: row.reason || null,
  }));
  return { lines, count: lines.length, piiHits };
}

function exportDPOFromRows(rows, { agent, scrubPii, aggressive } = {}) {
  const piiHits = [];
  const pairs = dpoPairsFromRows(filterRows(rows, agent));
  const lines = pairs.map((pair) => JSON.stringify({
    input: {
      messages: [
        { role: 'user', content: scrubText(pair.chosen.request, { scrubPii, aggressive, piiHits }) },
      ],
    },
    preferred_output: [{
      role: 'assistant',
      content: scrubText(pair.chosen.response, { scrubPii, aggressive, piiHits }),
    }],
    non_preferred_output: [{
      role: 'assistant',
      content: scrubText(pair.rejected.response, { scrubPii, aggressive, piiHits }),
    }],
    agent: pair.chosen.agent || pair.rejected.agent || 'chat',
    reason: pair.rejected.reason || null,
  }));
  return { lines, count: lines.length, piiHits, pairs: pairs.length };
}

function exportFromRows({ rows, format = 'kto', agent = null, scrubPii = true, aggressive = false }) {
  const fmt = String(format || 'kto').toLowerCase();
  let out;
  if (fmt === 'sft') out = exportSFTFromRows(rows, { agent, scrubPii, aggressive });
  else if (fmt === 'kto') out = exportKTOFromRows(rows, { agent, scrubPii, aggressive });
  else if (fmt === 'dpo') out = exportDPOFromRows(rows, { agent, scrubPii, aggressive });
  else throw new Error(`unknown format '${fmt}' — use sft, kto or dpo`);
  return {
    format: fmt,
    count: out.count,
    scrubbed: scrubPii,
    piiHits: out.piiHits,
    ndjson: out.lines.join('\n') + (out.lines.length > 0 ? '\n' : ''),
  };
}

function winRate(rows, agent) {
  const list = filterRows(rows, agent).filter((row) => typeof row.helpful === 'boolean');
  const liked = list.filter((row) => row.helpful === true).length;
  const disliked = list.filter((row) => row.helpful === false).length;
  const total = liked + disliked;
  return {
    liked,
    disliked,
    total,
    winRate: total === 0 ? null : liked / total,
    pairs: dpoPairsFromRows(list).length,
  };
}

function preferenceStats(rows) {
  const all = winRate(rows);
  const document = winRate(rows, 'document');
  const chat = winRate(rows, 'chat');
  return { all, document, chat };
}

module.exports = {
  DISLIKE_REASONS,
  mergeRlhfMetadata,
  dpoPairsFromRows,
  exportFromRows,
  winRate,
  preferenceStats,
};
