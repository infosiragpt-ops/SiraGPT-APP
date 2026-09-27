#!/usr/bin/env node
'use strict';

/**
 * Edición milimétrica — Fase F: run the 10 SPEC eval scenarios through the
 * REAL chat route of this backend and grade the delivered files.
 *
 * Runs INSIDE the backend (container) process environment:
 *
 *   node scripts/run-office-evals.js --user <userId>
 *        [--provider DeepSeek] [--model deepseek/deepseek-v4-pro]
 *        [--route generate|document-edit] [--only 1,6,9] [--keep]
 *        [--fixtures <dir>] [--json <out.json>]
 *
 * Per scenario: create a chat, upload the fixture (/api/files/upload), send
 * the request — /api/ai/generate (the chat turn) or /api/ai/document-edit
 * (what the composer uses when a document is attached) — read the SSE stream
 * (stage v2 timeline + file card), download the delivered file
 * (/api/agent/artifact/…), check the persisted timeline
 * (messages.agent_metadata.activityTrace) and grade the file against the
 * scenario in a fresh sandbox (evals/office-grader.js).
 *
 * A short-lived session is minted for --user and deleted at the end; eval
 * chats are soft-deleted unless --keep. Never prints secrets or tokens.
 */

const fs = require('fs');
const path = require('path');

const { SCENARIOS } = require('../src/services/agent-runner/evals/office-scenarios');
const { gradeOfficeOutput } = require('../src/services/agent-runner/evals/office-grader');
const { assessOfficeEval, sseError } = require('../src/services/agent-runner/evals/office-acceptance');

const MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function parseArgs(argv) {
  const out = { provider: 'DeepSeek', model: 'deepseek/deepseek-v4-pro', keep: false, route: 'generate' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--user') out.user = next();
    else if (a === '--provider') out.provider = next();
    else if (a === '--model') out.model = next();
    else if (a === '--only') out.only = next().split(',').map((n) => Number(n.trim())).filter(Number.isFinite);
    else if (a === '--keep') out.keep = true;
    else if (a === '--fixtures') out.fixtures = next();
    else if (a === '--json') out.json = next();
    else if (a === '--route') out.route = next() === 'document-edit' ? 'document-edit' : 'generate';
  }
  return out;
}

async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try { onEvent(JSON.parse(payload)); } catch (_) { /* keep-alive / partial */ }
      }
    }
  }
}

