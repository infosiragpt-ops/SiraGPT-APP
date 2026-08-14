'use strict';

/**
 * F4 — Shared blackboard, in-memory and scoped to ONE orchestration run.
 *
 * Sub-agents never talk to each other directly: each completed node writes
 * its result here and downstream nodes read the results of the nodes they
 * depend on (text summary + output files). Steering notes injected by
 * `steer(runId, message)` live here too. Nothing is persisted beyond the
 * run — no Prisma model, no disk state.
 */

const MAX_TEXT_CHARS = 2_000;

function createBlackboard() {
  const entries = new Map(); // nodeId -> { id, role, goal, finalText, outputs }
  const steeringNotes = [];

  return {
    write(nodeId, entry) {
      entries.set(String(nodeId), { id: String(nodeId), ...entry });
    },
    read(nodeId) {
      return entries.get(String(nodeId)) || null;
    },
    has(nodeId) {
      return entries.has(String(nodeId));
    },
    completedIds() {
      return [...entries.keys()];
    },
    all() {
      return [...entries.values()];
    },
    addSteering(note) {
      const text = String(note || '').trim();
      if (text) steeringNotes.push(text);
    },
    get steering() {
      return [...steeringNotes];
    },
    /**
     * Text block a downstream node receives about its upstream dependencies:
     * per-dep final text (capped) + the artifact filenames it can find in
     * /workspace/uploads.
     */
    upstreamContext(dependsOn = []) {
      const parts = [];
      for (const depId of dependsOn) {
        const dep = entries.get(String(depId));
        if (!dep) continue;
        const files = (dep.outputs || [])
          .map((o) => o && o.name)
          .filter(Boolean);
        const lines = [`RESULTADO DEL NODO ${dep.id} (${dep.role || 'sub-agente'}):`];
        const text = String(dep.finalText || '').trim();
        if (text) lines.push(text.slice(0, MAX_TEXT_CHARS));
        if (files.length) {
          lines.push(`Archivos producidos (disponibles en /workspace/uploads): ${files.join(', ')}`);
        }
        parts.push(lines.join('\n'));
      }
      return parts.join('\n\n');
    },
  };
}

module.exports = { createBlackboard, MAX_TEXT_CHARS };
