/**
 * intent-clarifier — pre-flight ambiguity detection.
 *
 * Ouyang et al. 2022 on the core alignment gap: "a given prompt's
 * intention can be unclear or ambiguous, we rely on judgment from our
 * labelers". When the labeler's interpretation diverges from the
 * user's actual intent, the model is trained toward the wrong target.
 *
 * A well-aligned system doesn't BLINDLY interpret — it asks. This
 * module does one thing: classify an incoming request as `clear` or
 * `ambiguous`. When ambiguous, it emits 1-3 specific disambiguation
 * questions the caller should ask the user before running a
 * specialist. When clear, it passes through and the specialist runs
 * immediately.
 *
 * The cost is one small LLM call per request. Default gating: only
 * invoke for specialists whose OUTPUT is expensive (code-gen,
 * consensus, end-to-end-dev). Cheap specialists (static-check with a
 * specific file) don't need a clarifier layer.
 *
 * Output shape:
 *   { status: 'clear' }
 *   { status: 'ambiguous', questions: [...], reasoning: "..." }
 *   { status: 'blocked', reason: "..." }     // if out-of-scope (e.g. safety)
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

const SYSTEM = `You pre-screen user requests for a software-engineering assistant.

Your ONLY job is to decide whether the request is CLEAR enough to action directly, or AMBIGUOUS and needs clarification from the user first.

A CLEAR request has:
- A specific target (a file, symbol, bug report, error, log excerpt, or explicit spec).
- A specific action (review, test, debug, generate, analyse, explain).
- No contradictions.

An AMBIGUOUS request is one where reasonable engineers would produce materially different outputs depending on what they ASSUMED the user meant. Examples:
- "Make the code better" (better how? faster? cleaner? more tested?).
- "Add a feature" (which feature? to which file?).
- "Fix the bug" (which bug? no error given).
Ask only the 1-3 questions that would most reduce the divergence. Do NOT ask nice-to-have questions.

Reply with STRICT JSON:
{"status":"clear"}
OR
{"status":"ambiguous","questions":["<one question>", ...],"reasoning":"<one sentence>"}
OR (when the request is out-of-scope for a code assistant)
{"status":"blocked","reason":"<one sentence>"}

Default to "clear" when reasonable — blocking clear requests wastes the user's time.`;

const MAX_REQUEST_CHARS = 4000;
const MAX_QUESTIONS = 3;

/**
 * @param {object} args
 * @param {object} args.openai — OpenAI-shaped client
 * @param {string} args.request — the user's ask
 * @param {string} [args.agent] — which specialist would run (context)
 * @param {string} [args.model='gpt-4o-mini']
 *
 * @returns {Promise<{status, questions?, reasoning?, reason?}>}
 */
async function clarify({ openai, request, agent, model = DEFAULT_MODEL }) {
  if (!openai) return { status: 'clear', reasoning: 'no LLM client — pass through' };
  if (!request || typeof request !== 'string' || request.trim().length < 8) {
    return { status: 'ambiguous', questions: ['Could you describe the task in a full sentence?'], reasoning: 'too short' };
  }

  const user = [
    agent ? `Intended specialist: ${agent}.` : '',
    `REQUEST:`,
    request.slice(0, MAX_REQUEST_CHARS),
  ].filter(Boolean).join('\n');

  try {
    const resp = await openai.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: user },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    return normalise(raw);
  } catch (err) {
    console.warn('[intent-clarifier] LLM call failed:', err.message);
    // Fail-open: when the clarifier is unavailable, we pass through
    // rather than blocking all requests.
    return { status: 'clear', reasoning: `clarifier error: ${err.message}` };
  }
}

function normalise(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { status: 'clear', reasoning: 'unparseable judge output — pass through' }; }

  if (parsed?.status === 'ambiguous') {
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions
          .map(q => String(q || '').trim())
          .filter(q => q.length >= 6 && q.length <= 300)
          .slice(0, MAX_QUESTIONS)
      : [];
    if (questions.length === 0) {
      // The judge said ambiguous but supplied no actionable questions.
      // Treat as clear to avoid a useless loop.
      return { status: 'clear', reasoning: parsed.reasoning || 'ambiguous-without-questions → pass' };
    }
    return {
      status: 'ambiguous',
      questions,
      reasoning: String(parsed.reasoning || '').slice(0, 300),
    };
  }
  if (parsed?.status === 'blocked') {
    return {
      status: 'blocked',
      reason: String(parsed.reason || 'out of scope').slice(0, 300),
    };
  }
  // default — treat anything else as clear
  return { status: 'clear', reasoning: String(parsed?.reasoning || '').slice(0, 300) };
}

module.exports = {
  clarify,
  normalise,
  SYSTEM,
  MAX_QUESTIONS,
};
