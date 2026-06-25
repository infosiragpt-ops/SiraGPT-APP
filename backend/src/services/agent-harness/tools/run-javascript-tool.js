'use strict';

/**
 * run_javascript — in-process WASM JavaScript sandbox (quickjs-emscripten).
 *
 * Why QuickJS-in-WASM instead of `node` subprocesses (agents/code-sandbox.js)
 * or E2B (sandbox/e2b-sandbox.js): chat-driven code is UNTRUSTED input on the
 * hot path. The WASM guest has NO require, NO filesystem, NO network, NO
 * process — the host only injects a console shim — so the blast radius is a
 * memory-capped, interrupt-bounded interpreter inside our own process:
 *
 *   - wall-clock interrupt: shouldInterruptAfterDeadline (default 5 s cap),
 *   - memory limit: 64 MB guest heap, 1 MB stack,
 *   - output caps: console log stream and result JSON are both bounded,
 *   - async supported: top-level promises are pumped via executePendingJobs
 *     under the same deadline (no timers exist in the guest, so anything
 *     that cannot settle from pending jobs is reported as unresolved).
 *
 * Every handle is disposed and the runtime torn down per call — nothing
 * leaks across executions.
 */

const { z } = require('zod');

const HARD_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;
const MAX_LOG_CHARS = 20_000;
const MAX_RESULT_CHARS = 10_000;
const MAX_CODE_CHARS = 100_000;

const inputSchema = z.object({
  code: z.string().min(1).max(MAX_CODE_CHARS)
    .describe('JavaScript (ES2023) to run. The value of the last expression is returned. console.log output is captured. No require/import, no fs, no network, no timers.'),
  timeoutMs: z.number().int().min(100).max(HARD_TIMEOUT_MS).optional()
    .describe('Wall-clock limit in ms (default and hard cap: 5000)'),
}).strict();

let quickJSPromise = null;
function getQuickJSOnce() {
  if (!quickJSPromise) {
    quickJSPromise = require('quickjs-emscripten').getQuickJS();
  }
  return quickJSPromise;
}

function dumpHandle(vm, handle) {
  try { return vm.dump(handle); } catch (_) { return '[undumpable]'; }
}

