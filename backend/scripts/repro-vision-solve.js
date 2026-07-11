#!/usr/bin/env node
'use strict';

/**
 * repro-vision-solve.js — live repro for the "resolver + image → bare LaTeX
 * transcription" bug. Renders the exact exercise from the report
 * (f(x) = (x^4+3x+1)^3 / (x^5+3)) as a PNG, uploads it through the REAL
 * /api/files/upload, sends "resolver" through the REAL /api/ai/generate
 * (SSE), and grades the answer: PASS when it actually SOLVES (derivative,
 * step markers) instead of only transcribing.
 *
 * Reuses the auth-mint recipe from run-live-chat-e2e.js. Cleans up after.
 */

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') }); } catch (_) {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const sharp = require('sharp');
const {
  createSessionRecord,
} = require('../src/services/auth/session-token-persistence');

const prisma = new PrismaClient();
const BASE = process.env.E2E_BASE_URL || 'http://localhost:5000';

async function main() {
  // ── 1. exercise image (exact case from the report) ──────────────────────
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="220" style="background:#fff">
    <text x="40" y="90" font-family="Georgia, serif" font-size="34" fill="#c00" font-weight="bold">Ejercicio n° 46):  f(x) =</text>
    <text x="470" y="62" font-family="Georgia, serif" font-size="30" fill="#c00">(x</text>
    <text x="498" y="50" font-family="Georgia, serif" font-size="20" fill="#c00">4</text>
    <text x="512" y="62" font-family="Georgia, serif" font-size="30" fill="#c00"> + 3x + 1)</text>
    <text x="650" y="48" font-family="Georgia, serif" font-size="20" fill="#c00">3</text>
    <rect x="465" y="78" width="210" height="3" fill="#c00"/>
    <text x="520" y="125" font-family="Georgia, serif" font-size="30" fill="#c00">x</text>
    <text x="540" y="112" font-family="Georgia, serif" font-size="20" fill="#c00">5</text>
    <text x="552" y="125" font-family="Georgia, serif" font-size="30" fill="#c00"> + 3</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();

  // ── 2. auth: tagged test user + session (fingerprint null) ──────────────
  const email = `repro-vision+${Date.now()}@siragpt.local`;
  const user = await prisma.user.create({
    data: {
      email, name: 'Repro Vision', password: 'x', plan: 'ENTERPRISE',
      monthlyLimit: 99999999, monthlyCallLimit: 99999999,
    },
  });
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
    expiresIn: '1h', audience: 'siragpt-clients', issuer: 'siragpt-api',
  });
  await createSessionRecord(prisma, {
    userId: user.id,
    token,
    fingerprint: null,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const H = { Authorization: `Bearer ${token}` };

  let fileId = null;
  let chatId = null;
  try {
    // ── 3. upload through the real pipeline ───────────────────────────────
    const fd = new FormData();
    fd.append('files', new Blob([png], { type: 'image/png' }), 'ejercicio46.png');
    const up = await fetch(`${BASE}/api/files/upload`, { method: 'POST', headers: H, body: fd });
    const upJson = await up.json();
    const f = (upJson.files || upJson.data || [])[0] || upJson.file || upJson;
    fileId = f?.id;
    if (!fileId) throw new Error(`upload failed: ${JSON.stringify(upJson).slice(0, 300)}`);
    console.log(`uploaded: id=${fileId}`);

    // ── 4. chat turn: image + "resolver" via SSE ──────────────────────────
    const chat = await prisma.chat.create({ data: { userId: user.id, title: 'repro-vision', model: 'moonshotai/kimi-k2.6' } });
    chatId = chat.id;
    const res = await fetch(`${BASE}/api/ai/generate`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        prompt: 'resolver',
        model: 'moonshotai/kimi-k2.6',
        provider: 'OpenRouter',
        chatId,
        files: [fileId],
        stream: true,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    console.log(`generate: HTTP ${res.status}`);
    let answer = '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop();
      for (const fr of frames) {
        const m = fr.match(/^data:\s*(.*)$/m);
        if (!m || m[1] === '[DONE]') continue;
        try {
          const evt = JSON.parse(m[1]);
          if (typeof evt.content === 'string') answer = evt.replace ? evt.content : answer + evt.content;
        } catch (_) {}
      }
    }
    const norm = answer.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const startsAsTranscription = /^\s*(aqui esta la transcripcion|here is the transcription)/.test(norm);
    const solves = /(f\s*'|f\^\\?prime|derivada|derivative|regla (del cociente|de la cadena)|quotient rule|chain rule)/.test(norm);
    console.log('--- answer (first 700 chars) ---');
    console.log(answer.slice(0, 700));
    console.log('--- verdict ---');
    console.log(`starts as bare transcription: ${startsAsTranscription}`);
    console.log(`actually solves (derivative/steps): ${solves}`);
    console.log(solves && !startsAsTranscription ? 'PASS ✅' : 'FAIL ❌');
    process.exitCode = solves && !startsAsTranscription ? 0 : 1;
  } finally {
    // ── 5. cleanup ─────────────────────────────────────────────────────────
    try { if (chatId) await prisma.message.deleteMany({ where: { chatId } }); } catch (_) {}
    try { if (chatId) await prisma.chat.delete({ where: { id: chatId } }); } catch (_) {}
    try { if (fileId) await prisma.file.delete({ where: { id: fileId } }); } catch (_) {}
    try { await prisma.session.deleteMany({ where: { userId: user.id } }); } catch (_) {}
    try { await prisma.user.delete({ where: { id: user.id } }); } catch (_) {}
    await prisma.$disconnect().catch(() => {});
    console.log('cleaned up');
  }
}

main().catch((e) => { console.error('repro error:', e.message); process.exit(2); });
