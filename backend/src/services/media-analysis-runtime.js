'use strict';

// Use the already-resolved composer client. Account for every chunk call, not
// merely the final synthesis, and stop before starting another paid call when
// the existing plan policy says the budget is exhausted.
function createMediaAnalysisCompletion({ client, model, provider, userId, chatId, prisma,
  quota = require('./plan-quota'), record = require('./observability/record-llm-usage').recordLLMUsage,
  maxCalls = 500 }) {
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const complete = async (messages, signal, final = false) => {
    signal?.throwIfAborted();
    if (usage.calls >= maxCalls) throw new Error('media_analysis_call_budget_exhausted');
    const user = await prisma.user.findUnique({ where: { id: userId }, select: {
      id: true, plan: true, apiUsage: true, monthlyLimit: true, monthlyCallLimit: true, isSuperAdmin: true, isAdmin: true,
    } });
    if (!user) throw new Error('media_analysis_user_unavailable');
    // authenticateToken grants both administrator roles unlimitedCredits.
    // The fresh DB read must preserve that entitlement, not undo it.
    const exempt = user.isAdmin === true || quota.isPlanQuotaExempt(user);
    const allowed = exempt ? { ok: true } : await quota.tryConsumePlanQuota({ user, userId, prisma, hasAttachments: true });
    if (!allowed.ok) throw new Error('media_analysis_plan_quota_exhausted');
    usage.calls++;
    const started = Date.now();
    const response = await client.chat.completions.create({ model, messages,
      max_tokens: final ? 6000 : 1000, stream: false }, { signal, timeout: 120000, maxRetries: 1 });
    const inputTokens = Math.max(0, Number(response?.usage?.prompt_tokens ?? response?.usage?.input_tokens)
      || Math.ceil(JSON.stringify(messages).length / 4));
    const text = String(response?.choices?.[0]?.message?.content || '');
    const outputTokens = Math.max(0, Number(response?.usage?.completion_tokens ?? response?.usage?.output_tokens)
      || Math.ceil(text.length / 4));
    const cost = record({ userId, chatId, model, provider, inputTokens, outputTokens,
      latencyMs: Date.now() - started, surface: 'chat.media-batch' });
    usage.inputTokens += inputTokens; usage.outputTokens += outputTokens;
    usage.costUsd += Number(cost?.cost_usd) || 0;
    // Preserve the established FREE attachment exemption and superadmin
    // exemption. Paid plans retain the same token accounting as normal chat.
    if (user.plan !== 'FREE' && !exempt) {
      await prisma.$transaction([
        prisma.apiUsage.create({ data: { userId, model, tokens: inputTokens + outputTokens, cost: Number(cost?.cost_usd) || 0 } }),
        prisma.user.update({ where: { id: userId }, data: { apiUsage: { increment: inputTokens + outputTokens } } }),
      ]);
    }
    return text;
  };
  return { complete, usage };
}

module.exports = { createMediaAnalysisCompletion };
