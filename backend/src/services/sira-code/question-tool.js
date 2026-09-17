'use strict';

/**
 * Structured user-ask for SiraCode (`question` / `user_ask`).
 *
 * Independent rewrite inspired by OpenCode's question contract
 * (anomalyco/opencode, MIT): an array of prompts with header, options
 * and optional multi-select; replies are arrays of labels. Not a vendor
 * copy — no Effect runtime, no TUI, no question.v2 event bus.
 *
 * Construir pauses (permission-resume) until the user answers or
 * dismisses. Planificar may ask the same way; answers never unlock
 * writes. General (internal subagent) cannot ask the user.
 */

const MAX_QUESTIONS = 6;
const MAX_OPTIONS = 8;
const MAX_HEADER = 30;
const MAX_QUESTION = 400;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 200;
const MAX_CUSTOM = 280;

const ERRORS = Object.freeze({
  empty: 'se necesita al menos una pregunta',
  tooMany: `como máximo ${MAX_QUESTIONS} preguntas`,
  blank: 'la pregunta está vacía',
  unknownOption: 'opción desconocida',
  singleOnly: 'esta pregunta no admite varias respuestas',
  invalidAnswers: 'las respuestas no coinciden con las preguntas',
});

const QUESTION_ALIASES = Object.freeze({
  question: 'question',
  user_ask: 'question',
  ask_user: 'question',
});

function isQuestionTool(name) {
  const raw = String(name || '').trim();
  return QUESTION_ALIASES[raw] === 'question';
}

function clip(text, max) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return value.slice(0, max).trim();
}

function asQuestionList(args) {
  if (Array.isArray(args)) return args;
  if (!args || typeof args !== 'object') return [];
  if (Array.isArray(args.questions)) return args.questions;
  if (Array.isArray(args.prompts)) return args.prompts;
  if (args.question || args.text || args.prompt) return [args];
  return [];
}

function normalizeOption(raw, index) {
  if (typeof raw === 'string') {
    const label = clip(raw, MAX_LABEL);
    if (!label) return null;
    return { label, description: '' };
  }
  if (!raw || typeof raw !== 'object') return null;
  const label = clip(raw.label || raw.value || raw.text || raw.id || `opción ${index + 1}`, MAX_LABEL);
  if (!label) return null;
  return {
    label,
    description: clip(raw.description || raw.hint || raw.detail || '', MAX_DESCRIPTION),
  };
}

function normalizePrompt(raw, index) {
  if (typeof raw === 'string') {
    const question = clip(raw, MAX_QUESTION);
    if (!question) return { ok: false, code: 'validation', error: ERRORS.blank };
    return {
      ok: true,
      prompt: {
        question,
        header: clip(question, MAX_HEADER),
        options: [],
        multiple: false,
        custom: true,
      },
    };
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, code: 'validation', error: ERRORS.blank };
  }
  const question = clip(raw.question || raw.text || raw.prompt || '', MAX_QUESTION);
  if (!question) return { ok: false, code: 'validation', error: ERRORS.blank };
  const optionSource = Array.isArray(raw.options)
    ? raw.options
    : (Array.isArray(raw.choices) ? raw.choices : []);
  const options = optionSource
    .slice(0, MAX_OPTIONS)
    .map((item, optIndex) => normalizeOption(item, optIndex))
    .filter(Boolean);
  const header = clip(raw.header || raw.title || raw.label || question, MAX_HEADER);
  return {
    ok: true,
    prompt: {
      question,
      header,
      options,
      multiple: raw.multiple === true || raw.multi === true,
      custom: raw.custom !== false,
    },
  };
}

function normalizeQuestionArgs(args) {
  const list = asQuestionList(args);
  if (!list.length) return { ok: false, code: 'validation', error: ERRORS.empty };
  if (list.length > MAX_QUESTIONS) return { ok: false, code: 'validation', error: ERRORS.tooMany };
  const questions = [];
  for (let i = 0; i < list.length; i += 1) {
    const next = normalizePrompt(list[i], i);
    if (!next.ok) return next;
    questions.push(next.prompt);
  }
  return { ok: true, questions };
}

function publicQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).map((item) => ({
    question: item.question,
    header: item.header,
    multiple: Boolean(item.multiple),
    custom: item.custom !== false,
    options: (item.options || []).map((opt) => ({
      label: opt.label,
      description: opt.description || '',
    })),
  }));
}

function pendingQuestionLabel(pending) {
  if (pending && (pending.kind === 'question' || isQuestionTool(pending.tool))) {
    return 'Esperando respuesta';
  }
  return 'Esperando permiso';
}

function isQuestionPending(pending) {
  return Boolean(pending && (pending.kind === 'question' || isQuestionTool(pending.tool)));
}

function describePending(permissionId, pending) {
  const question = isQuestionPending(pending);
  const questions = question ? publicQuestions(pending.questions || (pending.args && pending.args.questions) || []) : undefined;
  return {
    permissionId,
    tool: pending && pending.tool,
    label: pendingQuestionLabel(pending),
    kind: question ? 'question' : 'permission',
    header: questions && questions[0] ? questions[0].header : undefined,
    questions,
  };
}

