/**
 * maintenance-agent — End-to-end Software Maintenance (§4.8 in
 * Liu et al., 2024). The one SE task from the survey we hadn't covered.
 *
 * Debug vs Maintenance: they look similar, but the inputs and the
 * reasoning shape are different.
 *   - debug-agent starts from a STACKTRACE. The file:line hints point
 *     at specific locations; the agent narrows from there.
 *   - maintenance-agent starts from an ISSUE TICKET — a human-readable
 *     bug report or feature gap. There's no stacktrace to seed; the
 *     agent must first LOCATE the relevant code using symbol search,
 *     then reason about the fix.
 *
 * Workflow:
 *   1. Parse the ticket for mentions: file paths, symbol names, URLs,
 *      error strings. Feed these as free-text hints to the agent.
 *   2. Agent uses list_files + search_code + search_docs to localise
 *      the subsystem that owns the behaviour described.
 *   3. Reads the candidates, forms a hypothesis about what's wrong
 *      or missing.
 *   4. Proposes a patch via propose_patch.
 *   5. Suggests regression tests that would catch the issue.
 *
 * Output shape matches debug-agent's so downstream UIs can render both
 * without bespoke handling.
 */

const agentCore = require('./agent-core');
const tools = require('./agent-tools');

const ROLE = `You are a senior engineer triaging a maintenance ticket.

Given a user-written issue (not a stacktrace), you:
  1. Find the code that owns the described behaviour — use search_code for
     symbols and search_docs for terms. list_files first if you need a map.
  2. Read the actual code (get_symbol / read_file). Never guess code you
     haven't seen.
  3. Form a SINGLE hypothesis about what needs to change and why. State
     your confidence honestly.
  4. Propose a minimal patch that fixes the root cause, not the symptom.
  5. List the regression test(s) the team should add so this issue cannot
     come back.

When the ticket is ambiguous or you can't find the relevant code with
the tools available, say so. A "not_localised" verdict with reasons is
more useful than a fabricated patch.`;

const FINAL_SCHEMA_HINT = {
  status: 'resolved|likely_fix|not_localised|out_of_scope',
  localisation: {
    confidence: 0.0,
    primary_file: '<source or null>',
    primary_symbol: '<symbol name or null>',
    related_files: ['<source>'],
    rationale: '<one paragraph: what you found and why you think this is it>',
  },
  hypothesis: '<what the bug or gap is, and why the ticket surfaced it>',
  patches: [{
    source: '<source>',
    start_line: 0,
    end_line: 0,
    replacement: '<new code>',
    rationale: '<why this is the right change>',
    confidence: 0.0,
  }],
  tests_to_add: ['<regression test description>'],
  open_questions: ['<clarification needed from the ticket reporter>'],
};

/**
 * Extract free-text hints from a ticket: file paths, symbols, URLs,
 * quoted strings. The agent gets these as a supplementary prompt so
 * it can start searching from concrete anchors instead of prose.
 */
function extractTicketHints(ticket) {
  if (!ticket || typeof ticket !== 'string') return {};
  const text = ticket.slice(0, 8000);

  const filePaths = [...new Set(
    (text.match(/\b[\w./-]+\.(js|ts|jsx|tsx|py|go|rb|java|rs|cpp?|h|cs|php|md|json|yaml|yml|sql|toml)\b/g) || [])
  )].slice(0, 20);

  // camelCase or PascalCase identifiers of length >= 3
  const symbols = [...new Set(
    (text.match(/\b[a-z][a-zA-Z0-9_]{2,}|[A-Z][a-zA-Z0-9_]{2,}\b/g) || [])
      .filter(s => /[a-z]/.test(s) && /[A-Z_]/.test(s)) // must be mixed-case or snake_case
  )].slice(0, 30);

  // Quoted error messages
  const quotedStrings = [...new Set(
    (text.match(/"([^"\n]{4,120})"/g) || []).concat(text.match(/'([^'\n]{4,120})'/g) || [])
  )].slice(0, 10);

  const urls = [...new Set(
    (text.match(/\bhttps?:\/\/\S+/g) || [])
  )].slice(0, 10);

  return { filePaths, symbols, quotedStrings, urls };
}

