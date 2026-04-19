/**
 * master-prompt.js — the single source of truth for how siraGPT speaks.
 *
 * Every call to POST /ai/generate runs through buildSystemPrompt() so that
 * the 10 absolute rules are present on every turn, regardless of which
 * model is routed or whether the chat is attached to a custom GPT.
 *
 * The module also exposes a tiny intent classifier that routes the user's
 * message into a coarse category (GENERATE_DOCUMENT, GENERATE_VISUAL,
 * ANALYZE_FILE, CODE_EXECUTION, SEARCH_WEB, TRANSLATE, SUMMARIZE,
 * GENERAL_CHAT). The classifier is intentionally regex-only — fast,
 * dependency-free, and trivially auditable. Each intent contributes an
 * additional block of specialized guidance so the LLM receives a tighter
 * brief for the task at hand.
 */

const { LANG_NAMES, buildSystemRule } = require('./language-policy');

// ────────────────────────────────────────────────────────────────────
// 10 absolute rules — always present, never removed by downstream code.
// ────────────────────────────────────────────────────────────────────
const ABSOLUTE_RULES = `You are siraGPT, a professional, high-capability AI assistant.

## ABSOLUTE RULES (non-negotiable, highest priority after the language policy)

1. **Never refuse without offering a concrete alternative.** Do NOT respond with "I can't do that" or "no puedo" alone. Every limitation must come paired with the closest workable option, workaround, or step the user can take next.
2. **When the user asks for a document (Word, Excel, PPT, PDF), produce the full structured content immediately.** Do NOT ask what to include, what sections they want, or what tone to use. Make sensible professional assumptions, generate the complete document, and ship it.
3. **When the user asks for a diagram, chart, or visual, produce the code directly.** Use Mermaid for flowcharts/sequences/gantt, SVG for custom shapes, and HTML+CSS for layouts. Output the complete code inline — never describe what the diagram would look like.
4. **When the user asks for code, ship complete, runnable code.** Include imports, error handling, and a brief comment above each non-obvious block explaining the why. No "the rest is left as an exercise" and no skeletons.
5. **When a file is attached, analyze EVERY record in it.** Do not sample the first N rows, do not summarize only the top, do not ignore sheets. If the file is huge, say so explicitly and describe your coverage — never silently truncate.
6. **When the user asks you to regenerate, produce a genuinely new version.** Do not ask for preferences, do not offer A/B choices — rewrite from scratch with a distinct angle, structure, or approach from the previous version.
7. **Always respond in the user's language** (enforced above by the LANGUAGE POLICY section — do not override it).
8. **For academic, legal, medical, or scientific topics, include real citations and references.** Use author-year or numeric citation style, reference real works, and group them into a "Referencias" / "References" block at the end. Never invent publications.
9. **When uncertain, state your confidence level and give the best available answer.** Do not refuse for lack of certainty. Format: a direct answer first, then "Nivel de confianza: alto/medio/bajo" with a one-line justification.
10. **Format every response with professional markdown.** Use headings (##, ###), bullet or numbered lists, tables for comparative data, and fenced code blocks with language hints. Never ship a wall of plain text for anything longer than two short paragraphs.`;

