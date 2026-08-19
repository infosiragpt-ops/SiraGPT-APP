/**
 * code-contamination — detect whether a benchmark problem's solution
 * or test has leaked into the training/ingested corpus.
 *
 * The Jiang et al. survey §5.10 calls out contamination as a pressing
 * integrity issue for code benchmarks: if a HumanEval problem appeared
 * verbatim in the training data, pass@1 on it is meaningless. We
 * implement three complementary signals:
 *
 *   1. Exact-substring overlap (fast prefilter): does a ≥N-char run
 *      from the problem prompt / solution appear verbatim in any
 *      corpus document?
 *   2. N-gram Jaccard: token n-gram set similarity between the
 *      problem's canonical solution and each corpus doc. A high
 *      value (say ≥0.4 for 5-grams) indicates near-duplicate content.
 *   3. Rare-token overlap: tokens that are rare across the corpus but
 *      present in the problem — high overlap is a strong leak signal
 *      because common boilerplate doesn't dominate.
 *
 * Usage is read-only: given a benchmark problem and a set of corpus
 * documents (strings), we return per-doc scores + a flagged boolean
 * per configurable thresholds. Callers (e.g. humaneval / mbpp runners)
 * can skip or mark flagged items in the final report.
 */

const DEFAULT_SUBSTRING_LEN = 60;  // chars
const DEFAULT_NGRAM = 5;
const DEFAULT_JACCARD_FLAG = 0.3;
const DEFAULT_SUBSTRING_FLAG = true;

function normalise(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  if (typeof text !== 'string') return [];
  return (text.match(/[A-Za-z_][A-Za-z0-9_]*|[-+*/%=<>!&|^~?:]+|[(){}\[\],;.]/g) || []);
}