async function runScenario({ scenario, base, headers, fixturesDir, provider, model, route, createSandbox }) {
  const started = Date.now();
  const J = { ...headers, 'Content-Type': 'application/json' };
  const ext = path.extname(scenario.fixture);
  const before = fs.readFileSync(path.join(fixturesDir, scenario.fixture));
  const chat = await (await fetch(`${base}/api/chats`, {
    method: 'POST', headers: J, body: JSON.stringify({ title: `eval milimétrica ${scenario.n} — ${scenario.id}`, model }),
  })).json();
  const chatId = chat.id || (chat.chat && chat.chat.id);
  const fd = new FormData();
  fd.append('files', new Blob([before], { type: MIME[ext] || 'application/octet-stream' }), scenario.fixture);
  const up = await fetch(`${base}/api/files/upload`, { method: 'POST', headers, body: fd });
  const upJson = await up.json();
  if (!up.ok || !upJson.files || !upJson.files[0]) throw new Error(`upload ${up.status}`);
  const fileId = upJson.files[0].id;

  const streamId = `eval-${scenario.id}-${Date.now()}`;
  const documentEdit = route === 'document-edit';
  const res = await fetch(`${base}/api/ai/${documentEdit ? 'document-edit' : 'generate'}`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify(documentEdit
      ? { provider, model, prompt: scenario.prompt, chatId, fileIds: [fileId], streamId, idempotencyKey: `eval-${streamId}` }
      : { provider, model, prompt: scenario.prompt, chatId, files: [fileId], streamId, idempotencyKey: `eval-${streamId}` }),
  });
  if (!res.ok) throw new Error(`${route} ${res.status}`);
  let content = '';
  const stages = [];
  const artifacts = [];
  const errors = [];
  await readSse(res, (ev) => {
    if (ev.type === 'stage') stages.push(ev);
    if (ev.type === 'file_artifact' && ev.artifact) artifacts.push(ev.artifact);
    const error = sseError(ev);
    if (error) errors.push(error);
    if (ev.type === 'done') {
      // /document-edit: one final frame with the answer and the file cards.
      content = String(ev.content || '');
      for (const f of Array.isArray(ev.files) ? ev.files : []) {
        artifacts.push({ filename: f.filename, downloadUrl: f.downloadUrl || f.url });
      }
      return;
    }
    if (typeof ev.content === 'string' && ev.content) content = ev.replace ? ev.content : content + ev.content;
  });
  const seconds = Math.round((Date.now() - started) / 1000);

  const delivered = artifacts.filter((a) => a && a.downloadUrl && String(a.filename || '').toLowerCase().endsWith(ext));
  let after = null;
  if (delivered.length) {
    const url = delivered[delivered.length - 1].downloadUrl;
    const dl = await fetch(`${base}${url.startsWith('/') ? url : `/${url}`}`, { headers });
    if (dl.ok) after = Buffer.from(await dl.arrayBuffer());
  }

  // Persisted timeline (Fase D): the assistant row carries activityTrace.
  let persistedStages = [];
  try {
    const full = await (await fetch(`${base}/api/chats/${chatId}`, { headers })).json();
    const messages = (full && (full.messages || (full.chat && full.chat.messages))) || [];
    const assistant = [...messages].reverse().find((m) => m.role === 'ASSISTANT');
    const meta = assistant && assistant.agentMetadata;
    const parsed = typeof meta === 'string' ? JSON.parse(meta) : meta;
    persistedStages = parsed && Array.isArray(parsed.activityTrace) ? parsed.activityTrace : [];
  } catch (_) { persistedStages = []; }

  const sandbox = await createSandbox({});
  let graded;
  try {
    graded = await gradeOfficeOutput({ sandbox, scenarioId: scenario.id, before, after, render: true });
  } finally {
    try { await sandbox.destroy(); } catch (_) { /* best effort */ }
  }

  const calls = stages.filter((s) => s.step === 'tool_call');
  const acceptance = assessOfficeEval({ graded, stages, persistedStages, errors });
  return {
    n: scenario.n,
    id: scenario.id,
    prompt: scenario.prompt,
    chatId,
    passed: acceptance.ok,
    checks: acceptance.checks,
    seconds,
    delivered: delivered.map((a) => a.filename),
    tools: calls.map((s) => s.tool),
    verifyAttempts: calls.filter((s) => s.tool === 'verify_visual').length,
    timelineRows: calls.length,
    thumbs: stages.reduce((n, s) => n + (Array.isArray(s.thumbs) ? s.thumbs.length : 0), 0),
    stageV2: stages.some((s) => s.callId && s.kind && s.status),
    persistedTrace: persistedStages.length,
    visionMention: /revisi[oó]n visual|modelo de visi[oó]n/i.test(content),
    answer: content.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '').trim().slice(0, 400),
    errors,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.user) throw new Error('--user <userId> es obligatorio');
  const jwt = require('jsonwebtoken');
  const prisma = require('../src/config/database');
  const { withAccelerateRetry } = require('../src/utils/prisma-accelerate-retry');
  const { SessionRepository } = require('../src/repositories/SessionRepository');
  const { createSandbox } = require('../src/services/doc-agent/sandbox');

  const base = `http://127.0.0.1:${process.env.PORT || 5000}`;
  const fixturesDir = args.fixtures || path.join(__dirname, '..', 'tests', 'fixtures', 'office');
  const user = await prisma.user.findUnique({ where: { id: args.user }, select: { id: true, isAdmin: true, isSuperAdmin: true } });
  if (!user) throw new Error('usuario no encontrado');
  const token = jwt.sign({ userId: user.id, isAdmin: Boolean(user.isAdmin), isSuperAdmin: Boolean(user.isSuperAdmin) }, process.env.JWT_SECRET, {
    expiresIn: '2h', audience: process.env.JWT_AUDIENCE || 'siragpt-clients', issuer: process.env.JWT_ISSUER || 'siragpt-api',
  });
  const sessions = new SessionRepository({ prisma, withRetry: withAccelerateRetry });
  const session = await sessions.create({ userId: user.id, token, expiresAt: new Date(Date.now() + 2 * 3600e3) });
  const headers = { Authorization: `Bearer ${token}` };
  const results = [];
  try {
    const selected = SCENARIOS.filter((s) => !args.only || args.only.includes(s.n));
    for (const scenario of selected) {
      let row;
      try {
        row = await runScenario({ scenario, base, headers, fixturesDir, provider: args.provider, model: args.model, route: args.route, createSandbox });
      } catch (err) {
        row = { n: scenario.n, id: scenario.id, passed: false, checks: [{ name: 'el turno corrió', ok: false, detail: String(err && err.message || err).slice(0, 200) }] };
      }
      results.push(row);
      const failed = (row.checks || []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
      console.log(`${row.passed ? 'PASS' : 'FAIL'} #${row.n} ${row.id} ${row.seconds ?? '-'}s tools=${(row.tools || []).join('>')} verify=${row.verifyAttempts ?? 0} thumbs=${row.thumbs ?? 0} trace=${row.persistedTrace ?? 0}${failed.length ? ` :: ${failed.join(' | ')}` : ''}`);
    }
  } finally {
    if (!args.keep) {
      for (const r of results) {
        if (!r.chatId) continue;
        await prisma.chat.update({ where: { id: r.chatId }, data: { deletedAt: new Date() } }).catch(() => {});
      }
    }
    await prisma.session.deleteMany({ where: { id: session.id } }).catch(() => {});
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(`\nEdición milimétrica — ${passed}/${results.length} escenarios aprobados (${args.provider} ${args.model}, ruta ${args.route})`);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ model: args.model, provider: args.provider, route: args.route, passed, total: results.length, results }, null, 2));
  await prisma.$disconnect().catch(() => {});
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((err) => {
  console.error('run-office-evals falló:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
