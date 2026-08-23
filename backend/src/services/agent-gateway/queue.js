'use strict';

/**
 * Per-sessionKey serial lane.
 * sessionKey = logical conversation lane (queue + writer claim).
 * sessionId  = transcript instance -- never used for serialization.
 *
 * A newer startAgent() claims activeWriterRunId so a superseded in-flight
 * turn cannot persist/commit after it finishes.
 *
 * 3H2-BE-015 -- fail-closed session abort leftover: abortSession() rejects
 * subsequent enqueue until the next claimWriter (new turn).
 */

function createSessionQueue() {
  const lanes = new Map();
  const writers = new Map();
  const abortFlags = new Map();
  const sessionAborted = new Map();
  const pending = new Map();
  const inFlightIdem = new Map();
  const MAX_PENDING = 8;

  let enqueueSeq = 0;
  const enqueueAt = new Map();
  const cancelledJobs = new Map();
  const jobRecords = new Map(); // sessionKey -> job[]
  let lastFair = null;
  function loadRuntime() {
    try { return require('../agent-runner/engine-runtime'); } catch (_) { return null; }
  }
  function loadResilience() {
    try { return require('../agent-runner/engine-resilience'); } catch (_) { return null; }
  }
  function loadCorrectness() {
    try { return require('../agent-runner/engine-correctness'); } catch (_) { return null; }
  }
  function loadLifecycle() {
    try { return require('../agent-runner/engine-lifecycle'); } catch (_) { return null; }
  }
  function loadAdapter() {
    try { return require('../agent-runner/engine-adapter'); } catch (_) { return null; }
  }
  const sessionGate = (function makeGate() {
    const r = loadResilience();
    return r && typeof r.createSessionTurnGate === 'function' ? r.createSessionTurnGate() : null;
  }());
  function assertJobRunnable(key, job) {
    if (sessionAborted.get(key)) {
      const err = new Error('session_aborted');
      err.code = 'session_aborted';
      throw err;
    }
    const runtime = loadRuntime();
    if (runtime && job) {
      const gate = runtime.jobMayRun(job, Date.now());
      if (!gate.run) {
        const err = new Error(gate.code || 'queue_cancel');
        err.code = gate.code || 'queue_cancel';
        throw err;
      }
    } else {
      try {
        const parity = require('../agent-runner/engine-parity');
        const lease = parity.expireQueueLease((job && job.enqueuedAt) || enqueueAt.get(key) || Date.now(), Date.now());
        if (lease.expired) {
          const err = new Error('queue_lease');
          err.code = 'queue_lease';
          throw err;
        }
      } catch (leaseErr) {
        if (leaseErr && leaseErr.code === 'queue_lease') throw leaseErr;
      }
    }
    if (cancelledJobs.get(key) || (job && job.cancelled)) {
      cancelledJobs.delete(key);
      const err = new Error('queue_cancel');
      err.code = 'queue_cancel';
      throw err;
    }
  }
  function enqueue(sessionKey, fn, opts = {}) {
    const key = String(sessionKey || '');
    if (!key) return Promise.reject(new Error('sessionKey es obligatorio'));
    if (typeof fn !== 'function') return Promise.reject(new Error('enqueue requiere una funcion'));
    if (sessionAborted.get(key)) {
      const err = new Error('session_aborted');
      err.code = 'session_aborted';
      return Promise.reject(err);
    }
    const queued = pending.get(key) || 0;
    if (queued >= MAX_PENDING) {
      const err = new Error('session_queue_full');
      err.code = 'session_queue_full';
      return Promise.reject(err);
    }
    try {
      const adPend = loadAdapter();
      const userKey = String((opts && (opts.userId || opts.user_id)) || key);
      if (adPend && typeof adPend.maxPendingGeneratePerUser === 'function') {
        const over = adPend.maxPendingGeneratePerUser(userKey, queued);
        if (over && over.ok === false) {
          const err = new Error('generate_overloaded');
          err.code = 'generate_overloaded';
          return Promise.reject(err);
        }
      }
    } catch (pendErr) {
      if (pendErr && pendErr.code === 'generate_overloaded') return Promise.reject(pendErr);
    }
    try {
      const adWait = loadAdapter();
      if (adWait && typeof adWait.generateWaitRetryAfter === 'function') {
        const wait = adWait.generateWaitRetryAfter({ waitMs: queued * 8000 });
        if (wait && wait.ok === false) {
          const err = new Error('generate_overloaded');
          err.code = 'generate_overloaded';
          err.retryAfterSec = wait.retryAfterSec;
          return Promise.reject(err);
        }
        if (wait && wait.ok === false) {
          const err = new Error('generate_overloaded');
          err.code = 'generate_overloaded';
          err.retryAfterSec = wait.retryAfterSec;
          return Promise.reject(err);
        }
        if (typeof adWait.queueMaxWait60sThen503 === 'function') {
          const waited = Number((opts && (opts.waitedMs || opts.queuedMs)) || queued * 8000);
          const qwait = adWait.queueMaxWait60sThen503({ waitedMs: waited, maxMs: 60000 });
          if (qwait && qwait.reject) {
            const err = new Error('queue_wait');
            err.code = 'queue_wait';
            err.status = 503;
            err.retryAfterSec = qwait.retryAfterSec;
            return Promise.reject(err);
          }
        }
        if (typeof adWait.queueMaxWait60sThen503 === 'function') {
          const waited = Number((opts && (opts.waitedMs || opts.queuedMs)) || queued * 8000);
          const qwait = adWait.queueMaxWait60sThen503({ waitedMs: waited, maxMs: 60000 });
          if (qwait && qwait.reject) {
            const err = new Error('queue_wait');
            err.code = 'queue_wait';
            err.status = 503;
            err.retryAfterSec = qwait.retryAfterSec;
            return Promise.reject(err);
          }
        }
        if (typeof adWait.queueFairShareExtraSlotIfWaitOver20s === 'function') {
          const waitedFair = Number((opts && (opts.waitedMs || opts.queuedMs)) || queued * 8000);
          adWait.queueFairShareExtraSlotIfWaitOver20s({ waitedMs: waitedFair, extraIfMs: 20000 });
        }
        if (typeof adWait.maxQueuedGenerate16 === 'function') {
          const qcap = adWait.maxQueuedGenerate16(queued, { max: 16 });
          if (qcap && qcap.reject) {
            const err = new Error('queue_generate_cap');
            err.code = 'queue_generate_cap';
            err.status = 429;
            return Promise.reject(err);
          }
        }
        if (typeof adWait.rejectStaleIdempotencyKeyOver1h === 'function') {
          const stale = adWait.rejectStaleIdempotencyKeyOver1h({ createdAt: opts && (opts.idempotencyCreatedAt || opts.createdAt), now: Date.now() });
          if (stale && stale.ok === false) {
            const err = new Error('idempotency_stale');
            err.code = 'idempotency_stale';
            err.status = 409;
            return Promise.reject(err);
          }
        }
        if (typeof adWait.rejectEnqueueIfSessionLockedByOther === 'function') {
          const lock = adWait.rejectEnqueueIfSessionLockedByOther({
            ownerId: opts && (opts.lockOwnerId || opts.ownerId),
            requesterId: opts && (opts.requesterId || opts.writerId),
            locked: opts && opts.locked,
          });
          if (lock && lock.ok === false) {
            const err = new Error('queue_lock');
            err.code = 'queue_lock';
            err.status = 409;
            return Promise.reject(err);
          }
        }
        if (typeof adWait.boostStarvedQueueAfterWaitMs === 'function') {
          adWait.boostStarvedQueueAfterWaitMs({
            waitedMs: opts && (opts.waitedMs || opts.queuedMs),
          });
        }
      }
    } catch (waitErr) {
      if (waitErr && waitErr.code === 'generate_overloaded') return Promise.reject(waitErr);
    }
    const idemRaw = opts && opts.idempotencyKey != null ? String(opts.idempotencyKey) : '';
    const idem = idemRaw ? `${key}:${idemRaw}` : '';
    if (idem && inFlightIdem.has(idem)) {
      const err = new Error('duplicate_turn');
      err.code = 'duplicate_turn';
      return Promise.reject(err);
    }
    if (idem && inFlightIdem.has(idem)) {
      const err = new Error('duplicate_turn');
      err.code = 'duplicate_turn';
      return Promise.reject(err);
    }
    try {
      const adIdent = loadAdapter();
      if (adIdent && typeof adIdent.rejectIdenticalPromptInflightSameSession === 'function') {
        const inflightRows = (jobRecords.get(key) || []).filter((j) => j && j.running).map((j) => ({
          sessionKey: key,
          prompt: (j && (j.prompt || j.text)) || (opts && (opts.prompt || opts.text)) || '',
        }));
        const ident = adIdent.rejectIdenticalPromptInflightSameSession({
          sessionKey: key,
          prompt: (opts && (opts.prompt || opts.text || opts.userPrompt)) || '',
          inflight: inflightRows.concat([{ sessionKey: key, prompt: (opts && (opts.prompt || opts.text || opts.userPrompt)) || '', _self: true }]).filter((r) => !r._self),
        });
        if (ident && ident.reject) {
          const err = new Error('identical_prompt_inflight');
          err.code = 'identical_prompt_inflight';
          return Promise.reject(err);
        }
      }
    } catch (identErr) {
      if (identErr && identErr.code === 'identical_prompt_inflight') return Promise.reject(identErr);
    }
    try {
      const ad = loadAdapter();
      if (ad && typeof ad.dropDuplicateInFlightGenerate === 'function') {
        const producer = String((opts && opts.runId) || idem || `q_${enqueueSeq + 1}`);
        const dup = ad.dropDuplicateInFlightGenerate(key, producer);
        if (dup && dup.dropped) {
          let queued = false;
          try {
            const fair = typeof ad.acquireFairGenerateLock === 'function'
              ? ad.acquireFairGenerateLock(key, producer)
              : null;
            queued = Boolean(fair && fair.queued);
            if (fair && fair.ok === false && !fair.queued) {
              const err = new Error('queue_fairness');
              err.code = 'queue_fairness';
              return Promise.reject(err);
            }
          } catch (_) {}
          if (!queued) {
            const err = new Error('duplicate_turn');
            err.code = 'duplicate_turn';
            return Promise.reject(err);
          }
        } else {
          try {
            if (typeof ad.acquireFairGenerateLock === 'function') ad.acquireFairGenerateLock(key, producer);
          } catch (_) {}
        }
        try {
          if (typeof ad.stealLockIfHeartbeatExpired === 'function' && opts && opts.lockHeartbeatAt != null) {
            ad.stealLockIfHeartbeatExpired({
              holder: opts.lockHolder,
              heartbeatAt: opts.lockHeartbeatAt,
              requester: producer,
              now: Date.now(),
            });
          }
        } catch (_) {}
      }
      if (ad && typeof ad.expireGatewayClaimTtl === 'function') ad.expireGatewayClaimTtl(key);
      if (ad && typeof ad.sessionGenerateRateLimit === 'function') {
        const rate = ad.sessionGenerateRateLimit(key);
        if (rate && rate.ok === false) {
          const err = new Error('rate_limited');
          err.code = 'rate_limited';
          return Promise.reject(err);
        }
      }
      if (ad && typeof ad.idempotentGenerateByRequestId === 'function' && opts && opts.requestId) {
        const idemReq = ad.idempotentGenerateByRequestId(key, String(opts.requestId));
        if (idemReq && idemReq.replay) {
          return Promise.resolve(idemReq.result);
        }
        if (idemReq && idemReq.pending && idemReq.code === 'duplicate_turn') {
          const err = new Error('duplicate_turn');
          err.code = 'duplicate_turn';
          return Promise.reject(err);
        }
      }
      if (ad && typeof ad.clockSkewSafeTtl === 'function' && opts && opts.issuedAt != null) {
        const skew = ad.clockSkewSafeTtl({ issuedAt: opts.issuedAt, ttlMs: opts.ttlMs || 45000, now: Date.now() });
        if (skew && skew.expired) {
          const err = new Error(skew.code || 'session_lock_stale');
          err.code = skew.code || 'session_lock_stale';
          return Promise.reject(err);
        }
      }
      if (ad && typeof ad.consumeGenerateResumeToken === 'function' && opts && opts.resumeToken) {
        const tok = ad.consumeGenerateResumeToken(String(opts.resumeToken), key);
        if (tok && tok.ok === false) {
          const err = new Error(tok.code || 'resume_conflict');
          err.code = tok.code || 'resume_conflict';
          return Promise.reject(err);
        }
      }
      if (ad && typeof ad.issueGenerateResumeToken === 'function' && opts && opts.patchResume) {
        opts.resumeIssued = ad.issueGenerateResumeToken(key);
      }
    } catch (_) {}
    pending.set(key, queued + 1);
    enqueueSeq += 1;
    const jobAt = Date.now();
    enqueueAt.set(key, jobAt);
    if (idem) inFlightIdem.set(idem, true);
    const runtime = loadRuntime();
    const made = runtime && typeof runtime.makeQueueJob === 'function'
      ? runtime.makeQueueJob({ sessionKey: key, idempotencyKey: idemRaw, enqueuedAt: jobAt })
      : { ok: true, job: { id: `q_${enqueueSeq}`, sessionKey: key, enqueuedAt: jobAt, cancelled: false, running: false } };
    const job = made.job;
    const list = jobRecords.get(key) || [];
    list.push(job);
    try {
      const adFair = loadAdapter();
      if (adFair && typeof adFair.fairQueueStarvationBound === 'function') {
        const fairQ = adFair.fairQueueStarvationBound(list, {
          now: Date.now(),
          inFlight: list.find((j) => j && j.running),
        });
        if (fairQ && Array.isArray(fairQ.waiters)) {
          list.length = 0;
          for (const w of fairQ.waiters) list.push(w);
        }
      }
    } catch (_) {}
    jobRecords.set(key, list);

    const prev = lanes.get(key) || Promise.resolve();
    const runFn = () => {
      assertJobRunnable(key, job);
      job.running = true;
      const corr = loadCorrectness();
      if (corr && typeof corr.getSharedCancelGate === 'function') {
        try { corr.getSharedCancelGate().cancel(key); } catch (_) {}
      }
      if (sessionGate && typeof sessionGate.run === 'function') {
        return sessionGate.run(key, () => fn());
      }
      return fn();
    };
    const next = prev.then(runFn, runFn);
    const tracked = next.finally(() => {
      try {
        const ad = loadAdapter();
        if (ad && typeof ad.releaseFairGenerateLock === 'function') {
          ad.releaseFairGenerateLock(key, String((opts && opts.runId) || idem || job.id || ''));
        }
      } catch (_) {}
      job.running = false;
      const left = (pending.get(key) || 1) - 1;
      if (left <= 0) pending.delete(key);
      else pending.set(key, left);
      if (idem) inFlightIdem.delete(idem);
      const remain = (jobRecords.get(key) || []).filter((j) => j !== job);
      if (remain.length) jobRecords.set(key, remain);
      else jobRecords.delete(key);
    });
    lanes.set(key, tracked.then(() => undefined, () => undefined));
    return tracked;
  }

  function claimWriter(sessionKey, runId) {
    const key = String(sessionKey || '');
    const prev = writers.get(key);
    if (prev && prev !== String(runId)) {
      const flag = abortFlags.get(key);
      if (flag) flag.aborted = true;
    }
    try {
      const life = loadLifecycle();
      if (life && typeof life.claimSingleGateway === 'function') {
        const claim = life.claimSingleGateway(key, String(runId), { steal: true });
        if (!claim.ok) {
          const err = new Error('gateway_busy');
          err.code = 'gateway_busy';
          throw err;
        }
      }
    } catch (e) {
      if (e && e.code === 'gateway_busy') throw e;
    }
    writers.set(key, String(runId));
    abortFlags.set(key, { aborted: false });
    sessionAborted.delete(key);
    return writers.get(key);
  }

  function isAborted(sessionKey, runId) {
    const key = String(sessionKey || '');
    if (sessionAborted.get(key)) return true;
    if (writers.get(key) !== String(runId)) return true;
    const flag = abortFlags.get(key);
    return Boolean(flag && flag.aborted);
  }

  function cancelQueued(sessionKey, jobId) {
    const key = String(sessionKey || '');
    if (!key) return { ok: false, cancelled: false, code: 'queue_cancel' };
    if (!jobId) cancelledJobs.set(key, true);
    const runtime = loadRuntime();
    const list = jobRecords.get(key) || [];
    let n = 0;
    if (runtime && typeof runtime.cancelPendingJobs === 'function') {
      const out = runtime.cancelPendingJobs(list, { sessionKey: key, jobId: jobId || null, all: !jobId });
      n = out.cancelled || 0;
      jobRecords.set(key, out.remaining || []);
    } else {
      for (const j of list) {
        if (!j.running && (!jobId || String(j.id) === String(jobId))) {
          j.cancelled = true;
          n += 1;
        }
      }
    }
    return { ok: true, cancelled: true, count: n, code: 'queue_cancel', sessionKey: key };
  }

  function pickFair(sessionKeys) {
    try {
      const runtime = loadRuntime();
      if (runtime && typeof runtime.pickFairReady === 'function') {
        const out = runtime.pickFairReady(sessionKeys, lastFair);
        if (out.ok) lastFair = out.session;
        return out;
      }
      const parity = require('../agent-runner/engine-parity');
      const out = parity.pickFairSession(sessionKeys, lastFair);
      if (out.ok) lastFair = out.session;
      return out;
    } catch (_) {
      return { ok: false, session: null, code: 'fairness_empty' };
    }
  }

  function abortSession(sessionKey, reason) {
    const key = String(sessionKey || '');
    if (!key) return { aborted: false, error: 'sessionKey_required' };
    sessionAborted.set(key, true);
    const flag = abortFlags.get(key);
    if (flag) flag.aborted = true;
    else abortFlags.set(key, { aborted: true });
    const runId = writers.get(key) || null;
    try {
      const ad = loadAdapter();
      if (ad && typeof ad.markRunCancelled === 'function' && runId) ad.markRunCancelled(String(runId));
    } catch (_) {}
    return {
      aborted: true,
      sessionKey: key,
      runId,
      reason: String(reason || 'user_abort'),
    };
  }

  function isSessionAborted(sessionKey) {
    return Boolean(sessionAborted.get(String(sessionKey || '')));
  }

  function canCommit(sessionKey, runId) {
    const key = String(sessionKey || '');
    if (sessionAborted.get(key)) return false;
    return writers.get(key) === String(runId);
  }

  function activeWriterRunId(sessionKey) {
    return writers.get(String(sessionKey || '')) || null;
  }

  function releaseWriter(sessionKey, runId) {
    const key = String(sessionKey || '');
    if (writers.get(key) === String(runId)) writers.delete(key);
  }

  function snapshot() {
    // Honest counts only — never leak sessionKey (PII-adjacent).
    let pendingTurns = 0;
    for (const n of pending.values()) pendingTurns += n;
    return {
      lanes: lanes.size,
      writers: writers.size,
      aborted: sessionAborted.size,
      pending: pendingTurns,
      maxPending: MAX_PENDING,
      order: 'fifo',
      fairness: 'rr',
      queueCancel: true,
      queueLease: true,
      queueCancelAll: true,
      queueJobLease: true,
      enqueueSeq,
      lastEnqueueAt: enqueueAt.size ? Math.max(...enqueueAt.values()) : 0,
    };
  }

  return {
    enqueue,
    patchGenerateResume(sessionKey, resumeToken, opts) {
      const ad = loadAdapter();
      if (ad && typeof ad.patchGenerateResumeToken === 'function') {
        return ad.patchGenerateResumeToken(sessionKey, resumeToken, opts || {});
      }
      return { ok: false, code: 'resume_conflict' };
    },
    claimWriter,
    canCommit,
    isAborted,
    abortSession,
    cancelQueued,
    pickFair,
    isSessionAborted,
    activeWriterRunId,
    releaseWriter,
    snapshot,
    size: () => lanes.size,
    nackGap(frames, lastId, requestedId) {
      const corr = loadCorrectness();
      if (corr && typeof corr.nackGap === 'function') return corr.nackGap(frames, lastId, requestedId);
      return { ok: true, missing: [] };
    },
    bufferFrame(sequencer, frame) {
      const corr = loadCorrectness();
      const seq = sequencer || (corr && corr.createFrameSequencer && corr.createFrameSequencer(0));
      if (seq && typeof seq.push === 'function') return seq.push(frame);
      return { flushed: [frame], buffered: 0 };
    },
  };
}

module.exports = { createSessionQueue };
