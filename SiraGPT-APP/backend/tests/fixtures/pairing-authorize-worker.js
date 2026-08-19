'use strict';

const { PrismaClient } = require('@prisma/client');
const {
  authorizeSender,
} = require('../../src/services/codex/business-channels');

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || null,
    stack: error?.stack || null,
  };
}

function send(message) {
  return new Promise((resolve) => {
    if (!process.send) {
      resolve();
      return;
    }
    process.send(message, resolve);
  });
}

async function waitUntil(timestamp) {
  const delay = Number(timestamp) - Date.now();
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function authorizeBatch(message) {
  await waitUntil(message.startAt);
  return Promise.all(message.senderRefs.map((senderRef) => authorizeSender({
    prisma,
    channel: message.channel,
    senderRef,
    env: process.env,
  })));
}

let shuttingDown = false;

process.on('message', async (message) => {
  if (message?.type === 'shutdown') {
    if (shuttingDown) return;
    shuttingDown = true;
    await prisma.$disconnect();
    await send({ type: 'closed' });
    process.exit(0);
    return;
  }
  if (message?.type !== 'authorize' || shuttingDown) return;
  try {
    const results = await authorizeBatch(message);
    await send({
      type: 'result',
      requestId: message.requestId,
      ok: true,
      results,
    });
  } catch (error) {
    await send({
      type: 'result',
      requestId: message.requestId,
      ok: false,
      error: serializeError(error),
    });
  }
});

async function boot() {
  await prisma.$connect();
  await send({ type: 'ready', pid: process.pid });
}

boot().catch(async (error) => {
  await send({ type: 'fatal', error: serializeError(error) });
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
