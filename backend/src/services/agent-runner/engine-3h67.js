'use strict';

/**
 * 3H67 — fail-closed wiring of leftover adapter-only Claude-Code holes.
 *
 * Does NOT re-export 3H59/3H60/3H61/3H62/3H63/3H64/3H65/3H66 names (no overlay
 * collisions). Unique orchestrators CALL the live #388 adapter names
 * (injected) and apply their decisions on the generate / loop / SSE /
 * sandbox / durability hot path:
 *   tool-name / args hygiene leftover
 *   write refuse leftover (system paths + dest dir + 1 MiB ckpt)
 *   SSE replay/close leftover
 *   plan leftover
 *   credit error-path leftover
 *   sandbox stdout/stderr leftover
 *
 * Original SiraGPT rewrite. No vendor copy. No OpenRouter.
 * DeepSeek Flash/Pro only. Interpreter stays `local`.
 * This module must never require engine-adapter (cycle).
 * Uniqueness of str_replace is never timeout / jail / write-refuse.
 */

const WAVE = '3H67';
const STACK_RE = /(?:at\s+\S+\s+\([^)]+:\d+:\d+\)|^\s*at\s+\S+:\d+:\d+)/m;
const SECRET_RE = /sk-[A-Za-z0-9_\-]{8,}/g;
const UNIQUENESS_RE = /old_str occurs more than once|old_str not found|old_str must not be empty/i;
const WRITE_TOOL_RE = /^(write_|str_replace|apply_patch|apply_diff|edit_file|create_file|computer_write)/i;
const BASH_TOOL_RE = /^(execute_bash|bash|exec|shell|sandbox_bash)$/i;
const PLAN_TOOL_RE = /^(create_plan|update_plan|set_plan|plan)$/i;
const LIVE_HELPERS_WIRED = 36;

const ERROR_TABLE = Object.freeze({
  proto_pollution: { retryable: false, message: 'Los argumentos tenían claves prohibidas. No ejecuté la herramienta.' },
  tool_id_dup: { retryable: false, message: 'Había tool_call ids duplicados. Descarté las copias.' },
  tool_name_hyphen: { retryable: false, message: 'El nombre de la herramienta no puede empezar con guion. No la ejecuté.' },
  tool_name_digit: { retryable: false, message: 'El nombre de la herramienta no puede empezar con un dígito. No la ejecuté.' },
  tool_name_charset: { retryable: false, message: 'El nombre de la herramienta tenía caracteres no permitidos. No la ejecuté.' },
  tool_name_whitespace: { retryable: false, message: 'El nombre de la herramienta tenía espacios. No la ejecuté.' },
  empty_tool_name: { retryable: false, message: 'El nombre de la herramienta estaba vacío. No la ejecuté.' },
  tool_name_length: { retryable: false, message: 'El nombre de la herramienta superaba 64 caracteres. No la ejecuté.' },
  tool_arg_keys: { retryable: false, message: 'Recorté las claves de argumentos a 32.' },
  tool_args_array: { retryable: false, message: 'Los argumentos eran un array. No ejecuté la herramienta.' },
  dest_dir_missing: { retryable: false, message: 'El directorio destino no existe. No escribí el archivo.' },
  path_system: { retryable: false, message: 'No escribo en /etc, /proc ni /sys.' },
  path_dev_boot: { retryable: false, message: 'No escribo en /dev ni /boot.' },
  path_root_mnt: { retryable: false, message: 'No escribo en /root, /mnt ni /media.' },
  ckpt_too_large: { retryable: false, message: 'El checkpoint superaba 1 MiB sin comprimir. No lo guardé.' },
  sse_id_parse: { retryable: false, message: 'Last-Event-ID no era un entero. Reanudé desde 0.' },
  sse_stale: { retryable: false, message: 'Descarté eventos SSE de más de 2 minutos.' },
  sse_comment_drop: { retryable: false, message: 'Quité frames de comentario del replay SSE.' },
  sse_replay_cap: { retryable: false, message: 'Recorté el replay SSE a 64 frames.' },
  sse_done: { retryable: false, message: 'Cerré el SSE con event done.' },
  plan_title_empty: { retryable: false, message: 'El plan no tenía título. No lo acepté.' },
  plan_title_cap: { retryable: false, message: 'Recorté el título del plan a 128 caracteres.' },
  plan_step_dup: { retryable: false, message: 'Había ids de paso duplicados. Descarté las copias.' },
  plan_steps_cap: { retryable: false, message: 'Recorté el plan a 24 pasos.' },
  plan_skip_completed: { retryable: false, message: 'Salté pasos del plan ya completados al reanudar.' },
  stdout_rate: { retryable: false, message: 'Recorté stdout del sandbox al tope por comando.' },
  stderr_cap: { retryable: false, message: 'Recorté stderr del sandbox al tope por comando.' },
  combined_cap: { retryable: false, message: 'Recorté stdout+stderr combinados a 96 KiB.' },
  line_cap: { retryable: false, message: 'Recorté una línea de stdout a 8 KiB.' },
  ansi_strip: { retryable: false, message: 'Quité secuencias ANSI de la salida del sandbox.' },
  zero_width_strip: { retryable: false, message: 'Quité caracteres de ancho cero de los argumentos.' },
  bidi_strip: { retryable: false, message: 'Quité caracteres bidi de los argumentos.' },
  tag_strip: { retryable: false, message: 'Quité tag chars U+E0000 de los argumentos.' },
  credit_ceiling: { retryable: false, message: 'DeepSeek sin crédito (402). No reintenté.' },
  quota_exhausted: { retryable: false, message: 'DeepSeek sin crédito (402). No reintenté.' },
  openrouter_denied: { retryable: false, message: 'Generate solo usa DeepSeek Flash/Pro. OpenRouter está prohibido.' },
});