/**
 * Run the maintenance agent.
 *
 * @param {object} args
 * @param {string} args.ticket — the issue description (required)
 * @param {string} [args.title] — short title if separate from body
 * @param {string} [args.reporter] — reporter role, e.g. "customer", "qa"
 * @param {Array<string>} [args.initialSuspicion] — user-supplied hints
 */
async function resolve({
  openai, userId, collection,
  ticket, title, reporter, initialSuspicion,
  maxIters = 14, model = 'gpt-4o-mini', onStep,
}) {
  if (!ticket) throw new Error('maintenance-agent: "ticket" is required');

  const hints = extractTicketHints(ticket);
  const hintsBlock = [
    hints.filePaths?.length ? `Possible files: ${hints.filePaths.join(', ')}` : '',
    hints.symbols?.length ? `Possible symbols: ${hints.symbols.join(', ')}` : '',
    hints.quotedStrings?.length ? `Quoted strings in the ticket: ${hints.quotedStrings.join(', ')}` : '',
    hints.urls?.length ? `URLs: ${hints.urls.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  const suspicionLine = Array.isArray(initialSuspicion) && initialSuspicion.length > 0
    ? `User suspects these files: ${initialSuspicion.join(', ')}`
    : '';

  const goal = [
    title ? `TICKET: ${title}` : 'TICKET:',
    ticket.slice(0, 6000),
    reporter ? `Reporter: ${reporter}` : '',
    '',
    'HINTS (extracted from the ticket text; verify before trusting):',
    hintsBlock || '(no concrete hints — rely on semantic search)',
    suspicionLine,
    '',
    'Step 1: locate the code that owns the described behaviour.',
    'Step 2: read enough of it to form a concrete hypothesis.',
    'Step 3: emit the final JSON per the schema, with a confident localisation or a clear "not_localised" status.',
  ].filter(Boolean).join('\n');

  const result = await agentCore.run({
    openai,
    role: ROLE,
    goal,
    tools: tools.pick(['list_files', 'read_file', 'get_symbol', 'search_code', 'search_docs', 'search_graph', 'propose_patch']),
    maxIters, model, onStep,
    context: { userId, collection, openai },
    finalSchema: FINAL_SCHEMA_HINT,
  });

  return normalizeMaintenance(result, { ticket, hints });
}

function normalizeMaintenance(result, { ticket, hints }) {
  const f = result.final || {};
  const validStatus = ['resolved', 'likely_fix', 'not_localised', 'out_of_scope'];

  const patches = Array.isArray(f.patches) ? f.patches.map(p => ({
    source: String(p?.source || ''),
    start_line: Number.isInteger(p?.start_line) ? p.start_line : null,
    end_line: Number.isInteger(p?.end_line) ? p.end_line : null,
    replacement: typeof p?.replacement === 'string' ? p.replacement : '',
    rationale: typeof p?.rationale === 'string' ? p.rationale.slice(0, 400) : '',
    confidence: typeof p?.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0.5,
  })).filter(p => p.source && p.replacement) : [];

  const loc = f.localisation || {};
  const localisation = {
    confidence: typeof loc.confidence === 'number' ? Math.max(0, Math.min(1, loc.confidence)) : 0.5,
    primary_file: typeof loc.primary_file === 'string' ? loc.primary_file : null,
    primary_symbol: typeof loc.primary_symbol === 'string' ? loc.primary_symbol : null,
    related_files: Array.isArray(loc.related_files)
      ? loc.related_files.map(String).filter(Boolean).slice(0, 20)
      : [],
    rationale: typeof loc.rationale === 'string' ? loc.rationale.slice(0, 1000) : '',
  };

  return {
    status: validStatus.includes(f.status) ? f.status : 'not_localised',
    localisation,
    hypothesis: typeof f.hypothesis === 'string' ? f.hypothesis.slice(0, 1500) : '',
    patches,
    tests_to_add: Array.isArray(f.tests_to_add)
      ? f.tests_to_add.map(t => String(t).slice(0, 300)).filter(Boolean).slice(0, 10)
      : [],
    open_questions: Array.isArray(f.open_questions)
      ? f.open_questions.map(q => String(q).slice(0, 200)).filter(Boolean).slice(0, 10)
      : [],
    ticket_hints: hints,
    iterations: result.iterations,
    terminatedBy: result.terminatedBy,
    stats: result.stats,
  };
}

module.exports = { resolve, normalizeMaintenance, extractTicketHints, ROLE };