function stringifyForLog(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function capString(str, max) {
  const s = String(str ?? '');
  if (s.length <= max) return { value: s, truncated: false };
  return { value: `${s.slice(0, max)}…[truncated ${max} of ${s.length} chars]`, truncated: true };
}

/**
 * Execute untrusted JavaScript inside the QuickJS WASM sandbox.
 * Resolves with { ok, result?, error?, logs, durationMs, timedOut? } and
 * never rejects — errors are data for the model to read.
 */
async function executeRunJavascript(args) {
  const timeoutMs = Math.min(HARD_TIMEOUT_MS, Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  const logs = [];
  let logChars = 0;
  let logsTruncated = false;

  const pushLog = (level, parts) => {
    if (logChars >= MAX_LOG_CHARS) { logsTruncated = true; return; }
    const line = `${level === 'log' ? '' : `[${level}] `}${parts.join(' ')}`;
    logChars += line.length;
    if (logChars > MAX_LOG_CHARS) {
      logs.push(line.slice(0, Math.max(0, line.length - (logChars - MAX_LOG_CHARS))));
      logsTruncated = true;
    } else {
      logs.push(line);
    }
  };

  let QuickJS;
  try {
    QuickJS = await getQuickJSOnce();
  } catch (err) {
    return { ok: false, error: `sandbox_unavailable: ${err && err.message}`, logs: [], durationMs: 0 };
  }
  const { shouldInterruptAfterDeadline } = require('quickjs-emscripten');

  const runtime = QuickJS.newRuntime();
  let vm = null;
  try {
    runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
    runtime.setMaxStackSize(STACK_LIMIT_BYTES);
    const deadline = Date.now() + timeoutMs;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    vm = runtime.newContext();

    // console shim — the ONLY host capability exposed to the guest.
    const consoleHandle = vm.newObject();
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const fn = vm.newFunction(level, (...handles) => {
        pushLog(level, handles.map((h) => stringifyForLog(dumpHandle(vm, h))));
      });
      vm.setProp(consoleHandle, level, fn);
      fn.dispose();
    }
    vm.setProp(vm.global, 'console', consoleHandle);
    consoleHandle.dispose();

    const evalResult = vm.evalCode(args.code, 'agent.js');
    if (evalResult.error) {
      const errValue = dumpHandle(vm, evalResult.error);
      evalResult.error.dispose();
      const timedOut = Date.now() >= deadline;
      const message = errValue && typeof errValue === 'object'
        ? `${errValue.name || 'Error'}: ${errValue.message || stringifyForLog(errValue)}`
        : stringifyForLog(errValue);
      return {
        ok: false,
        error: timedOut ? `timeout: execution exceeded ${timeoutMs}ms (${message})` : message,
        ...(timedOut ? { timedOut: true } : {}),
        logs,
        logsTruncated,
        durationMs: Date.now() - startedAt,
      };
    }

    let valueHandle = evalResult.value;

    // Top-level promise? Pump pending jobs under the same deadline.
    const isPromise = (() => {
      try { return vm.typeof(valueHandle) === 'object' && dumpHandle(vm, vm.getProp(valueHandle, 'then')) !== undefined && typeof vm.resolvePromise === 'function'; }
      catch (_) { return false; }
    })();

    let resultValue;
    if (isPromise && typeof vm.resolvePromise === 'function') {
      const nativePromise = vm.resolvePromise(valueHandle);
      valueHandle.dispose();
      // Drain microtask jobs; the interrupt handler bounds runaway loops.
      while (runtime.hasPendingJob && runtime.hasPendingJob()) {
        const jobs = runtime.executePendingJobs(50);
        if (jobs && jobs.error) { jobs.error.dispose(); break; }
        if (Date.now() >= deadline) break;
      }
      // Hoist the race timer so it's cleared when the sandbox promise wins (the
      // normal case) — otherwise a dangling setTimeout self-fires up to ~5s after
      // run_javascript already returned, accumulating on the hot path.
      let raceTimer;
      const timeoutP = new Promise((resolve) => {
        raceTimer = setTimeout(() => resolve({ __sandboxTimeout: true }), Math.max(10, deadline - Date.now()) + 50);
        raceTimer.unref?.();
      });
      const settled = await Promise.race([nativePromise, timeoutP]);
      clearTimeout(raceTimer);
      if (settled && settled.__sandboxTimeout) {
        return {
          ok: false,
          error: `timeout: promise did not settle within ${timeoutMs}ms (no timers exist in the sandbox — avoid code that waits)`,
          timedOut: true,
          logs,
          logsTruncated,
          durationMs: Date.now() - startedAt,
        };
      }
      if (settled.error) {
        const errValue = dumpHandle(vm, settled.error);
        settled.error.dispose();
        return {
          ok: false,
          error: typeof errValue === 'object' ? `${errValue.name || 'Error'}: ${errValue.message || ''}` : stringifyForLog(errValue),
          logs,
          logsTruncated,
          durationMs: Date.now() - startedAt,
        };
      }
      resultValue = dumpHandle(vm, settled.value);
      settled.value.dispose();
    } else {
      resultValue = dumpHandle(vm, valueHandle);
      valueHandle.dispose();
    }

    const capped = capString(stringifyForLog(resultValue), MAX_RESULT_CHARS);
    return {
      ok: true,
      result: capped.value,
      ...(capped.truncated ? { resultTruncated: true } : {}),
      logs,
      ...(logsTruncated ? { logsTruncated: true } : {}),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const timedOut = /interrupt/i.test(String(err && err.message));
    return {
      ok: false,
      error: timedOut
        ? `timeout: execution exceeded ${timeoutMs}ms`
        : `sandbox_error: ${err && err.message ? err.message : String(err)}`,
      ...(timedOut ? { timedOut: true } : {}),
      logs,
      logsTruncated,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    try { if (vm) vm.dispose(); } catch (_) { /* already disposed */ }
    try { runtime.dispose(); } catch (_) { /* already disposed */ }
  }
}

function buildRunJavascriptTool() {
  return {
    name: 'run_javascript',
    description: [
      'Run JavaScript in an isolated WASM sandbox and return the value of the last expression plus captured console output.',
      'WHEN TO USE: deterministic computation — math, date arithmetic, parsing/transforming JSON or text the user provided, verifying a formula, generating structured data.',
      'WHEN NOT TO USE: anything needing network, files, npm packages, timers, or long-running work — none of those exist here (5s / 64MB hard limits). For Python or package-based execution use python_exec.',
      'The sandbox has NO fetch, NO require, NO fs and NO setTimeout. Pure computation only.',
    ].join(' '),
    inputSchema,
    permissionTier: 'auto',
    humanDescription: () => 'Ejecutando JavaScript en sandbox',
    execute: async (args) => executeRunJavascript(args),
  };
}

module.exports = {
  buildRunJavascriptTool,
  executeRunJavascript,
  HARD_TIMEOUT_MS,
  MEMORY_LIMIT_BYTES,
};
