/**
 * session_spawn — launches a sub-agent in a new chat session.
 *
 * Safety:
 *   - The sub-agent always runs in 'sandbox' mode regardless of the
 *     parent's mode. Escalating a sub-agent above the parent would
 *     defeat the sandbox model (a confined agent could break out by
 *     spawning a child and delegating).
 *   - Depth is tracked through ctx.depth, checked inside agent-entry
 *     against MAX_SPAWN_DEPTH. A sub-agent at depth N sees its
 *     ctx.depth as N+1 when it runs its own spawn, and so on.
 *   - The sub-agent's final answer is persisted as a single assistant
 *     Message in the new chat so the parent (or the user) can inspect
 *     what happened later via session_history.
 */

const prisma = require('../../config/database');
const { runAgent, MAX_SPAWN_DEPTH } = require('../../services/agents/agent-entry');

const DEFAULT_MODEL = 'gpt-4o';

async function execute(args, ctx) {
  if (!ctx?.userId) throw new Error('session_spawn: ctx.userId required');
  const depth = ctx.depth || 0;
  if (depth >= MAX_SPAWN_DEPTH) {
    return {
      spawned: false,
      reason: `spawn depth already at ${depth}; max is ${MAX_SPAWN_DEPTH}. Refusing to recurse further.`,
    };
  }

  const prompt = args?.prompt;
  if (!prompt || typeof prompt !== 'string') return { error: 'missing prompt' };
  const title = (args?.title || prompt).slice(0, 80);

  // 1. Create the new chat row up front so even if the agent run
  //    crashes the operator can inspect what was attempted.
  const chat = await prisma.chat.create({
    data: {
      userId: ctx.userId,
      title,
      model: DEFAULT_MODEL,
    },
    select: { id: true },
  });

  // 2. Persist the user's instruction as the opening message.
  await prisma.message.create({
    data: {
      chatId: chat.id,
      role: 'USER',
      content: prompt,
      metadata: { spawnedBy: ctx.source || 'agent', depth: depth + 1 },
    },
  });

  // 3. Run the agent at depth+1 in sandbox mode.
  let result;
  try {
    result = await runAgent({
      userId: ctx.userId,
      prompt,
      thinking: args?.thinking || 'low',
      mode: 'sandbox',
      model: DEFAULT_MODEL,
      source: `spawn:depth${depth + 1}`,
      depth: depth + 1,
    });
  } catch (err) {
    // Write the failure into the sub-session as an assistant message
    // so it's visible. We don't re-throw — the parent should see a
    // structured "spawn failed" observation, not a stack trace.
    await prisma.message.create({
      data: {
        chatId: chat.id,
        role: 'ASSISTANT',
        content: `[spawn error] ${err.message}`,
        metadata: { error: true },
      },
    });
    return { spawned: true, sessionId: chat.id, ok: false, error: err.message };
  }

  // 4. Persist the sub-agent's final answer.
  await prisma.message.create({
    data: {
      chatId: chat.id,
      role: 'ASSISTANT',
      content: result.answer || '(no answer)',
      metadata: { stoppedReason: result.stoppedReason, plan: result.plan || null },
    },
  });

  return {
    spawned: true,
    sessionId: chat.id,
    title,
    depth: depth + 1,
    answer: result.answer,
    stoppedReason: result.stoppedReason,
  };
}

module.exports = { execute };
