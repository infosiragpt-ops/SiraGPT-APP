'use strict';

/**
 * codex/agent-loop — the brain of a run, executed inside the BullMQ job
 * (feature 06). `runAgentLoop` emits domain events (plan_proposed, narrative,
 * actions, reasoning, checkpoint, run_summary) and returns a terminal outcome
 * `{ status: 'waiting_approval' | 'done' | 'error', error? }`. The processor
 * (run-processor.js) owns the run_status transitions around it.
 *
 * NOTE: This is the feature-05 seam — a minimal, deterministic loop so the run
 * lifecycle is wired end-to-end. Feature 06 replaces the body with the real
 * LLM ↔ tools loop (plan-mode.js + build-tools.js + prompted-tool-calling),
 * keeping this signature stable.
 */

async function runAgentLoop({ run, project, isCancelled, deps = {} } = {}) {
  const { eventStore, prisma } = deps;
  if (!eventStore) throw new Error('agent-loop: eventStore dep required');
  const runId = run.id;

  if (typeof isCancelled === 'function' && (await isCancelled())) {
    return { status: 'cancelled' };
  }

  if (run.mode === 'plan') {
    // Minimal deterministic plan so the approval gate is reachable. Feature 06
    // produces a real LLM plan from the user's prompt + workspace context.
    const plan = {
      architecture: `Proyecto ${project?.name || 'Codex'} (Vite + JS)`,
      pages: ['/'],
      components: ['App'],
      tasks: [{ id: 't1', title: 'Estructura inicial', status: 'pending' }],
    };
    await eventStore.appendEvent(runId, 'plan_proposed', plan, { prisma });
    return { status: 'waiting_approval' };
  }

  // build mode (minimal): narrate, then finish. Feature 06 runs the tool loop.
  await eventStore.appendEvent(
    runId,
    'narrative_delta',
    { text: 'Voy a construir el proyecto según el plan aprobado.' },
    { prisma },
  );
  return { status: 'done' };
}

module.exports = { runAgentLoop };
