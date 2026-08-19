'use strict';

/**
 * document-mongo-agg.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects MongoDB aggregation pipeline operators and query expressions:
 *
 *   - Pipeline stages:  $match / $group / $project / $sort / $limit / $skip /
 *                       $unwind / $lookup / $facet / $bucket / $addFields /
 *                       $replaceRoot / $merge / $out / $count / $sample / $redact
 *   - Group accumulators: $sum / $avg / $min / $max / $push / $addToSet /
 *                         $first / $last / $stdDevPop / $stdDevSamp
 *   - Query operators:  $eq / $ne / $gt / $gte / $lt / $lte / $in / $nin /
 *                       $exists / $type / $regex / $and / $or / $not / $nor
 *   - Update operators: $set / $unset / $inc / $mul / $rename / $push / $pull /
 *                       $pop / $addToSet / $currentDate
 *   - Methods:          .aggregate() / .find() / .findOne() / .insertOne() /
 *                       .updateOne() / .updateMany() / .deleteOne() / .deleteMany()
 *
 * Public API:
 *   extractMongoAgg(text)             → { entries, totals, total }
 *   buildMongoAggForFiles(files)      → { perFile, aggregate, totals }
 *   renderMongoAggBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const STAGE_OPS = new Set([
  '$match', '$group', '$project', '$sort', '$limit', '$skip',
  '$unwind', '$lookup', '$facet', '$bucket', '$bucketAuto',
  '$addFields', '$set', '$unset', '$replaceRoot', '$replaceWith',
  '$merge', '$out', '$count', '$sample', '$redact',
  '$geoNear', '$graphLookup', '$indexStats', '$collStats',
  '$documents', '$densify', '$fill', '$setWindowFields',
]);
const ACCUMULATOR_OPS = new Set([
  '$sum', '$avg', '$min', '$max', '$push', '$addToSet',
  '$first', '$last', '$stdDevPop', '$stdDevSamp',
  '$mergeObjects', '$accumulator', '$top', '$bottom',
]);
const QUERY_OPS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$exists', '$type', '$regex', '$expr', '$mod', '$text',
  '$and', '$or', '$not', '$nor', '$all', '$elemMatch', '$size',
  '$where', '$jsonSchema', '$comment',
]);
const UPDATE_OPS = new Set([
  '$inc', '$mul', '$rename', '$pop', '$pull', '$pullAll',
  '$currentDate', '$min', '$max', '$bit', '$setOnInsert',
]);

const OP_RE = /\$([a-z][A-Za-z]{1,30})\b/g;
const METHOD_RE = /\.(aggregate|find|findOne|findOneAndUpdate|findOneAndDelete|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|countDocuments|distinct|bulkWrite|createIndex|listIndexes|dropIndex|drop|stats|estimatedDocumentCount|replaceOne)\s*\(/g;

function classifyOp(op) {
  if (STAGE_OPS.has(op)) return 'stage';
  if (ACCUMULATOR_OPS.has(op)) return 'accumulator';
  if (QUERY_OPS.has(op)) return 'query';
  if (UPDATE_OPS.has(op)) return 'update';
  return 'other';
}

function isMongoLike(body) {
  return /\$(?:match|group|project|sort|unwind|lookup|set|unset|inc|push)|\.aggregate\s*\(|\.find\s*\(|new\s+ObjectId|MongoClient|mongoose/.test(body);
}

function extractMongoAgg(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isMongoLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    stage: 0, accumulator: 0, query: 0, update: 0, other: 0, method: 0,
  };

  function push(category, name) {
    const sig = `${category}:${name}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ category, name });
    if (totals[category] != null) totals[category] += 1;
  }

  OP_RE.lastIndex = 0;
  let m;
  while ((m = OP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const op = `$${m[1]}`;
    const cat = classifyOp(op);
    if (cat === 'other') continue;
    push(cat, op);
  }
  if (entries.length < MAX_PER_FILE) {
    METHOD_RE.lastIndex = 0;
    while ((m = METHOD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('method', `.${m[1]}`);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildMongoAggForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    stage: 0, accumulator: 0, query: 0, update: 0, other: 0, method: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractMongoAgg(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.category}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.category] != null) totals[e.category] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderMongoAggBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## MONGODB OPERATORS & PIPELINE'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      lines.push(`- [${e.category}] \`${e.name}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractMongoAgg,
  buildMongoAggForFiles,
  renderMongoAggBlock,
  _internal: { classifyOp, isMongoLike, STAGE_OPS, ACCUMULATOR_OPS, QUERY_OPS, UPDATE_OPS },
};
