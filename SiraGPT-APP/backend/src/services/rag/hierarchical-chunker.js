/**
 * hierarchical-chunker — structure-aware chunking with a bottom-up
 * summary tree.
 *
 * Difference from raptor-tree.js:
 *   - raptor-tree clusters by EMBEDDING similarity. The grouping is
 *     semantic but the boundaries don't follow the document.
 *   - this module groups by DOCUMENT STRUCTURE. The tree mirrors
 *     headings: doc → sections (## …) → subsections (### …) →
 *     paragraphs → sentences. A query like "what does section 3 say
 *     about pricing" can be answered without ever leaving its parent.
 *
 * Tree shape — every node:
 *   {
 *     id, level,                 // 0 = doc root, 1 = section, …
 *     text, summary,             // raw text; LLM-condensed summary
 *     heading,                   // section title, if any
 *     parentId, childrenIds,     // tree links
 *     embedding,                 // over `summary` (or text for leaves)
 *     metadata,                  // { role, charCount, sentenceCount, … }
 *   }
 *
 * Retrieval is QUERY-AWARE:
 *   - "global" queries (resumen, de qué trata, tl;dr, overview) →
 *      return the root summary plus optional level-1 children.
 *   - "specific" queries → score leaves by cosine, return each hit
 *     stitched to its parent section summary so the LLM has context.
 *
 * Heading detection is plug-in:
 *   - Markdown by default (parses #, ##, ### …).
 *   - Caller can pass pre-segmented `sections` (PDF outline, DOCX
 *     heading style) and skip detection entirely.
 *
 * No third-party deps. All async functions accept injectables (embed,
 * summarize) so tests can run without network.
 */

const crypto = require('crypto');

// ─── ids & math helpers ──────────────────────────────────────────────────

function nodeId(prefix, seed) {
  const h = crypto.createHash('sha1').update(`${prefix}|${String(seed).slice(0, 256)}`).digest('hex');
  return `${prefix}-${h.slice(0, 12)}`;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

// ─── heading detection ───────────────────────────────────────────────────

const MD_HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * Split a markdown-ish text into nested sections by `#` levels.
 * Returns a flat array of {level, heading, body, startLine} preserving
 * original ordering. Body text stops at the next heading of equal or
 * shallower depth.
 *
 * Anything before the first heading becomes the "preamble" (level 0).
 */
function detectMarkdownSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = [];
  let buf = [];
  let current = { level: 0, heading: '', startLine: 0 };

  const flush = (endLine) => {
    const body = buf.join('\n').trim();
    if (body || current.heading) {
      sections.push({ ...current, body, endLine });
    }
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MD_HEADING_RE);
    if (m) {
      flush(i - 1);
      current = { level: m[1].length, heading: m[2].trim(), startLine: i };
    } else {
      buf.push(lines[i]);
    }
  }
  flush(lines.length - 1);
  return sections;
}

/**
 * Greedy paragraph splitter — blank-line-delimited blocks. Falls back
 * to fixed-width windows if a single paragraph exceeds maxChars.
 */
