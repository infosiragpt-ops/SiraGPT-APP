/**
 * capabilities — the vocabulary of permissions a skill can request and a
 * session can grant.
 *
 * A capability is just a string. We define the known ones here so that
 * skill manifests and session policies speak the same language (and so a
 * typo in a manifest fails loudly at load time rather than silently
 * granting or denying access).
 *
 * Design notes:
 *   - Namespaced ("net:outbound" vs a bare "net") so we can add narrower
 *     variants later (e.g. "net:outbound:openai") without churn.
 *   - Additive, not hierarchical: granting "fs:read" does NOT imply
 *     "fs:write". We prefer an explicit list of grants over a lattice
 *     because lattices are easy to get subtly wrong.
 *   - Every skill manifest MUST declare its capabilities array. A skill
 *     with an empty capability list is assumed pure-compute (no I/O).
 *
 * Sessions match against this vocabulary via services/skills/policy.js.
 */

const CAPABILITIES = Object.freeze({
  // Filesystem — "fs:read" means read from the user's RAG/knowledge
  // collection, NOT the host filesystem. siraGPT skills never touch the
  // host disk; if a future skill needs to, introduce "host:fs:read"
  // explicitly rather than overloading this.
  FS_READ:       'fs:read',
  FS_WRITE:      'fs:write',

  // Network — outbound HTTP to anywhere. A stricter "net:outbound:llm"
  // exists specifically for LLM calls so a "no external I/O" session can
  // still let the agent reason.
  NET_OUTBOUND:  'net:outbound',
  NET_LLM:       'net:outbound:llm',

  // Browser / Computer Use — can drive a headless browser, take
  // screenshots, synthesise clicks. Strictly higher risk than net:outbound
  // because it can also see auth'd sessions on the host.
  BROWSER:       'browser',

  // Fixed-function multimedia processing. This permits bounded ffmpeg/
  // ffprobe contracts, never arbitrary command or shell execution.
  MEDIA_PROCESS: 'media:process',

  // Scheduling — create/list/cancel cron jobs + webhooks. Separate from
  // net:outbound because a scheduled job can run when the user isn't
  // watching, so the trust model is different.
  SCHEDULE:      'schedule',

  // Sub-agent spawning — session_spawn, session_send. Guarded by its
  // own capability so a sandboxed session can't recursively escape by
  // spawning a more-privileged child.
  AGENT_SPAWN:   'agent:spawn',
  AGENT_READ:    'agent:read',   // session_list, session_history

  // Shell / arbitrary execution — NOT granted to any bundled skill
  // today. Reserved so that if someone adds a code-sandbox skill they
  // can't accidentally ship it with default-on permissions.
  SHELL:         'shell',

  // LLM — making model calls at all. Cheap to forget to declare, so
  // callers can keep it implicitly granted in the "main" policy; for
  // "sandbox" it's still on by default (a sandboxed agent without an
  // LLM is useless), but listed here for completeness.
  LLM:           'llm:call',
});

const ALL_CAPABILITIES = Object.freeze(Object.values(CAPABILITIES));
const KNOWN = new Set(ALL_CAPABILITIES);

function isKnown(cap) {
  return KNOWN.has(cap);
}

function assertKnown(caps, where) {
  if (!Array.isArray(caps)) throw new Error(`${where}: capabilities must be an array`);
  for (const c of caps) {
    if (!isKnown(c)) {
      throw new Error(`${where}: unknown capability "${c}". Add to services/skills/capabilities.js or fix the typo.`);
    }
  }
}

module.exports = {
  CAPABILITIES,
  ALL_CAPABILITIES,
  isKnown,
  assertKnown,
};
