'use strict';
const defaultStore = require('./research-run-store');
const crypto = require('crypto');

function createResearchRuns({ store = defaultStore, agent, prisma, resolveModel, now = Date.now } = {}) {
  const active = new Map();
  const staleMs = 90_000;
  const publicRun = run => ({ runId: run.id, chatId: run.chatId, status: run.status, result: run.result, error: run.error, updatedAt: run.updatedAt });
  const error = (status, message) => Object.assign(new Error(message), { status });
  async function owned(runId, userId) {
    const run = store.loadRun(runId);
    if (!run || run.userId !== userId) throw error(404, 'research_run_not_found');
    if (run.chatId && !await prisma.chat.findFirst({ where: { id: run.chatId, userId, deletedAt: null }, select: { id: true } })) throw error(404, 'research_run_not_found');
    if (run.status === 'running' && !active.has(runId) && now() - (run.heartbeatAt || run.createdAt) > staleMs) {
      run.status = 'failed';
      run.error = 'La investigación se interrumpió. Puedes volver a iniciarla.';
      store.saveRun(run);
    }
    return run;
  }
  async function persistResult(run, result) {
    if (!run.chatId) return;
    const messageId = `research_${crypto.createHash('sha256').update(`${run.userId}:${run.id}`).digest('hex').slice(0, 40)}`;
    await prisma.$transaction(async tx => {
      const chat = await tx.chat.findFirst({ where: { id: run.chatId, userId: run.userId, deletedAt: null }, select: { id: true } });
      if (!chat) throw error(404, 'research_chat_not_found');
      await tx.message.upsert({ where: { id: messageId }, update: {}, create: {
        id: messageId, chatId: run.chatId, role: 'ASSISTANT', content: result.report,
        metadata: { research: result, researchRunId: run.id, model: run.model || null, provider: run.provider || null },
      } });
      await tx.chat.update({ where: { id: run.chatId }, data: { updatedAt: new Date(now()) } });
    });
  }
  async function start(userId, input, listener) {
    const chatId = input.chatId || null;
    if (chatId && !await prisma.chat.findFirst({ where: { id: chatId, userId, deletedAt: null }, select: { id: true } })) throw error(404, 'research_chat_not_found');
    if (input.userMessageId && !await prisma.message.findFirst({ where: { id: input.userMessageId, chatId, role: 'USER' }, select: { id: true } })) throw error(400, 'invalid_user_message');
    const id = input.runId || store.createRunId();
    const prior = store.loadRun(id);
    if (prior) {
      const run = await owned(id, userId);
      if (run.chatId !== chatId || run.query !== input.query || run.model !== input.model || run.provider !== input.provider) throw error(409, 'research_run_conflict');
      if (listener && active.has(id)) active.get(id).listeners.add(listener);
      return publicRun(run);
    }
    const runningForUser = [...active.values()].filter(entry => entry.userId === userId).length;
    if (runningForUser >= 2) throw error(429, 'research_concurrency_limit');
    const runtime = input.model ? await resolveModel(input) : {};
    const run = { id, userId, chatId, query: input.query, model: input.model, provider: input.provider, depth: input.depth || 'standard', status: 'running', createdAt: now(), heartbeatAt: now(), updatedAt: now(), events: [] };
    if (!store.claimRun(run)) throw error(409, 'research_run_starting');
    const controller = new AbortController();
    const listeners = new Set(listener ? [listener] : []);
    const entry = { userId, controller, listeners, committing: false };
    active.set(id, entry);
    const send = event => { for (const notify of listeners) { try { notify(event); } catch {} } };
    const heartbeat = setInterval(() => {
      try {
        if (store.isCancelled(id)) controller.abort();
        const current = store.loadRun(id);
        if (current?.status === 'running') store.saveRun({ ...current, heartbeatAt: now() });
      } catch { controller.abort(); }
    }, 3000);
    heartbeat.unref?.();
    // No socket ownership: disconnecting merely detaches an observer.
    entry.promise = (async () => {
      try {
        const result = await agent.run({ ...input, ...runtime, runId: id, managed: true, signal: controller.signal, onEvent: event => {
          if (controller.signal.aborted) return;
          store.appendEvent(id, event);
          send(event);
        } });
        if (controller.signal.aborted || store.isCancelled(id)) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        entry.committing = true;
        // Keep the full result before the DB commit; recovering a lost final
        // acknowledgement upserts the same assistant id, never a second turn.
        store.saveRun({ ...store.loadRun(id), result });
        await persistResult(run, result);
        store.saveRun({ ...store.loadRun(id), status: 'completed', result });
        send({ type: 'report', report: result, runId: id });
        send({ type: 'done', runId: id, stats: result.stats });
      } catch (err) {
        const cancelled = controller.signal.aborted || store.isCancelled(id);
        const status = cancelled ? 'cancelled' : 'failed';
        const message = cancelled ? 'Investigación detenida.' : 'No se pudo completar la investigación. Puedes reintentar.';
        try { store.saveRun({ ...store.loadRun(id), status, error: message }); } catch {}
        send({ type: cancelled ? 'cancelled' : 'error', runId: id, message });
      } finally { clearInterval(heartbeat); active.delete(id); }
    })();
    return publicRun(run);
  }
  return {
    start,
    async get(id, userId) {
      const run = await owned(id, userId);
      // A process may die after storing its result or committing the message.
      // The deterministic upsert closes that crash window without re-running AI.
      if (run.result && run.status !== 'cancelled' && !active.has(id)) {
        await persistResult(run, run.result);
        run.status = 'completed'; delete run.error; store.saveRun(run);
      }
      return publicRun(run);
    },
    async cancel(id, userId) {
      let run = await owned(id, userId);
      const entry = active.get(id);
      if (entry?.committing) { await entry.promise; run = await owned(id, userId); }
      // Once a durable result exists, finalization won the race. Another
      // replica must not acknowledge cancellation while that same result is
      // being committed to the conversation.
      if (run.result && run.status === 'running') {
        await persistResult(run, run.result);
        run = { ...run, status: 'completed' };
        store.saveRun(run);
      }
      if (run.status === 'running') {
        store.requestCancel(id);
        entry?.controller.abort();
        // Request is durable; a worker checks it before every next stage.
        run = { ...run, status: 'cancelled', error: 'Investigación detenida.' };
        store.saveRun(run);
      }
      return publicRun(run);
    },
    detach(id, listener) { active.get(id)?.listeners.delete(listener); },
    active,
  };
}
module.exports = { createResearchRuns };