function splitParagraphs(text, maxChars = 1200) {
  const out = [];
  const paras = String(text || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  for (const p of paras) {
    if (p.length <= maxChars) {
      out.push(p);
      continue;
    }
    for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
  }
  return out;
}

/** Sentence splitter — naïve but language-agnostic (CJK + Latin). */
function splitSentences(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  // Split on terminal punctuation followed by whitespace + capital/quote
  // and on hard line breaks.
  return t
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map(s => s.trim())
    .filter(Boolean);
}

// ─── tree construction ───────────────────────────────────────────────────

/**
 * Convert a flat list of {level, heading, body} sections into a
 * parent/child tree. The list is processed with a stack: a section at
 * depth N becomes a child of the nearest preceding section with
 * depth < N. The synthetic root (level 0) is the document itself.
 */
function nestSections(flatSections, { docTitle = 'document', docText = '' } = {}) {
  const root = {
    level: 0,
    heading: docTitle,
    body: '',
    children: [],
    startLine: 0,
  };
  const stack = [root];

  for (const s of flatSections) {
    if (s.level === 0) {
      // Preamble — attach as a body-only child of the root so it isn't
      // lost. Treat as a section at depth 1 for tree purposes.
      const node = { level: 1, heading: '(preamble)', body: s.body, children: [], startLine: s.startLine };
      root.children.push(node);
      stack.length = 1;
      stack.push(node);
      continue;
    }
    while (stack.length > 1 && stack[stack.length - 1].level >= s.level) stack.pop();
    const node = { level: s.level, heading: s.heading, body: s.body, children: [], startLine: s.startLine };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  // If no headings were detected at all, expose the full doc as a
  // single level-1 section so the tree still has structure.
  if (root.children.length === 0 && docText.trim()) {
    root.children.push({ level: 1, heading: '(body)', body: docText, children: [], startLine: 0 });
  }

  return root;
}

/**
 * Walk the nested-section tree and build the typed node array
 * the rest of the module operates on. Leaf-level paragraphs are
 * created from each section body.
 */
function flattenToNodes(sectionTree, { paragraphMaxChars }) {
  const nodes = [];
  const byId = new Map();

  function makeNode(props) {
    const node = { childrenIds: [], parentId: null, ...props };
    nodes.push(node);
    byId.set(node.id, node);
    return node;
  }

  // Synthetic root — text is empty for now, summary written later.
  const rootText = sectionTree.heading || 'document';
  const root = makeNode({
    id: nodeId('doc', rootText + Date.now()),
    level: 0,
    heading: sectionTree.heading || 'document',
    text: '',
    summary: '',
    metadata: { role: 'root' },
  });

  function visit(secNode, parent, depth) {
    const sec = makeNode({
      id: nodeId(`sec${depth}`, (secNode.heading || '') + secNode.startLine + secNode.body.slice(0, 60)),
      level: depth,
      heading: secNode.heading || '',
      text: secNode.body || '',
      summary: '',
      parentId: parent.id,
      metadata: { role: 'section', startLine: secNode.startLine },
    });
    parent.childrenIds.push(sec.id);

    // Children: nested sections first, then paragraph leaves of THIS
    // section's own body. Paragraphs only attach to sections that
    // actually have body text (avoids dummy leaves under header-only
    // sections like "## Chapter 1").
    for (const child of secNode.children || []) visit(child, sec, depth + 1);

    if (secNode.body && secNode.body.trim()) {
      const paras = splitParagraphs(secNode.body, paragraphMaxChars);
      for (let i = 0; i < paras.length; i++) {
        const p = paras[i];
        const para = makeNode({
          id: nodeId('p', sec.id + '|' + i + '|' + p.slice(0, 80)),
          level: depth + 1,
          heading: '',
          text: p,
          summary: '', // leaf summary defaults to its own text
          parentId: sec.id,
          metadata: { role: 'paragraph', sectionId: sec.id, ordinalInSection: i },
        });
        sec.childrenIds.push(para.id);
      }
    }
  }

  for (const child of sectionTree.children || []) visit(child, root, 1);

  return { nodes, byId, rootId: root.id };
}

// ─── summarization (bottom-up) ───────────────────────────────────────────

/**
 * Default text-only summarizer — first 2 sentences + truncate.
 * Used as fallback when no LLM is provided. Deterministic, useful
 * for tests.
 */
function fallbackSummarize(input) {
  const text = typeof input === 'string' ? input : (input?.text || '');
  if (!text) return '';
  const sents = splitSentences(text);
  const head = sents.slice(0, 2).join(' ').trim();
  const out = head || text.slice(0, 240);
  return out.length > 320 ? out.slice(0, 320).trimEnd() + '…' : out;
}

/**
 * Bottom-up summary pass.
 *
 * Leaves: summary defaults to text (or fallbackSummarize for very long
 * paragraphs).
 * Internal nodes: summary = await summarize({heading, childSummaries}).
 * Embeddings: every node's summary (or text if leaf) is embedded.
 *
 * `concurrency` caps parallel LLM calls within a level — bottom-up
 * order is preserved across levels.
 */
async function summarizeTreeBottomUp({
  nodes, byId, rootId,
  summarize,            // async ({heading, childSummaries, text}) → string
  embed,                // async (texts:string[]) → number[][]
  concurrency = 4,
  paragraphSummaryThreshold = 600,
}) {
  // Group nodes by level (descending — leaves first).
  const byLevel = new Map();
  for (const n of nodes) {
    if (!byLevel.has(n.level)) byLevel.set(n.level, []);
    byLevel.get(n.level).push(n);
  }
  const levels = [...byLevel.keys()].sort((a, b) => b - a);
  const summarizeFn = typeof summarize === 'function' ? summarize : fallbackSummarize;

  for (const level of levels) {
    const levelNodes = byLevel.get(level);

    // Process in chunks to bound concurrency.
    for (let i = 0; i < levelNodes.length; i += concurrency) {
      const batch = levelNodes.slice(i, i + concurrency);
      await Promise.all(batch.map(async (node) => {
        if (node.childrenIds.length === 0) {
          // Leaf — summary = text, condensed if very long.
          if (!node.summary) {
            node.summary = node.text.length > paragraphSummaryThreshold
              ? fallbackSummarize(node.text)
              : node.text;
          }
          return;
        }

        const childSummaries = node.childrenIds
          .map(id => byId.get(id))
          .filter(Boolean)
          .map(c => ({ heading: c.heading, summary: c.summary || c.text || '' }));

        try {
          const result = await summarizeFn({
            heading: node.heading || '',
            level: node.level,
            childSummaries,
            text: node.text || '',
          });
          node.summary = typeof result === 'string' && result.trim()
            ? result.trim()
            : fallbackSummarize(childSummaries.map(c => c.summary).join('\n\n'));
        } catch {
          // Fail-soft: concatenate child summaries so the tree still
          // has SOMETHING at this node.
          node.summary = fallbackSummarize(childSummaries.map(c => c.summary).join('\n\n'));
        }
      }));
    }
  }

  // Embed everything (one batched call when possible).
  if (typeof embed === 'function') {
    const texts = nodes.map(n => (n.summary || n.text || n.heading || ''));
    const vectors = await embed(texts);
    if (Array.isArray(vectors) && vectors.length === nodes.length) {
      for (let i = 0; i < nodes.length; i++) nodes[i].embedding = vectors[i];
    }
  }
}

// ─── public: build ───────────────────────────────────────────────────────

/**
 * Build a hierarchical tree from raw document text.
 *
 * @param {object} args
 * @param {string} args.text                    full document text
 * @param {string} [args.title]                 doc title (root heading)
 * @param {Array}  [args.sections]              caller-provided sections
 *        — pre-segmented {level, heading, body} list. When given,
 *        the markdown detector is skipped. Use this for PDF outline
 *        or DOCX heading-style extraction.
 * @param {Function} [args.summarize]           async ({heading, level,
 *        childSummaries, text}) → string. Defaults to fallback.
 * @param {Function} [args.embed]               async (string[]) →
 *        number[][]. If omitted, embeddings are left undefined and
 *        retrieval falls back to keyword matching.
 * @param {number} [args.paragraphMaxChars=1200]
 * @param {number} [args.concurrency=4]
 *
 * @returns {Promise<{
 *   nodes: Array, rootId: string, levels: number,
 *   stats: { sectionCount, paragraphCount, totalChars }
 * }>}
 */
async function buildHierarchicalTree(args) {
  const {
    text = '',
    title = 'document',
    sections = null,
    summarize = null,
    embed = null,
    paragraphMaxChars = 1200,
    concurrency = 4,
  } = args || {};

  const flat = Array.isArray(sections) && sections.length > 0
    ? sections.map(s => ({
        level: Math.max(1, Number(s.level) || 1),
        heading: String(s.heading || ''),
        body: String(s.body || ''),
        startLine: Number(s.startLine) || 0,
      }))
    : detectMarkdownSections(text);

  const nested = nestSections(flat, { docTitle: title, docText: text });
  const { nodes, byId, rootId } = flattenToNodes(nested, { paragraphMaxChars });

  await summarizeTreeBottomUp({ nodes, byId, rootId, summarize, embed, concurrency });

  // Compute stats.
  const stats = {
    sectionCount: nodes.filter(n => n.metadata?.role === 'section').length,
    paragraphCount: nodes.filter(n => n.metadata?.role === 'paragraph').length,
    totalChars: nodes.reduce((acc, n) => acc + (n.text?.length || 0), 0),
  };
  const levels = nodes.reduce((m, n) => Math.max(m, n.level), 0) + 1;

  return { nodes, rootId, levels, stats };
}

// ─── query classification ────────────────────────────────────────────────

const GLOBAL_QUERY_KEYWORDS = [
  // Spanish
  'resumen', 'resume', 'resúmeme', 'resumir', 'síntesis', 'sintetiza',
  'de qué trata', 'de que trata', 'sobre qué', 'sobre que',
  'idea principal', 'tema principal', 'visión general', 'panorama',
  'en general', 'global', 'tldr', 'tl;dr',
  // English
  'summary', 'summarize', 'summarise', 'overview', 'overall',
  'tl;dr', 'gist', 'main idea', 'main point', 'big picture',
  'what is the document about', 'what does the document say overall',
  'what is this about', 'in summary',
];

/**
 * Classify a query as 'global' (wants high-level summary) or
 * 'specific' (wants particular facts). Heuristic-first; an optional
 * `intentAnalyzer` hook can override (we delegate to
 * document-intent-analyzer when SUMMARIZE wins).
 *
 * Returns { mode: 'global'|'specific', score, matched }.
 */
function classifyQuery(query, opts = {}) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return { mode: 'specific', score: 0, matched: null };

  for (const kw of GLOBAL_QUERY_KEYWORDS) {
    if (q.includes(kw)) return { mode: 'global', score: 1, matched: kw };
  }

  // Short meta questions like "¿qué dice?" / "what does it say" without
  // a specific noun. Pattern requires the phrase to END right after
  // the meta verb (optionally a generic pronoun + ? mark) so longer
  // queries like "what is the price of storage" don't match.
  const metaQuestion = /^[¿?]?\s*(qué|que|what|cómo|como|how)\s+(dice|trata|es|says?)\s*(it|this|el\s+documento|the\s+document|the\s+doc)?\s*[?.!]?$/i;
  const metaDoes = /^[¿?]?\s*(what|how|qué|que)\s+(does|do)\s+(it|this|the\s+document|the\s+doc|el\s+documento)\s+(say|says|tell\s+(?:me|us))\b\s*[?.!]?$/i;
  if (metaQuestion.test(q) || metaDoes.test(q)) {
    return { mode: 'global', score: 0.6, matched: 'short-meta-question' };
  }

  // External classifier hook (e.g. document-intent-analyzer SUMMARIZE).
  if (typeof opts.intentClassifier === 'function') {
    try {
      const intent = opts.intentClassifier(q);
      if (intent && /summar/i.test(intent)) return { mode: 'global', score: 0.8, matched: `intent:${intent}` };
    } catch { /* ignore */ }
  }

  return { mode: 'specific', score: 0, matched: null };
}

// ─── public: retrieve ────────────────────────────────────────────────────

/**
 * Hierarchical retrieval.
 *
 * @param {object} args
 * @param {object} args.tree       output of buildHierarchicalTree
 * @param {string} args.query
 * @param {number[]} [args.queryEmbedding]
 * @param {number} [args.k=6]
 * @param {string} [args.modeOverride]  force 'global' or 'specific'
 *
 * @returns {{
 *   mode: 'global'|'specific',
 *   results: Array<{
 *     id, level, role, heading, text, summary, score, sectionContext?
 *   }>
 * }}
 */
function retrieveHierarchical(args) {
  const {
    tree, query, queryEmbedding = null,
    k = 6, modeOverride = null,
  } = args || {};
  if (!tree || !Array.isArray(tree.nodes) || tree.nodes.length === 0) {
    return { mode: 'specific', results: [] };
  }
  const byId = new Map(tree.nodes.map(n => [n.id, n]));

  const cls = modeOverride
    ? { mode: modeOverride, matched: 'override' }
    : classifyQuery(query);

  if (cls.mode === 'global') {
    const root = byId.get(tree.rootId);
    const out = [];
    if (root) {
      out.push({
        id: root.id, level: 0, role: 'root',
        heading: root.heading, text: root.text,
        summary: root.summary, score: 1,
      });
    }
    // Plus the level-1 sections, ordered by source order.
    const level1 = tree.nodes
      .filter(n => n.level === 1 && n.metadata?.role === 'section')
      .slice(0, Math.max(0, k - 1));
    for (const n of level1) {
      out.push({
        id: n.id, level: n.level, role: 'section',
        heading: n.heading, text: n.text,
        summary: n.summary, score: 0.9,
      });
    }
    return { mode: 'global', results: out };
  }

  // Specific: rank LEAF nodes by cosine over `summary or text` then
  // attach parent-section context. If no embedding is given, fall back
  // to keyword scoring.
  const leaves = tree.nodes.filter(n => n.metadata?.role === 'paragraph');
  const haveEmbeddings = Array.isArray(queryEmbedding)
    && queryEmbedding.length > 0
    && leaves.some(l => Array.isArray(l.embedding));

  let scored;
  if (haveEmbeddings) {
    scored = leaves.map(n => ({ node: n, score: cosine(queryEmbedding, n.embedding || []) }));
  } else {
    const tokens = String(query || '').toLowerCase().split(/\W+/).filter(t => t.length >= 3);
    scored = leaves.map(n => {
      const hay = (n.text + ' ' + (n.heading || '')).toLowerCase();
      let s = 0;
      for (const t of tokens) if (hay.includes(t)) s += 1;
      return { node: n, score: tokens.length ? s / tokens.length : 0 };
    });
  }
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, k).filter(x => x.score > 0);
  const results = top.map(({ node, score }) => {
    const parent = node.parentId ? byId.get(node.parentId) : null;
    return {
      id: node.id,
      level: node.level,
      role: 'paragraph',
      heading: parent?.heading || '',
      text: node.text,
      summary: node.summary,
      score,
      sectionContext: parent
        ? { id: parent.id, heading: parent.heading, summary: parent.summary }
        : null,
    };
  });

  return { mode: 'specific', results };
}