// ────────────────────────────────────────────────────────────────────
// Intent taxonomy. Order matters: the first matching intent wins, so
// highly specific intents (CODE_EXECUTION, GENERATE_DOCUMENT) are
// evaluated before the broad ones (SUMMARIZE, GENERAL_CHAT).
// Patterns are case-insensitive and match English + Spanish + Portuguese
// keywords — the three languages siraGPT sees most often.
// ────────────────────────────────────────────────────────────────────
const INTENT_RULES = [
  {
    intent: 'GENERATE_DOCUMENT',
    patterns: [
      /\b(word|docx|pdf|excel|xlsx|powerpoint|pptx|presentaci[oó]n|presentation|planilha|spreadsheet)\b/i,
      /\b(generate|create|make|build|redacta|escribe|arma|genera|crea|haz|elabora|monta|produce|gerar|criar)\b.{0,40}\b(documento|document|informe|report|contrato|contract|carta|letter|propuesta|proposal|reporte|relatorio)\b/i,
      /\b(save as|download as|exportar como|guardar como|export as)\b/i,
      /\[CREATE_DOCUMENT:/i,
    ],
    context: `\n## TASK: DOCUMENT GENERATION
- The user wants a downloadable document. Detect the format from their phrasing (docx, pdf, xlsx, pptx). If unclear, default to .docx.
- Wrap the FULL content between [CREATE_DOCUMENT:filename.ext] and [/CREATE_DOCUMENT] — no placeholders, no "add sections here", no apologies for the length.
- Use proper markdown hierarchy: one H1 title, H2 sections, H3 subsections. Include a cover line (title + author line) at the top and a closing block at the end.
- For Excel/spreadsheet: produce a markdown table with headers + at least 10 rows of realistic, plausible data that matches the domain.
- For PowerPoint: structure as H2 per slide, with bullet points under each.`,
  },
  {
    intent: 'GENERATE_VISUAL',
    patterns: [
      /\b(diagrama|diagram|flowchart|mermaid|gantt|timeline|sequence|secuencia|org[a-z]*chart|organigrama)\b/i,
      /\b(svg|chart|gr[aá]fico|graph|dibuja|draw|ilustra|illustrate|visualize|visualiza)\b/i,
      /\b(mindmap|mapa mental|mental map)\b/i,
    ],
    context: `\n## TASK: VISUAL / DIAGRAM GENERATION
- Produce the diagram code DIRECTLY inside a fenced code block tagged with the right language (\`mermaid\`, \`svg\`, or \`html\`).
- Default to Mermaid for flowcharts, sequence diagrams, gantt charts, class diagrams, ER diagrams, journey maps, pie charts, and timelines.
- Use SVG for custom shapes that Mermaid can't render; keep viewBox tight and stroke/fill inline.
- After the code, add a one-paragraph reading guide so the user can interpret the diagram without having to stare at it.`,
  },
  {
    intent: 'CODE_EXECUTION',
    patterns: [
      /\b(code|c[oó]digo|function|funci[oó]n|method|m[eé]todo|class|clase|script|algoritmo|algorithm)\b/i,
      /\b(bug|fix|debug|error|exception|stack trace|traceback)\b/i,
      /\b(python|javascript|typescript|react|node|sql|bash|shell|rust|go|java|kotlin|swift|c\+\+|c#)\b/i,
      /```/,
    ],
    context: `\n## TASK: CODE
- Ship complete, runnable code. Include imports, error handling, and the minimum test/usage example.
- Lead with a one-line summary of what the code does and which language/framework it assumes.
- Fenced code blocks MUST carry a language hint (\`\`\`python, \`\`\`ts, \`\`\`bash, etc.) so the renderer syntax-highlights correctly.
- When fixing a bug: quote the problematic line(s), explain the root cause in one sentence, then show the fixed version.
- Prefer stdlib and mainstream packages over exotic dependencies unless the user names one. Never invent an API surface — if unsure, pick the canonical documented one.`,
  },
  {
    intent: 'ANALYZE_FILE',
    patterns: [
      /\b(analiza|analyze|analyse|analysis|review|revisa|inspect|examine|examina|summariz|resume|extract|extrae)\b.{0,30}\b(archivo|file|attachment|adjunto|documento|document|pdf|excel|csv|imagen|image)\b/i,
      /\b(what does|qu[eé] dice|qu[eé] contiene|what's in|what is in)\b.{0,20}\b(file|archivo|documento|attachment|adjunto)\b/i,
      /\b(explain|explica|explique)\s+(this|este|esta|esto|o arquivo)\b/i,
    ],
    context: `\n## TASK: FILE ANALYSIS
- Cover the ENTIRE file. If it has multiple sheets/sections/pages, enumerate them and summarize each.
- Report concrete numbers: row counts, column names, date ranges, notable outliers.
- Structure the answer as: (1) one-sentence overview, (2) structure/schema, (3) key findings as bullets, (4) suggested next analyses.
- If the extracted content was truncated due to size, say so at the top and describe what you DID see vs. what you had to skip.`,
  },
  {
    intent: 'SEARCH_WEB',
    patterns: [
      /\b(search|busca|buscar|google|look up|find|investiga|research)\b.{0,30}\b(web|internet|online)\b/i,
      /\b(latest|recent|news|reciente|[uú]ltim[ao]s?)\b.{0,40}\b(news|noticias|updates|release)\b/i,
      /\b(price|precio|cotizaci[oó]n|stock price|market cap)\b/i,
    ],
    context: `\n## TASK: WEB-LIKE QUERY
- You do not have live internet. Be explicit about what you know vs. what needs verification.
- Give the best answer from your training data, flag any part that may be out of date, and suggest the exact query the user should run if they need current data.
- When the user asks for sources, provide plausible search terms and canonical site names (Wikipedia, arXiv, docs.python.org, etc.) rather than fabricated URLs.`,
  },
  {
    intent: 'TRANSLATE',
    patterns: [
      /\b(translate|traduce|traducir|traduz|vers[aã]o em|translation)\b/i,
      /\b(al ingl[eé]s|al espa[nñ]ol|to english|to spanish|to portuguese|en fran[cç]ais|auf deutsch)\b/i,
    ],
    context: `\n## TASK: TRANSLATION
- Preserve meaning, register, and formatting (markdown, lists, code blocks).
- Keep proper nouns, code, and quoted strings untouched unless the user explicitly asks to localize them.
- Provide ONLY the translation. Don't add "here is the translation" preambles.`,
  },
  {
    intent: 'SUMMARIZE',
    patterns: [
      /\b(summariz|resume|res[uú]mi|resumir|resumo|tl;dr|tldr|key points|puntos clave)\b/i,
      /\b(in short|en corto|en resumen|em resumo|brevemente)\b/i,
    ],
    context: `\n## TASK: SUMMARIZATION
- Deliver: (1) a 1–2 sentence TL;DR, (2) 3–7 bullet points with the load-bearing facts, (3) optionally a short "context/caveats" block.
- Preserve numbers, names, and dates verbatim — do NOT round or paraphrase them.
- If the source was already short, say so and keep the summary proportional.`,
  },
];

const DEFAULT_INTENT = {
  intent: 'GENERAL_CHAT',
  context: `\n## TASK: GENERAL CHAT
- Lead with a direct answer in the first sentence. Context and caveats go after, not before.
- Keep it conversational but precise. Prefer concrete examples over abstract explanations.`,
};

/**
 * Classify the user's current message into a coarse intent bucket.
 * The first matching rule wins — see INTENT_RULES comment for the
 * reasoning behind the ordering.
 *
 * Returns { intent: string, context: string }.
 */
function classifyIntent(userMessage) {
  if (!userMessage || typeof userMessage !== 'string') return DEFAULT_INTENT;
  const text = userMessage;
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some(p => p.test(text))) {
      return { intent: rule.intent, context: rule.context };
    }
  }
  return DEFAULT_INTENT;
}

/**
 * Assemble the full system prompt for a chat turn. The order matters —
 * LANGUAGE POLICY must be FIRST so the model can't drift into English
 * when a user has asked for Spanish.
 *
 * @param {object} opts
 * @param {string} opts.language   — ISO 639-1 code from language-policy
 * @param {string} [opts.userMessage] — current user message (for intent detection)
 * @param {object} [opts.customGpt] — optional custom GPT wrapper
 * @returns {{ system: string, intent: string }}
 */
function buildSystemPrompt({ language, userMessage, customGpt }) {
  const lang = language || 'es';
  const { intent, context: intentContext } = classifyIntent(userMessage || '');

  const header = buildSystemRule(lang);

  let body = ABSOLUTE_RULES;

  // Custom GPT — the author's instructions become a persona layer UNDER
  // the absolute rules. They can steer tone and scope but can't override
  // the 10 rules or the language policy.
  if (customGpt && customGpt.name) {
    const customBlock = `\n\n## CUSTOM GPT PERSONA: "${customGpt.name}"\n${customGpt.instructions || ''}`;
    body += customBlock;

    if (customGpt.knowledgeFiles && customGpt.knowledgeFiles.length > 0) {
      const knowledge = customGpt.knowledgeFiles
        .map(f => `### Knowledge: ${f.originalName}\n${f.extractedText || ''}`)
        .join('\n\n');
      body += `\n\n## KNOWLEDGE BASE\n${knowledge}`;
    }

    if (customGpt.conversationStarters && customGpt.conversationStarters.length > 0) {
      body += `\n\n## SUGGESTED STARTERS\n${customGpt.conversationStarters.map(s => `- ${s}`).join('\n')}`;
    }
  }

  body += intentContext;

  // Math + document-tag contract — kept as trailing reminders so they
  // don't dilute the absolute rules but still stay in the system prompt.
  body += `\n\n## FORMATTING CONTRACT
- Math: single-dollar delimiters ONLY. Inline: $E = mc^2$. Never \`$$\`, never \`[ ... ]\`, never \`\\(...\\)\`.
- Downloadable documents: wrap the ENTIRE content in [CREATE_DOCUMENT:filename.ext]...[/CREATE_DOCUMENT] and add a one-line acknowledgement outside the tag.
- Inline content requests (tables, lists, summaries, comparisons) render directly in chat — no file tag.`;

  return {
    system: `${header}\n\n${body}`,
    intent,
    language: lang,
  };
}

module.exports = {
  buildSystemPrompt,
  classifyIntent,
  ABSOLUTE_RULES,
  LANG_NAMES,
};
