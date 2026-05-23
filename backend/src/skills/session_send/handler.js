const prisma = require('../../config/database');
const { runAgent, MAX_SPAWN_DEPTH } = require('../../services/agents/agent-entry');

async function execute(args, ctx) {
  if (!ctx?.userId) throw new Error('session_send: ctx.userId required');
  const { sessionId, message, runAgent: doRun, thinking } = args || {};
  if (!sessionId || !message) return { error: 'missing sessionId or message' };

  const chat = await prisma.chat.findUnique({
    where: { id: sessionId },
    select: { userId: true },
  });
  if (!chat) return { error: 'session not found' };
  if (chat.userId !== ctx.userId) return { error: 'not your session' };

  if (!doRun) {
    // Pure note-taking mode: record an assistant message and return.
    // This is how a parent agent leaves a follow-up result in a
    // sub-session without re-running the sub-agent.
    const note = await prisma.message.create({
      data: {
        chatId: sessionId,
        role: 'ASSISTANT',
        content: message,
        metadata: { note: true, source: ctx.source || 'agent' },
      },
      select: { id: true },
    });
    return { appended: true, messageId: note.id, sessionId };
  }

  const depth = ctx.depth || 0;
  if (depth >= MAX_SPAWN_DEPTH) {
    return {
      appended: false,
      reason: `spawn depth already at ${depth}; max is ${MAX_SPAWN_DEPTH}`,
    };
  }

  // runAgent mode: append as user message, run agent, append answer.
  await prisma.message.create({
    data: {
      chatId: sessionId, role: 'USER', content: message,
      metadata: { sentBy: ctx.source || 'agent', depth: depth + 1 },
    },
  });

  let result;
  try {
    result = await runAgent({
      userId: ctx.userId,
      prompt: message,
      thinking: thinking || 'low',
      mode: 'sandbox',
      source: `send:depth${depth + 1}`,
      depth: depth + 1,
    });
  } catch (err) {
    await prisma.message.create({
      data: {
        chatId: sessionId, role: 'ASSISTANT',
        content: `[send-run error] ${err.message}`,
        metadata: { error: true },
      },
    });
    return { appended: true, sessionId, ran: true, ok: false, error: err.message };
  }

  await prisma.message.create({
    data: {
      chatId: sessionId, role: 'ASSISTANT',
      content: result.answer || '(no answer)',
      metadata: { stoppedReason: result.stoppedReason, plan: result.plan || null },
    },
  });

  return {
    appended: true, sessionId, ran: true, ok: true,
    answer: result.answer, stoppedReason: result.stoppedReason,
  };
}

module.exports = { execute };