// ─── persistence (Prisma) ────────────────────────────────────────────────

/**
 * Persist a tree to the `document_nodes` table. Uses createMany; the
 * caller is responsible for deleting any prior tree for the same file.
 *
 * Embeddings are stored as JSON arrays — Postgres `Float[]` would be
 * faster but this keeps the schema portable across providers.
 */
async function persistTree(prisma, { fileId, analysisId = null, tree }) {
  if (!prisma?.documentNode?.createMany) throw new Error('hierarchical-chunker: prisma.documentNode missing');
  if (!fileId) throw new Error('hierarchical-chunker: fileId required');
  if (!tree || !Array.isArray(tree.nodes)) return { written: 0 };

  const rows = tree.nodes.map((n, ordinal) => ({
    id: n.id,
    fileId,
    analysisId,
    parentId: n.parentId || null,
    level: n.level,
    role: n.metadata?.role || 'node',
    heading: n.heading || null,
    text: n.text || '',
    summary: n.summary || '',
    embedding: Array.isArray(n.embedding) ? n.embedding : null,
    metadata: n.metadata || {},
    ordinal,
  }));

  await prisma.documentNode.createMany({ data: rows, skipDuplicates: true });
  return { written: rows.length };
}

/**
 * Load a previously persisted tree back into memory.
 */