function ngramSet(tokens, n) {
  const s = new Set();
  for (let i = 0; i + n <= tokens.length; i++) {
    s.add(tokens.slice(i, i + n).join(' '));
  }
  return s;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Greedy match: does a run of ≥minLen characters from `needle`
 * appear in `haystack`? Case-insensitive, whitespace-normalised.
 * Returns the longest match found (short-circuit on first hit ≥ minLen).
 */
function longestSharedSubstring(needle, haystack, minLen = DEFAULT_SUBSTRING_LEN) {
  const a = normalise(needle).toLowerCase();
  const b = normalise(haystack).toLowerCase();
  if (!a || !b) return '';
  // Try windows of size minLen from the needle — cheap on short problems.
  for (let i = 0; i + minLen <= a.length; i++) {
    const window = a.slice(i, i + minLen);
    if (b.includes(window)) return window;
  }
  return '';
}

function corpusTokenFrequency(corpus) {
  const freq = new Map();
  for (const doc of corpus) {
    const seen = new Set();
    for (const tok of tokenize(doc)) {
      // document-frequency (how many docs contain the token at all)
      if (!seen.has(tok)) {
        seen.add(tok);
        freq.set(tok, (freq.get(tok) || 0) + 1);
      }
    }
  }
  return freq;
}

function rareTokens(problemText, corpusFreq, totalDocs, maxDf = 3) {
  const tokens = tokenize(problemText);
  const rare = new Set();
  for (const tok of tokens) {
    if (tok.length < 3) continue;              // ignore short ids/operators
    const df = corpusFreq.get(tok) || 0;
    if (df > 0 && df <= maxDf) rare.add(tok);
  }
  return rare;
}

function rareTokenOverlap(rareSet, doc) {
  if (rareSet.size === 0) return 0;
  const docTokens = new Set(tokenize(doc));
  let hit = 0;
  for (const t of rareSet) if (docTokens.has(t)) hit++;
  return hit / rareSet.size;
}

/**
 * Check a benchmark item against a corpus.
 *
 * @param {object} args
 * @param {object} args.problem       — { task_id, prompt?, text?, canonical_solution?, test? }
 * @param {string[]} args.corpus      — list of document strings
 * @param {number} [args.ngram=5]
 * @param {number} [args.substringLen=60]
 * @param {number} [args.jaccardFlag=0.3]
 * @returns {{
 *   taskId: string,
 *   flagged: boolean,
 *   reasons: string[],
 *   worstScore: number,
 *   hits: Array<{ docIndex, jaccardSol, jaccardTest, substringSol, substringTest, rareOverlap }>
 * }}
 */
function check({
  problem,
  corpus,
  ngram = DEFAULT_NGRAM,
  substringLen = DEFAULT_SUBSTRING_LEN,
  jaccardFlag = DEFAULT_JACCARD_FLAG,
}) {
  if (!problem || !Array.isArray(corpus) || corpus.length === 0) {
    return { taskId: problem?.task_id || '?', flagged: false, reasons: [], worstScore: 0, hits: [] };
  }
  const problemPrompt = problem.prompt || problem.text || '';
  const solution = problem.canonical_solution || '';
  const test = problem.test || (Array.isArray(problem.test_list) ? problem.test_list.join('\n') : '');

  const solGrams = ngramSet(tokenize(solution), ngram);
  const testGrams = ngramSet(tokenize(test), ngram);

  const corpusFreq = corpusTokenFrequency(corpus);
  const rareFromPrompt = rareTokens(problemPrompt, corpusFreq, corpus.length);

  const hits = [];
  const reasons = [];
  let worstScore = 0;

  for (let i = 0; i < corpus.length; i++) {
    const doc = corpus[i];
    const docGrams = ngramSet(tokenize(doc), ngram);
    const jacSol = solution ? jaccard(solGrams, docGrams) : 0;
    const jacTest = test ? jaccard(testGrams, docGrams) : 0;
    const subSol = solution ? longestSharedSubstring(solution, doc, substringLen) : '';
    const subTest = test ? longestSharedSubstring(test, doc, substringLen) : '';
    const rareOv = rareFromPrompt.size > 0 ? rareTokenOverlap(rareFromPrompt, doc) : 0;

    const docFlagged =
      jacSol >= jaccardFlag ||
      jacTest >= jaccardFlag ||
      (DEFAULT_SUBSTRING_FLAG && (subSol.length > 0 || subTest.length > 0)) ||
      rareOv >= 0.7;

    if (docFlagged) {
      if (subSol.length > 0) reasons.push(`doc[${i}]: shared substring ≥${substringLen} chars with canonical solution`);
      if (subTest.length > 0) reasons.push(`doc[${i}]: shared substring ≥${substringLen} chars with test block`);
      if (jacSol >= jaccardFlag) reasons.push(`doc[${i}]: solution n-gram jaccard ${jacSol.toFixed(2)} ≥ ${jaccardFlag}`);
      if (jacTest >= jaccardFlag) reasons.push(`doc[${i}]: test n-gram jaccard ${jacTest.toFixed(2)} ≥ ${jaccardFlag}`);
      if (rareOv >= 0.7) reasons.push(`doc[${i}]: rare-token overlap ${rareOv.toFixed(2)} ≥ 0.7`);
    }
    worstScore = Math.max(worstScore, jacSol, jacTest, rareOv);

    hits.push({
      docIndex: i,
      jaccardSol: jacSol,
      jaccardTest: jacTest,
      substringSol: subSol,
      substringTest: subTest,
      rareOverlap: rareOv,
    });
  }

  return {
    taskId: problem.task_id || '?',
    flagged: reasons.length > 0,
    reasons: reasons.slice(0, 20),
    worstScore,
    hits,
  };
}

/**
 * Convenience: scan a dataset against a corpus in one pass, return
 * only the flagged items so callers can drop them from the benchmark.
 */
function filterContaminated({ problems, corpus, ...opts }) {
  const flagged = [];
  for (const p of problems) {
    const r = check({ problem: p, corpus, ...opts });
    if (r.flagged) flagged.push(r);
  }
  return flagged;
}

module.exports = {
  check,
  filterContaminated,
  tokenize,
  ngramSet,
  jaccard,
  longestSharedSubstring,
  corpusTokenFrequency,
  rareTokens,
  rareTokenOverlap,
  DEFAULT_NGRAM,
  DEFAULT_SUBSTRING_LEN,
  DEFAULT_JACCARD_FLAG,
};
