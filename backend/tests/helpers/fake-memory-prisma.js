'use strict';

/**
 * Minimal in-memory Prisma stand-in for the memory vault / consolidation
 * tests: `userMemory` (findMany/findUnique/findFirst/create/update/upsert/
 * deleteMany/count/groupBy), `systemSettings` (findUnique/upsert),
 * `$transaction` (awaits the ops in order) and `$queryRawUnsafe` (recorded).
 */

let seq = 0;
const nextId = () => `mem_${(seq += 1)}`;

function matchesWhere(row, where = {}) {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!v.some((w) => matchesWhere(row, w))) return false;
      continue;
    }
    if (k === 'NOT') {
      if (matchesWhere(row, v)) return false;
      continue;
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('contains' in v) {
        const hay = String(row[k] || '');
        const needle = String(v.contains);
        if (v.mode === 'insensitive' ? !hay.toLowerCase().includes(needle.toLowerCase()) : !hay.includes(needle)) return false;
        continue;
      }
      if ('in' in v) { if (!v.in.includes(row[k])) return false; continue; }
      if ('startsWith' in v) { if (!String(row[k] || '').startsWith(v.startsWith)) return false; continue; }
      if ('gt' in v) { if (!(row[k] > v.gt)) return false; continue; }
      return false;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

function pick(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
  return out;
}

function createFakePrisma() {
  const memories = [];
  const settings = new Map();
  const raw = [];
  const state = { memories, settings, raw };

  const orderRows = (rows, orderBy) => {
    if (!orderBy) return rows;
    const list = Array.isArray(orderBy) ? orderBy : [orderBy];
    return rows.slice().sort((a, b) => {
      for (const o of list) {
        const [k, dir] = Object.entries(o)[0];
        const av = a[k] instanceof Date ? a[k].getTime() : a[k];
        const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
        if (av === bv) continue;
        const cmp = av > bv ? 1 : -1;
        return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  };

  const userMemory = {
    async findMany({ where = {}, select, orderBy, take } = {}) {
      let rows = memories.filter((r) => matchesWhere(r, where));
      rows = orderRows(rows, orderBy);
      if (take) rows = rows.slice(0, take);
      return rows.map((r) => pick(r, select));
    },
    async findUnique({ where, select }) {
      let row = null;
      if (where.id) row = memories.find((r) => r.id === where.id) || null;
      else if (where.userId_contentHash) row = memories.find((r) => r.userId === where.userId_contentHash.userId && r.contentHash === where.userId_contentHash.contentHash) || null;
      return row ? pick(row, select) : null;
    },
    async findFirst({ where = {}, select } = {}) {
      const row = memories.find((r) => matchesWhere(r, where)) || null;
      return row ? pick(row, select) : null;
    },
    async count({ where = {} } = {}) { return memories.filter((r) => matchesWhere(r, where)).length; },
    async create({ data, select }) {
      if (data.contentHash && memories.some((r) => r.userId === data.userId && r.contentHash === data.contentHash)) {
        const err = new Error('Unique constraint failed on the fields: (`user_id`,`content_hash`)'); err.code = 'P2002'; throw err;
      }
      const now = new Date();
      const row = { id: data.id || nextId(), importanceScore: 0, confidence: 0.8, accessCount: 0, lastAccessedAt: now, createdAt: now, updatedAt: now, category: null, source: null, contentHash: null, ...data };
      memories.push(row);
      return pick(row, select);
    },
    async update({ where, data, select }) {
      const row = memories.find((r) => r.id === where.id);
      if (!row) { const err = new Error('Record to update not found.'); err.code = 'P2025'; throw err; }
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'increment' in v) row[k] = (row[k] || 0) + v.increment;
        else row[k] = v;
      }
      row.updatedAt = new Date();
      return pick(row, select);
    },
    async upsert({ where, create, update, select }) {
      const existing = await userMemory.findUnique({ where });
      if (existing) return userMemory.update({ where: { id: existing.id }, data: update, select });
      return userMemory.create({ data: create, select });
    },
    async deleteMany({ where = {} } = {}) {
      let count = 0;
      for (let i = memories.length - 1; i >= 0; i -= 1) {
        if (matchesWhere(memories[i], where)) { memories.splice(i, 1); count += 1; }
      }
      return { count };
    },
    async groupBy({ by }) {
      const groups = new Map();
      for (const r of memories) {
        const key = r[by[0]];
        const g = groups.get(key) || { [by[0]]: key, _count: { _all: 0 }, _max: { updatedAt: null } };
        g._count._all += 1;
        if (!g._max.updatedAt || r.updatedAt > g._max.updatedAt) g._max.updatedAt = r.updatedAt;
        groups.set(key, g);
      }
      return Array.from(groups.values());
    },
  };

  const systemSettings = {
    async findUnique({ where }) { return settings.has(where.key) ? { id: where.key, key: where.key, value: settings.get(where.key) } : null; },
    async upsert({ where, create, update }) { settings.set(where.key, settings.has(where.key) ? update.value : create.value); return { key: where.key, value: settings.get(where.key) }; },
  };

  return {
    userMemory,
    systemSettings,
    async $transaction(ops) { const out = []; for (const op of ops) out.push(await op); return out; },
    async $queryRawUnsafe(sql, ...params) { raw.push({ sql, params }); return state.rawResult || []; },
    _state: state,
  };
}

module.exports = { createFakePrisma };
