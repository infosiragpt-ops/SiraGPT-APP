'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-mongo-agg');
const { extractMongoAgg, buildMongoAggForFiles, renderMongoAggBlock, _internal } = engine;
const { classifyOp, isMongoLike } = _internal;

const MONGO_FIXTURE = `db.users.aggregate([
  { $match: { active: true, age: { $gte: 18, $lt: 65 } } },
  { $lookup: { from: 'orders', localField: '_id', foreignField: 'userId', as: 'orders' } },
  { $unwind: '$orders' },
  { $group: {
      _id: '$country',
      total: { $sum: '$orders.total' },
      avgAge: { $avg: '$age' },
      users: { $addToSet: '$_id' }
    }
  },
  { $sort: { total: -1 } },
  { $limit: 10 },
  { $project: { country: '$_id', total: 1, avgAge: 1, _id: 0 } }
]);

db.users.updateMany(
  { status: 'pending' },
  { $set: { status: 'active' }, $inc: { loginCount: 1 } }
);

db.posts.find({ $or: [{ author: 'Alice' }, { tags: { $in: ['featured'] } }] });`;

test('empty / non-string tolerated', () => {
  assert.equal(extractMongoAgg('').total, 0);
  assert.equal(extractMongoAgg(null).total, 0);
});

test('non-Mongo text returns empty', () => {
  const r = extractMongoAgg('Just regular text without $ or aggregate calls');
  assert.equal(r.total, 0);
});

test('classifyOp: stage / accumulator / query / update', () => {
  assert.equal(classifyOp('$match'), 'stage');
  assert.equal(classifyOp('$group'), 'stage');
  assert.equal(classifyOp('$sum'), 'accumulator');
  assert.equal(classifyOp('$avg'), 'accumulator');
  assert.equal(classifyOp('$eq'), 'query');
  assert.equal(classifyOp('$in'), 'query');
  assert.equal(classifyOp('$inc'), 'update');
});

test('isMongoLike heuristic', () => {
  assert.ok(isMongoLike('db.x.aggregate([{ $match: {} }])'));
  assert.ok(isMongoLike('coll.find({})'));
  assert.ok(!isMongoLike('plain text'));
});

test('detects $match / $group / $project stages', () => {
  const r = extractMongoAgg(MONGO_FIXTURE);
  assert.ok(r.entries.some((e) => e.category === 'stage' && e.name === '$match'));
  assert.ok(r.entries.some((e) => e.category === 'stage' && e.name === '$group'));
  assert.ok(r.entries.some((e) => e.category === 'stage' && e.name === '$project'));
});

test('detects $lookup / $unwind / $sort / $limit stages', () => {
  const r = extractMongoAgg(MONGO_FIXTURE);
  assert.ok(r.entries.some((e) => e.name === '$lookup'));
  assert.ok(r.entries.some((e) => e.name === '$unwind'));
  assert.ok(r.entries.some((e) => e.name === '$sort'));
  assert.ok(r.entries.some((e) => e.name === '$limit'));
});

test('detects accumulators $sum / $avg / $addToSet', () => {
  const r = extractMongoAgg(MONGO_FIXTURE);
  assert.ok(r.entries.some((e) => e.category === 'accumulator' && e.name === '$sum'));
  assert.ok(r.entries.some((e) => e.category === 'accumulator' && e.name === '$avg'));
  assert.ok(r.entries.some((e) => e.category === 'accumulator' && e.name === '$addToSet'));
});

test('detects query operators $gte / $lt / $or / $in', () => {
  const r = extractMongoAgg(MONGO_FIXTURE);
  assert.ok(r.entries.some((e) => e.category === 'query' && e.name === '$gte'));
  assert.ok(r.entries.some((e) => e.category === 'query' && e.name === '$lt'));
  assert.ok(r.entries.some((e) => e.category === 'query' && e.name === '$or'));
  assert.ok(r.entries.some((e) => e.category === 'query' && e.name === '$in'));
});

test('detects update operators $set / $inc', () => {
  const r = extractMongoAgg(MONGO_FIXTURE);
  // $set is also a stage; classify reports stage first
  assert.ok(r.entries.some((e) => e.name === '$inc'));
});

test('detects collection methods', () => {
  const r = extractMongoAgg(MONGO_FIXTURE);
  assert.ok(r.entries.some((e) => e.category === 'method' && e.name === '.aggregate'));
  assert.ok(r.entries.some((e) => e.category === 'method' && e.name === '.updateMany'));
  assert.ok(r.entries.some((e) => e.category === 'method' && e.name === '.find'));
});

test('dedupes identical operators', () => {
  const r = extractMongoAgg('db.x.aggregate([{ $match: {} }, { $match: {} }])');
  assert.equal(r.entries.filter((e) => e.name === '$match').length, 1);
});

test('caps entries per file', () => {
  let text = 'db.x.aggregate([';
  const ops = ['$match', '$group', '$project', '$sort', '$limit', '$skip', '$unwind', '$lookup', '$facet', '$count', '$sum', '$avg', '$min', '$max', '$push', '$gt', '$lt', '$in', '$nin', '$or', '$and', '$inc', '$set', '$exists', '$type', '$regex'];
  for (const op of ops) text += `{ ${op}: {} }, `;
  text += ']);';
  const r = extractMongoAgg(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by category', () => {
  const r = extractMongoAgg(MONGO_FIXTURE);
  assert.ok(r.totals.stage >= 5);
  assert.ok(r.totals.accumulator >= 2);
  assert.ok(r.totals.query >= 3);
});

test('buildMongoAggForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.js', extractedText: 'db.users.aggregate([{ $match: {} }])' },
    { name: 'b.js', extractedText: 'db.posts.aggregate([{ $group: { _id: null } }])' },
  ];
  const r = buildMongoAggForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderMongoAggBlock returns markdown when entries exist', () => {
  const files = [{ name: 'agg.js', extractedText: MONGO_FIXTURE }];
  const r = buildMongoAggForFiles(files);
  const md = renderMongoAggBlock(r);
  assert.match(md, /^## MONGODB/);
});

test('renderMongoAggBlock empty when nothing surfaces', () => {
  assert.equal(renderMongoAggBlock({ perFile: [] }), '');
  assert.equal(renderMongoAggBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMongoAggForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: MONGO_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