function coerceAnswerRows(raw, questionCount) {
  if (raw == null) {
    return Array.from({ length: questionCount }, () => []);
  }
  if (typeof raw === 'string') {
    const text = clip(raw, MAX_CUSTOM);
    return questionCount === 1
      ? [text ? [text] : []]
      : null;
  }
  if (!Array.isArray(raw)) return null;

  const allStrings = raw.length > 0 && raw.every((item) => typeof item === 'string' || item == null);
  let rows;
  if (allStrings && questionCount === 1) {
    rows = [raw.map((item) => clip(item, MAX_CUSTOM)).filter(Boolean)];
  } else if (allStrings) {
    rows = raw.map((item) => {
      const text = clip(item, MAX_CUSTOM);
      return text ? [text] : [];
    });
  } else {
    rows = raw.map((item) => {
      if (item == null) return [];
      if (Array.isArray(item)) return item.map((part) => clip(part, MAX_CUSTOM)).filter(Boolean);
      if (typeof item === 'string') {
        const text = clip(item, MAX_CUSTOM);
        return text ? [text] : [];
      }
      if (typeof item === 'object') {
        const source = Array.isArray(item.labels)
          ? item.labels
          : (Array.isArray(item.answers) ? item.answers : [item.label || item.value || item.text]);
        return source.map((part) => clip(part, MAX_CUSTOM)).filter(Boolean);
      }
      return [];
    });
  }

  while (rows.length < questionCount) rows.push([]);
  return rows.slice(0, questionCount);
}

function resolveSelected(prompt, selected) {
  const options = prompt.options || [];
  const resolved = [];
  for (const raw of selected) {
    const needle = clip(raw, MAX_CUSTOM);
    if (!needle) continue;
    const match = options.find((opt) => opt.label.toLowerCase() === needle.toLowerCase());
    if (match) {
      if (!resolved.includes(match.label)) resolved.push(match.label);
      continue;
    }
    if (prompt.custom === false && options.length > 0) {
      return { ok: false, code: 'validation', error: ERRORS.unknownOption };
    }
    if (!resolved.includes(needle)) resolved.push(needle);
  }
  if (!prompt.multiple && resolved.length > 1) {
    return { ok: false, code: 'validation', error: ERRORS.singleOnly };
  }
  return { ok: true, selected: resolved };
}

function validateAnswers(questions, rawAnswers, { allowEmpty = true } = {}) {
  const prompts = Array.isArray(questions) ? questions : [];
  const rows = coerceAnswerRows(rawAnswers, prompts.length);
  if (!rows) return { ok: false, code: 'validation', error: ERRORS.invalidAnswers };
  const answers = [];
  for (let i = 0; i < prompts.length; i += 1) {
    const next = resolveSelected(prompts[i], rows[i] || []);
    if (!next.ok) return next;
    answers.push(next.selected);
  }
  if (!allowEmpty && answers.every((row) => row.length === 0)) {
    return { ok: false, code: 'validation', error: ERRORS.invalidAnswers };
  }
  return { ok: true, answers };
}

function formatAnsweredResult(questions, answers) {
  const lines = (questions || []).map((prompt, index) => {
    const picked = (answers && answers[index]) || [];
    const value = picked.length ? picked.join(', ') : 'Sin respuesta';
    return `«${prompt.question}» → ${value}`;
  });
  const text = lines.length
    ? `El usuario respondió:\n${lines.join('\n')}\nContinúa con estas respuestas.`
    : 'El usuario continuó sin responder.';
  return { text, answers: answers || [] };
}

function formatDismissedResult(questions) {
  const count = Array.isArray(questions) ? questions.length : 0;
  const text = count > 1
    ? 'El usuario descartó las preguntas. No asumas una opción.'
    : 'El usuario descartó la pregunta. No asumas una opción.';
  return { text, answers: Array.from({ length: count }, () => []) };
}

function runQuestion(_workspace, args = {}, ctx = {}) {
  const normalized = normalizeQuestionArgs(args);
  if (!normalized.ok) {
    return {
      ok: false,
      code: normalized.code || 'validation',
      error: normalized.error,
      content: `ERROR: ${normalized.error}`,
    };
  }
  if (ctx.dismissed === true) {
    const dismissed = formatDismissedResult(normalized.questions);
    return {
      ok: true,
      dismissed: true,
      answers: dismissed.answers,
      questions: normalized.questions,
      content: dismissed.text,
    };
  }
  const rawAnswers = ctx.answers !== undefined ? ctx.answers : args.answers;
  const checked = validateAnswers(normalized.questions, rawAnswers, { allowEmpty: true });
  if (!checked.ok) {
    return {
      ok: false,
      code: checked.code || 'validation',
      error: checked.error,
      content: `ERROR: ${checked.error}`,
    };
  }
  const formatted = formatAnsweredResult(normalized.questions, checked.answers);
  return {
    ok: true,
    answers: checked.answers,
    questions: normalized.questions,
    content: formatted.text,
  };
}

module.exports = {
  MAX_QUESTIONS,
  MAX_OPTIONS,
  MAX_HEADER,
  ERRORS,
  QUESTION_ALIASES,
  isQuestionTool,
  normalizeQuestionArgs,
  publicQuestions,
  pendingQuestionLabel,
  isQuestionPending,
  describePending,
  validateAnswers,
  formatAnsweredResult,
  formatDismissedResult,
  runQuestion,
};
