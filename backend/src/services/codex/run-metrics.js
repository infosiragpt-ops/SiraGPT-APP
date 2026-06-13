'use strict';

/**
 * codex/run-metrics — the numbers behind the "Worked for N minutes" card
 * (feature 08, spec §7/§4). A mutable accumulator the build loop feeds
 * (recordAction / recordLinesRead / recordLlmUsage); at close `finalize`
 * computes timeWorkedMs (job clock), folds in the checkpoint diffstat
 * (additions/deletions), resolves cost per LLM call through the cost ladder,
 * applies the plan multiplier, upserts `CodexRunMetric`, and emits `run_summary`.
 *
 * Honest counting: actionsCount = actions with an action_end (any status);
 * itemsReadLines = summed read_file lines; caps/truncation never inflate.
 *
 * Persistence is guarded (only touches the DB when a real prisma with
 * codexRunMetric is passed), so the loop's tests stay offline.
 */

const { resolveCost, aggregateSource } = require('./cost-resolver');
const { applyPlanPricing } = require('./pricing-policy');

function createAccumulator({ run, clock = () => new Date() } = {}) {
  const startedAtMs = run && run.startedAt ? new Date(run.startedAt).getTime() : clock().getTime();
  let actionsCount = 0;
  let itemsReadLines = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const usageRecords = [];

  return {
    recordAction() { actionsCount += 1; },
    recordLinesRead(n) { if (Number.isFinite(n) && n > 0) itemsReadLines += n; },
    recordLlmUsage(u) {
      if (!u) return;
      usageRecords.push(u);
      tokensIn += Number(u.tokensIn) || 0;
      tokensOut += Number(u.tokensOut) || 0;
    },
    snapshot() { return { actionsCount, itemsReadLines, tokensIn, tokensOut }; },

    /**
     * Compute, persist (best-effort) and emit the final metric.
     * @returns the public metric object (also the run_summary payload).
     */
    async finalize({ diffstat, userPlan, prisma, eventStore, costResolver, fetchImpl, env = process.env, clock: clk } = {}) {
      const nowMs = (clk || clock)().getTime();
      const timeWorkedMs = Math.max(0, nowMs - startedAtMs);
      const additions = Number(diffstat?.additions) || 0;
      const deletions = Number(diffstat?.deletions) || 0;

      let costOriginalUsd = 0;
      const sources = [];
      const resolver = costResolver || resolveCost;
      for (const u of usageRecords) {
        // eslint-disable-next-line no-await-in-loop
        const { costUsd, costSource } = await resolver(u, { env, fetchImpl });
        costOriginalUsd += Number(costUsd) || 0;
        sources.push(costSource);
      }
      const costSource = aggregateSource(sources);
      const priced = applyPlanPricing(userPlan, costOriginalUsd, { env });

      const metric = {
        timeWorkedMs,
        actionsCount,
        itemsReadLines,
        additions,
        deletions,
        tokensIn,
        tokensOut,
        costUsd: priced.costAppliedUsd,
        costSource,
        costOriginalUsd: priced.costOriginalUsd,
        costAppliedUsd: priced.costAppliedUsd,
      };

      if (prisma && prisma.codexRunMetric && run && run.id) {
        try {
          await prisma.codexRunMetric.upsert({
            where: { runId: run.id },
            create: { runId: run.id, ...metric },
            update: { ...metric },
          });
        } catch (err) {
          if (env.NODE_ENV !== 'test') console.warn('[codex run-metrics] upsert failed:', err?.message || err);
        }
      }

      if (eventStore && eventStore.appendEvent && run && run.id) {
        await eventStore.appendEvent(run.id, 'run_summary', { metrics: metric }, { prisma }).catch(() => {});
      }
      return metric;
    },
  };
}

module.exports = { createAccumulator };