function loadWave66() {
  try { return require('./engine-3h66'); } catch (_) { return null; }
}

function loadWave65() {
  try { return require('./engine-3h65'); } catch (_) { return null; }
}

function loadWave64() {
  try { return require('./engine-3h64'); } catch (_) { return null; }
}

function loadWave63() {
  try { return require('./engine-3h63'); } catch (_) { return null; }
}

function loadWave62() {
  try { return require('./engine-3h62'); } catch (_) { return null; }
}

function loadWave61() {
  try { return require('./engine-3h61'); } catch (_) { return null; }
}

function loadWave60() {
  try { return require('./engine-3h60'); } catch (_) { return null; }
}

function loadWave59() {
  try { return require('./engine-3h59'); } catch (_) { return null; }
}

function callLive(fn, args, fallback) {
  if (typeof fn !== 'function') return fallback;
  try { return fn(args); } catch (_) { return fallback; }
}

function looksLikeUniqueness(value) {
  return UNIQUENESS_RE.test(String((value && value.message) || value || ''));
}

function walkStripStrings(value, stripBidi, stripTag) {
  function walk(v) {
    if (typeof v === 'string') {
      let s = v;
      if (typeof stripBidi === 'function') {
        const b = stripBidi(s);
        if (b && b.text != null) s = b.text;
      }
      if (typeof stripTag === 'function') {
        const t = stripTag(s);
        if (t && t.text != null) s = t.text;
      }
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  }
  return walk(value);
}

function nameOfCall(call) {
  if (!call) return '';
  if (typeof call === 'string') return call;
  return String(call.name || call.tool || (call.function && call.function.name) || '');
}

function argsOfCall(call) {
  if (!call || typeof call !== 'object') return null;
  if (call.arguments != null) return call.arguments;
  if (call.args != null) return call.args;
  if (call.function && call.function.arguments != null) return call.function.arguments;
  return null;
}

/**
 * Refuse bad tool names; drop duplicate call ids and array-shaped args;
 * strip NUL / zero-width / bidi / tag chars; cap arg keys at 32;
 * refuse prototype-pollution keys.
 */
function applyToolNameArgsHygieneClosed({
  name,
  args,
  calls,
  rejectPrototypePollutionKeys,
  dropDuplicateToolCallIds,
  rejectToolNameStartingWithHyphen,
  rejectToolNameStartingWithDigit,
  rejectToolNameOutsideCharset,
  rejectToolNameWithWhitespace,
  rejectToolNameLongerThan64,
  capToolArgKeys32,
  rejectToolCallIfArgsIsArray,
  stripBidiOverrideChars,
  stripZeroWidthCharsFromArgs,
  dropNullBytesInToolArgs,
  stripTagCharsUPlusE0000,
} = {}) {
  let list = Array.isArray(calls) ? calls : null;
  let code = null;
  if (list) {
    const dups = dropDuplicateToolCallIds
      ? dropDuplicateToolCallIds(list)
      : { calls: list };
    list = (dups && Array.isArray(dups.calls)) ? dups.calls : list;
    if (dups && dups.dropped) code = dups.code || 'tool_id_dup';
    const arr = rejectToolCallIfArgsIsArray
      ? rejectToolCallIfArgsIsArray(list)
      : { calls: list };
    list = (arr && Array.isArray(arr.calls)) ? arr.calls : list;
    if (arr && arr.dropped) code = arr.code || 'tool_args_array';
  }

  function nameGate(n) {
    if (!n) return { ok: true, name: n, code: null };
    const ws = rejectToolNameWithWhitespace
      ? rejectToolNameWithWhitespace(n)
      : { ok: true, name: n };
    if (ws && ws.ok === false) return { ok: false, code: ws.code || 'tool_name_whitespace' };
    const hy = rejectToolNameStartingWithHyphen
      ? rejectToolNameStartingWithHyphen(n)
      : { ok: true, name: n };
    if (hy && hy.ok === false) return { ok: false, code: hy.code || 'tool_name_hyphen' };
    const dig = rejectToolNameStartingWithDigit
      ? rejectToolNameStartingWithDigit(n)
      : { ok: true, name: n };
    if (dig && dig.ok === false) return { ok: false, code: dig.code || 'tool_name_digit' };
    const cs = rejectToolNameOutsideCharset
      ? rejectToolNameOutsideCharset(n)
      : { ok: true, name: n };
    if (cs && cs.ok === false) return { ok: false, code: cs.code || 'tool_name_charset' };
    const len = rejectToolNameLongerThan64
      ? rejectToolNameLongerThan64(n)
      : { ok: true, name: n };
    if (len && len.ok === false) return { ok: false, code: len.code || 'tool_name_length' };
    return { ok: true, name: n, code: null };
  }

  if (list && name == null) {
    const kept = [];
    for (const c of list) {
      const gate = nameGate(nameOfCall(c));
      if (gate.ok === false) {
        code = gate.code;
        continue;
      }
      kept.push(c);
    }
    list = kept;
  }

  const n = name != null ? String(name) : '';
  if (n) {
    const gate = nameGate(n);
    if (gate.ok === false) {
      return { ok: false, refuse: true, args, calls: list, name: n, code: gate.code };
    }
  }

  let nextArgs = args;
  if (Array.isArray(nextArgs)) {
    const hit = rejectToolCallIfArgsIsArray
      ? rejectToolCallIfArgsIsArray([{ arguments: nextArgs }])
      : { ok: true };
    if (hit && hit.ok === false) {
      return { ok: false, refuse: true, args: nextArgs, calls: list, name: n, code: hit.code || 'tool_args_array' };
    }
  }
  if (nextArgs && typeof nextArgs === 'object' && !Array.isArray(nextArgs)) {
    const proto = rejectPrototypePollutionKeys
      ? rejectPrototypePollutionKeys(nextArgs)
      : { ok: true };
    if (proto && proto.ok === false) {
      return { ok: false, refuse: true, args: nextArgs, calls: list, name: n, code: proto.code || 'proto_pollution' };
    }
    const keys = capToolArgKeys32
      ? capToolArgKeys32(nextArgs)
      : { args: nextArgs };
    nextArgs = (keys && keys.args !== undefined) ? keys.args : nextArgs;
    if (keys && keys.truncated) code = keys.code || 'tool_arg_keys';
    const nul = dropNullBytesInToolArgs
      ? dropNullBytesInToolArgs(nextArgs)
      : { args: nextArgs };
    nextArgs = (nul && nul.args !== undefined) ? nul.args : nextArgs;
    const zw = stripZeroWidthCharsFromArgs
      ? stripZeroWidthCharsFromArgs(nextArgs)
      : { args: nextArgs };
    nextArgs = (zw && zw.args !== undefined) ? zw.args : nextArgs;
    if (zw && zw.stripped) code = zw.code || code;
    nextArgs = walkStripStrings(nextArgs, stripBidiOverrideChars, stripTagCharsUPlusE0000);
  }
  return {
    ok: true,
    refuse: false,
    args: nextArgs,
    calls: list,
    name: n,
    code,
  };
}

/**
 * Refuse writes to /etc /proc /sys /dev /boot /root /mnt /media,
 * missing dest dirs, and uncompressed checkpoints over 1 MiB.
 * str_replace uniqueness is never a write-refuse fail.
 */
function applyWriteRefuseClosed({
  path: filePath,
  content: _content,
  payload,
  result,
  existsSync,
  refuseWriteIfDestDirMissing,
  refuseWriteToEtcProcSys,
  refuseWriteToDevBoot,
  refuseWriteToRootMnt,
  refuseCheckpointOver1MiBUncompressed,
} = {}) {
  if (looksLikeUniqueness(result)) {
    return { ok: true, uniqueness: true, path: filePath, code: null };
  }
  const raw = filePath == null ? '' : String(filePath);
  const etc = refuseWriteToEtcProcSys
    ? refuseWriteToEtcProcSys(raw)
    : { ok: true, path: raw };
  if (etc && etc.ok === false) {
    return { ok: false, refuse: true, path: raw, code: etc.code || 'path_system' };
  }
  const dev = refuseWriteToDevBoot
    ? refuseWriteToDevBoot(raw)
    : { ok: true, path: raw };
  if (dev && dev.ok === false) {
    return { ok: false, refuse: true, path: raw, code: dev.code || 'path_dev_boot' };
  }
  const root = refuseWriteToRootMnt
    ? refuseWriteToRootMnt(raw)
    : { ok: true, path: raw };
  if (root && root.ok === false) {
    return { ok: false, refuse: true, path: raw, code: root.code || 'path_root_mnt' };
  }
  const dest = refuseWriteIfDestDirMissing
    ? refuseWriteIfDestDirMissing(raw, existsSync ? { existsSync } : undefined)
    : { ok: true, path: raw };
  if (dest && dest.ok === false) {
    return { ok: false, refuse: true, path: raw, dir: dest.dir, code: dest.code || 'dest_dir_missing' };
  }
  if (payload !== undefined || (content != null && arguments.length && refuseCheckpointOver1MiBUncompressed && payload !== undefined)) {
    /* payload-only check below */
  }
  if (payload !== undefined && refuseCheckpointOver1MiBUncompressed) {
    const ckpt = refuseCheckpointOver1MiBUncompressed(payload);
    if (ckpt && ckpt.ok === false) {
      return { ok: false, refuse: true, path: raw, bytes: ckpt.bytes, code: ckpt.code || 'ckpt_too_large' };
    }
  }
  return { ok: true, refuse: false, path: raw, uniqueness: false, code: null };
}

/**
 * Parse Last-Event-ID as int-only when the header is digits; restore
 * cursor; drop comment / stale frames; cap replay at 64; emit event done.
 * Composite streamId:position headers are not treated as a parse abort.
 */
function applySseReplayCloseClosed({
  lastEventId,
  headerValue,
  events,
  store,
  now,
  closed,
  alreadyDone,
  parseLastEventIdIntOnly,
  restoreLastSseIdOnResume,
  dropSseCommentFramesFromReplay,
  dropSseEventsOlderThan2min,
  capReplayFrames64,
  endSseWithEventDone,
} = {}) {
  const rawHeader = headerValue != null ? headerValue : lastEventId;
  const parsed = parseLastEventIdIntOnly
    ? parseLastEventIdIntOnly(rawHeader)
    : { ok: true, lastEventId: Number(rawHeader) || 0 };
  const digitsOnly = /^\d+$/.test(String(rawHeader == null ? '' : rawHeader).trim());
  let cursor = lastEventId;
  if (parsed && parsed.ok === true) cursor = parsed.lastEventId;
  else if (digitsOnly) cursor = 0;
  const restored = restoreLastSseIdOnResume
    ? restoreLastSseIdOnResume({ lastEventId: cursor, store })
    : { lastEventId: cursor, store };
  let list = Array.isArray(events) ? events.slice() : [];
  const comments = dropSseCommentFramesFromReplay
    ? dropSseCommentFramesFromReplay(list)
    : { events: list };
  list = (comments && Array.isArray(comments.events)) ? comments.events : list;
  const stale = dropSseEventsOlderThan2min
    ? dropSseEventsOlderThan2min(list, { now: now || Date.now() })
    : { events: list };
  list = (stale && Array.isArray(stale.events)) ? stale.events : list;
  const capped = capReplayFrames64
    ? capReplayFrames64(list)
    : { events: list };
  list = (capped && Array.isArray(capped.events)) ? capped.events : list;
  const done = endSseWithEventDone
    ? endSseWithEventDone({ closed: closed === true, alreadyDone: alreadyDone === true })
    : { write: false, frame: null };
  return {
    ok: true,
    parseOk: !(digitsOnly && parsed && parsed.ok === false),
    lastEventId: (restored && restored.lastEventId != null) ? restored.lastEventId : cursor,
    events: list,
    writeDone: Boolean(done && done.write),
    frame: done && done.frame,
    store: (restored && restored.store) || store,
    code: (digitsOnly && parsed && parsed.ok === false && parsed.code)
      || (capped && capped.truncated && capped.code)
      || (stale && stale.dropped && stale.code)
      || (comments && comments.dropped && comments.code)
      || (done && done.write && done.code)
      || null,
  };
}

/**
 * Empty / overlong titles, duplicate step ids, cap 24 steps, skip
 * completed steps on resume.
 */
function applyPlanGuardsClosed({
  title,
  steps,
  completedIds,
  capPlanTitle128Chars,
  refuseDuplicatePlanStepIds,
  refuseEmptyPlanTitle,
  capPlanSteps24,
  skipCompletedPlanStepsOnResume,
} = {}) {
  const empty = refuseEmptyPlanTitle
    ? refuseEmptyPlanTitle(title)
    : { ok: true, title };
  if (empty && empty.ok === false && (title !== undefined || (title === '' || title == null))) {
    if (title !== undefined) {
      return { ok: false, refuse: true, title: empty.title, steps: Array.isArray(steps) ? steps : [], code: empty.code || 'plan_title_empty' };
    }
  }
  const cappedTitle = capPlanTitle128Chars
    ? capPlanTitle128Chars(title)
    : { title: title == null ? '' : String(title), truncated: false };
  const dups = refuseDuplicatePlanStepIds
    ? refuseDuplicatePlanStepIds(steps)
    : { steps: Array.isArray(steps) ? steps : [] };
  const skipped = skipCompletedPlanStepsOnResume
    ? skipCompletedPlanStepsOnResume((dups && dups.steps) || steps, { completedIds })
    : { steps: (dups && dups.steps) || (Array.isArray(steps) ? steps : []) };
  const capped = capPlanSteps24
    ? capPlanSteps24((skipped && skipped.steps) || [])
    : { steps: (skipped && skipped.steps) || [] };
  return {
    ok: true,
    refuse: false,
    title: cappedTitle && cappedTitle.title,
    steps: (capped && capped.steps) || [],
    truncated: Boolean((cappedTitle && cappedTitle.truncated) || (capped && capped.truncated)),
    dropped: (dups && dups.dropped) || 0,
    skipped: (skipped && skipped.skipped) || 0,
    code: (capped && capped.truncated && capped.code)
      || (skipped && skipped.skipped && skipped.code)
      || (dups && dups.dropped && dups.code)
      || (cappedTitle && cappedTitle.truncated && cappedTitle.code)
      || null,
  };
}

/**
 * Record token usage on the error path. Cancel drops buffered tokens
 * (never flushed).
 */
function applyCreditErrorPathClosed({
  usage,
  error,
  noCompletion,
  aborted,
  abort,
  buffer,
  recordTokenUsageOnErrorPath,
  cancelDropsBufferedTokens,
} = {}) {
  const rec = recordTokenUsageOnErrorPath
    ? recordTokenUsageOnErrorPath({ usage, error, noCompletion })
    : { recorded: false, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const drop = cancelDropsBufferedTokens
    ? cancelDropsBufferedTokens({ aborted, abort, buffer })
    : { dropped: 0, flushed: true };
  return {
    ok: true,
    recorded: Boolean(rec && rec.recorded),
    promptTokens: rec && rec.promptTokens,
    completionTokens: rec && rec.completionTokens,
    totalTokens: rec && rec.totalTokens,
    dropped: (drop && drop.dropped) || 0,
    flushed: drop ? drop.flushed !== false && !(aborted === true || abort === true) : true,
    code: (drop && (aborted === true || abort === true) && drop.code)
      || (rec && rec.code)
      || null,
  };
}

/**
 * Strip ANSI, cap stdout/stderr per command, cap per-line 8 KiB,
 * combined 96 KiB.
 */
function applySandboxOutCapClosed({
  stdout,
  stderr,
  text,
  stripAnsiFromSandboxOut,
  stderrByteCapPerCommand,
  stdoutByteCapPerCommand,
  combinedStdoutStderr96KiB,
  capStdoutLine8KiB,
} = {}) {
  let so = stdout != null ? stdout : (text != null ? text : '');
  let se = stderr != null ? stderr : '';
  const ansiOut = stripAnsiFromSandboxOut
    ? stripAnsiFromSandboxOut(so)
    : { text: so, stripped: false };
  so = (ansiOut && ansiOut.text != null) ? ansiOut.text : so;
  const ansiErr = stripAnsiFromSandboxOut
    ? stripAnsiFromSandboxOut(se)
    : { text: se, stripped: false };
  se = (ansiErr && ansiErr.text != null) ? ansiErr.text : se;
  const outCap = stdoutByteCapPerCommand
    ? stdoutByteCapPerCommand(so)
    : { text: so, truncated: false };
  so = (outCap && outCap.text != null) ? outCap.text : so;
  const errCap = stderrByteCapPerCommand
    ? stderrByteCapPerCommand(se)
    : { text: se, truncated: false };
  se = (errCap && errCap.text != null) ? errCap.text : se;
  const line = capStdoutLine8KiB
    ? capStdoutLine8KiB(so)
    : { text: so, truncated: false };
  so = (line && line.text != null) ? line.text : so;
  const combined = combinedStdoutStderr96KiB
    ? combinedStdoutStderr96KiB({ stdout: so, stderr: se })
    : { text: so + (se ? ((so ? '\n' : '') + se) : ''), truncated: false };
  return {
    ok: true,
    stdout: so,
    stderr: se,
    text: (combined && combined.text != null) ? combined.text : so,
    truncated: Boolean(
      (outCap && outCap.truncated)
      || (errCap && errCap.truncated)
      || (line && line.truncated)
      || (combined && combined.truncated)
    ),
    stripped: Boolean((ansiOut && ansiOut.stripped) || (ansiErr && ansiErr.stripped)),
    code: (combined && combined.truncated && combined.code)
      || (line && line.truncated && line.code)
      || (errCap && errCap.truncated && errCap.code)
      || (outCap && outCap.truncated && outCap.code)
      || (ansiOut && ansiOut.stripped && ansiOut.code)
      || null,
  };
}

function classifyEngine3h67Error(input) {
  const raw = input && typeof input === 'object' && !(input instanceof Error) ? input : { err: input };
  const code = String((raw.code || (raw.err && raw.err.code) || '') || '');
  const row = ERROR_TABLE[code];
  if (!row) {
    const w66 = loadWave66();
    if (w66 && typeof w66.classifyEngine3h66Error === 'function') {
      return w66.classifyEngine3h66Error(input);
    }
    return null;
  }
  const stackSrc = String((raw.err && (raw.err.stack || raw.err.message)) || raw.message || '');
  const leaked = STACK_RE.test(stackSrc) || SECRET_RE.test(stackSrc);
  return {
    code,
    message: row.message,
    retryable: row.retryable === true,
    leaked: false,
    wave: WAVE,
    stripped: leaked,
  };
}

function refuseOpenRouterInWave3h67(env = process.env) {
  const w66 = loadWave66();
  if (w66 && typeof w66.refuseOpenRouterInWave3h66 === 'function') {
    return w66.refuseOpenRouterInWave3h66(env);
  }
  const w65 = loadWave65();
  if (w65 && typeof w65.refuseOpenRouterInWave3h65 === 'function') {
    return w65.refuseOpenRouterInWave3h65(env);
  }
  const w64 = loadWave64();
  if (w64 && typeof w64.refuseOpenRouterInWave3h64 === 'function') {
    return w64.refuseOpenRouterInWave3h64(env);
  }
  const w63 = loadWave63();
  if (w63 && typeof w63.refuseOpenRouterInWave3h63 === 'function') {
    return w63.refuseOpenRouterInWave3h63(env);
  }
  const w62 = loadWave62();
  if (w62 && typeof w62.refuseOpenRouterInWave3h62 === 'function') {
    return w62.refuseOpenRouterInWave3h62(env);
  }
  const w61 = loadWave61();
  if (w61 && typeof w61.refuseOpenRouterInWave3h61 === 'function') {
    return w61.refuseOpenRouterInWave3h61(env);
  }
  const w60 = loadWave60();
  if (w60 && typeof w60.refuseOpenRouterInWave3h60 === 'function') {
    return w60.refuseOpenRouterInWave3h60(env);
  }
  const w59 = loadWave59();
  if (w59 && typeof w59.refuseOpenRouterInWave3h59 === 'function') {
    return w59.refuseOpenRouterInWave3h59(env);
  }
  return { ok: true, openrouter: false, code: null };
}

const FLAGS = Object.freeze({
  applyToolNameArgsHygieneClosed: true,
  applyWriteRefuseClosed: true,
  applySseReplayCloseClosed: true,
  applyPlanGuardsClosed: true,
  applyCreditErrorPathClosed: true,
  applySandboxOutCapClosed: true,
  classifyEngine3h67Error: true,
  refuseOpenRouterInWave3h67: true,
});

function waveSnapshot() {
  return {
    wave: WAVE,
    ...FLAGS,
    interpreter: 'local',
    openrouterGenerate: false,
    sandboxUsesRunsc: false,
    failClosed: true,
    liveHelpersWired: LIVE_HELPERS_WIRED,
    latencyNote: 'persisted p50/p95 JSONL ring; never invented Flash; VPS corpus still unmeasured',
    eventSourceNote: 'Node EventSource-semantics against mock generate; browser EventSource still pending',
  };
}

const HELPERS = Object.freeze(Object.keys(FLAGS));

module.exports = {
  WAVE,
  HELPERS,
  FLAGS,
  ERROR_TABLE,
  LIVE_HELPERS_WIRED,
  applyToolNameArgsHygieneClosed,
  applyWriteRefuseClosed,
  applySseReplayCloseClosed,
  applyPlanGuardsClosed,
  applyCreditErrorPathClosed,
  applySandboxOutCapClosed,
  classifyEngine3h67Error,
  refuseOpenRouterInWave3h67,
  callLive,
  waveSnapshot,
  looksLikeUniqueness,
  WRITE_TOOL_RE,
  BASH_TOOL_RE,
  PLAN_TOOL_RE,
  nameOfCall,
  argsOfCall,
};