async function loadTree(prisma, { fileId }) {
  if (!prisma?.documentNode?.findMany) throw new Error('hierarchical-chunker: prisma.documentNode missing');
  const rows = await prisma.documentNode.findMany({
    where: { fileId },
    orderBy: { ordinal: 'asc' },
  });
  if (!rows.length) return null;

  const nodes = rows.map(r => ({
    id: r.id,
    level: r.level,
    heading: r.heading || '',
    text: r.text || '',
    summary: r.summary || '',
    parentId: r.parentId || null,
    childrenIds: [],
    embedding: r.embedding || null,
    metadata: r.metadata || {},
  }));
  // Rebuild childrenIds.
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) byId.get(n.parentId).childrenIds.push(n.id);
  }
  const root = nodes.find(n => n.level === 0) || nodes[0];
  return {
    nodes,
    rootId: root?.id || null,
    levels: nodes.reduce((m, n) => Math.max(m, n.level), 0) + 1,
    stats: {
      sectionCount: nodes.filter(n => n.metadata?.role === 'section').length,
      paragraphCount: nodes.filter(n => n.metadata?.role === 'paragraph').length,
      totalChars: nodes.reduce((acc, n) => acc + (n.text?.length || 0), 0),
    },
  };
}

module.exports = {
  // tree building
  buildHierarchicalTree,
  // section detection
  detectMarkdownSections,
  splitParagraphs,
  splitSentences,
  // query routing
  classifyQuery,
  retrieveHierarchical,
  GLOBAL_QUERY_KEYWORDS,
  // persistence
  persistTree,
  loadTree,
  // helpers (exported for tests)
  cosine,
  nestSections,
  flattenToNodes,
  fallbackSummarize,
};
