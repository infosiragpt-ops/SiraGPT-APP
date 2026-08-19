/**
 * alignment-tax — measures capability regression from alignment changes.
 *
 * Ouyang et al. 2022 (§4.2): "During RLHF fine-tuning, we observe
 * performance regressions compared to GPT-3 on certain public NLP
 * datasets, notably SQuAD, DROP, HellaSwag, and WMT 2015 French to
 * English translation. This is an example of an 'alignment tax' since
 * our alignment procedure comes at the cost of lower performance on
 * certain tasks that we may care about."
 *
 * At inference time we can't eliminate the tax (we're not training),
 * but we CAN measure it: run the same task set through variantA
 * (baseline) and variantB (aligned), compare accuracy. A 10% drop on
 * closed QA after enabling best-of-N is a real signal the alignment
 * is hurting on some tasks.
 *
 * We ship mini curated sets (5 items per task type) that mirror the
 * paper's datasets in form:
 *   - Closed QA     (SQuAD-style: passage + question → span)
 *   - Open QA       (general knowledge)
 *   - Reading comp  (DROP-style: passage + multi-step reasoning)
 *   - Translation   (FR→EN single sentences)
 *   - Summarization (short passages with reference summaries)
 *
 * Scoring uses LLM-as-judge because exact-match against a reference
 * is too brittle for free-form outputs. The judge sees the task, the
 * reference answer, and the model's response, and decides:
 *   "matches" (≥ semantic equivalence to reference)
 *   "partial" (some correct content, missing or extra)
 *   "wrong"   (contradicts reference or off-topic)
 *
 * Aggregate: accuracy (matches / n) per task type + overall. A/B mode
 * compares two variants and reports the delta with 95% CI.
 */

const bootstrap = require('../stats/bootstrap');

const DEFAULT_MODEL = 'gpt-4o-mini';

// ─── Task items (mini versions of §4.2 benchmarks) ─────────────────────────

const ITEMS = {
  closed_qa: [
    {
      id: 'cqa-01',
      passage: 'The Mariana Trench, located in the western Pacific Ocean, is the deepest known part of any ocean. Its maximum known depth is about 10,994 meters (36,070 feet) at a small slot-shaped valley in its floor known as the Challenger Deep.',
      question: 'What is the maximum known depth of the Mariana Trench in meters?',
      reference: 'About 10,994 meters.',
    },
    {
      id: 'cqa-02',
      passage: 'The Rosetta Stone is a stele inscribed with a decree issued in 196 BC during the Ptolemaic dynasty on behalf of King Ptolemy V Epiphanes. The decree is written in three scripts: Egyptian hieroglyphs, Demotic script, and Ancient Greek.',
      question: 'In how many scripts is the Rosetta Stone\'s decree written?',
      reference: 'Three: Egyptian hieroglyphs, Demotic script, and Ancient Greek.',
    },
    {
      id: 'cqa-03',
      passage: 'Photosynthesis in plants requires six molecules of carbon dioxide and six of water to produce one molecule of glucose and six of oxygen, powered by light energy.',
      question: 'How many water molecules are used to produce one glucose molecule?',
      reference: 'Six water molecules.',
    },
    {
      id: 'cqa-04',
      passage: 'The Treaty of Westphalia, signed in 1648, ended the Thirty Years\' War and is often credited with establishing the principle of state sovereignty.',
      question: 'What principle is the Treaty of Westphalia credited with establishing?',
      reference: 'State sovereignty.',
    },
    {
      id: 'cqa-05',
      passage: 'The adult human body contains 206 bones. The smallest bone, the stapes in the middle ear, measures roughly 3 millimeters long, while the largest, the femur, averages about 45 centimeters in an adult.',
      question: 'Which is the smallest bone in the human body?',
      reference: 'The stapes, in the middle ear.',
    },
  ],

  open_qa: [
    { id: 'oqa-01', question: 'What is the capital of Australia?', reference: 'Canberra.' },
    { id: 'oqa-02', question: 'Who discovered penicillin?', reference: 'Alexander Fleming (1928).' },
    { id: 'oqa-03', question: 'What is the chemical symbol for gold?', reference: 'Au.' },
    { id: 'oqa-04', question: 'Which planet has the most moons as of 2024?', reference: 'Saturn, with over 140 confirmed moons.' },
    { id: 'oqa-05', question: 'In what year did the Berlin Wall fall?', reference: '1989.' },
  ],

  reading_comp: [
    {
      id: 'rc-01',
      passage: 'Alice bought three apples at 50 cents each and two oranges at 75 cents each. She paid with a five-dollar bill.',
      question: 'How much change did Alice receive?',
      reference: '$2.00. (Apples: 3 × $0.50 = $1.50. Oranges: 2 × $0.75 = $1.50. Total: $3.00. Change from $5.00: $2.00.)',
    },
    {
      id: 'rc-02',
      passage: 'A train leaves station A at 2:00 PM traveling at 60 mph. Another train leaves station B, 180 miles away from A, at 2:30 PM traveling toward A at 40 mph.',
      question: 'At what time do the trains meet?',
      reference: 'At 4:00 PM. (From 2:30 PM, train A has covered 30 miles; 150 miles remain between them; closing speed 100 mph; 1.5 hours; meet at 4:00 PM.)',
    },
    {
      id: 'rc-03',
      passage: 'The first 10 positive integers sum to 55. The first 10 positive even integers sum to 110.',
      question: 'What is the sum of the first 10 positive ODD integers?',
      reference: '100. (Sum of first 10 odd integers = 1 + 3 + 5 + ... + 19 = n² = 100.)',
    },
    {
      id: 'rc-04',
      passage: 'A rectangular garden is 12 meters long and 8 meters wide. A path 1 meter wide runs around the entire inside of the garden perimeter.',
      question: 'What is the area of the interior region (the part NOT covered by the path)?',
      reference: '60 square meters. (Interior: (12 - 2) × (8 - 2) = 10 × 6 = 60 m².)',
    },
    {
      id: 'rc-05',
      passage: 'The team played 20 games. They won 60% of them. They lost the rest except for 2 games that ended in a tie.',
      question: 'How many games did the team lose?',
      reference: '6 losses. (Wins: 20 × 0.6 = 12. Non-wins: 8. Ties: 2. Losses: 8 - 2 = 6.)',
    },
  ],

  translation_fr_en: [
    { id: 'tr-01', source: 'Bonjour, comment allez-vous aujourd\'hui ?', reference: 'Hello, how are you today?' },
    { id: 'tr-02', source: 'Le chat dort sur le canapé.', reference: 'The cat is sleeping on the couch.' },
    { id: 'tr-03', source: 'Je voudrais une tasse de café, s\'il vous plaît.', reference: 'I would like a cup of coffee, please.' },
    { id: 'tr-04', source: 'Elle a étudié la médecine pendant sept ans.', reference: 'She studied medicine for seven years.' },
    { id: 'tr-05', source: 'Le train pour Paris part à dix heures du matin.', reference: 'The train to Paris leaves at ten in the morning.' },
  ],

  summarization: [
    {
      id: 'sum-01',
      passage: 'The Fair Labor Standards Act (FLSA), passed in 1938 in the United States, established a federal minimum wage, overtime pay for hours worked beyond 40 per week, and prohibitions on most child labor. Initial coverage was limited, but amendments expanded its reach over decades to include most private-sector workers.',
      reference: 'The 1938 FLSA created a federal minimum wage, overtime pay rules, and child labor protections, with coverage later expanded by amendments.',
    },
    {
      id: 'sum-02',
      passage: 'Mitochondria, often called the powerhouse of the cell, generate most of the cell\'s supply of ATP through oxidative phosphorylation. They also play roles in signaling, cellular differentiation, and apoptosis. Unusually for an organelle, mitochondria contain their own DNA, inherited maternally in most species.',
      reference: 'Mitochondria produce most of a cell\'s ATP via oxidative phosphorylation, contribute to signaling and apoptosis, and uniquely carry their own maternally-inherited DNA.',
    },
    {
      id: 'sum-03',
      passage: 'The 2008 financial crisis originated in the US subprime mortgage market and triggered a global recession. Key contributors included lax lending standards, widespread securitization of risky mortgages, and insufficient regulatory oversight. Major investment banks failed or were absorbed, and governments launched large-scale interventions to stabilize markets.',
      reference: 'The 2008 crisis began in US subprime mortgages, caused by lax lending, risky securitization, and weak regulation; it led to bank failures and massive government interventions.',
    },
    {
      id: 'sum-04',
      passage: 'Apollo 11, launched on July 16, 1969, was the first mission to land humans on the Moon. Neil Armstrong and Buzz Aldrin descended to the lunar surface on July 20, while Michael Collins orbited above in the command module. They collected about 21.5 kg of lunar material and returned safely on July 24.',
      reference: 'Apollo 11 (July 1969) landed Armstrong and Aldrin on the Moon while Collins orbited; the crew collected ~21.5 kg of samples and returned safely on July 24.',
    },
    {
      id: 'sum-05',
      passage: 'The concept of technical debt describes the implied future cost of choosing an easier or faster solution now over a better approach that would take longer. While some debt is strategic and manageable, accumulated debt slows development, increases bug density, and can make systems brittle to change.',
      reference: 'Technical debt is the future cost of shortcuts in software; while some is strategic, accumulated debt slows development and increases brittleness.',
    },
  ],
};

// ─── Judge ─────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You evaluate whether a model's response matches a reference answer on a capability task. You rate one of:

  "matches"  — the response gives the same essential answer as the reference (paraphrase OK, numerical accuracy required)
  "partial"  — some correct content but missing key information, or partially wrong
  "wrong"    — factually incorrect, contradictory, or off-topic

Reply with STRICT JSON:
{"verdict": "matches" | "partial" | "wrong", "confidence": <0-1>, "reasoning": "<one sentence>"}

Rules:
- For numerical questions, only "matches" if the number is correct (rounding within natural precision is fine).
- For translations, "matches" if meaning is preserved even with different phrasing.
- For summarization, "matches" if all key facts from the reference appear in the response.
- When uncertain between partial and matches, pick partial.`;

async function judgeItem({ openai, taskType, item, response, model = DEFAULT_MODEL }) {
  if (!openai) return { verdict: 'partial', confidence: 0, reasoning: 'no LLM' };
  try {
    let body;
    if (taskType === 'translation_fr_en') {
      body = `SOURCE (French): ${item.source}\nREFERENCE TRANSLATION: ${item.reference}\nMODEL RESPONSE: ${String(response).slice(0, 3000)}`;
    } else if (taskType === 'summarization') {
      body = `PASSAGE: ${item.passage}\n\nREFERENCE SUMMARY: ${item.reference}\n\nMODEL SUMMARY: ${String(response).slice(0, 3000)}`;
    } else if (item.passage) {
      body = `PASSAGE: ${item.passage}\n\nQUESTION: ${item.question}\nREFERENCE ANSWER: ${item.reference}\nMODEL RESPONSE: ${String(response).slice(0, 3000)}`;
    } else {
      body = `QUESTION: ${item.question}\nREFERENCE ANSWER: ${item.reference}\nMODEL RESPONSE: ${String(response).slice(0, 3000)}`;
    }
    const resp = await openai.chat.completions.create({
      model, temperature: 0, max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user',   content: body },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    const v = ['matches', 'partial', 'wrong'].includes(parsed?.verdict) ? parsed.verdict : 'partial';
    return {
      verdict: v,
      confidence: typeof parsed?.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      reasoning: String(parsed?.reasoning || '').slice(0, 300),
    };
  } catch (err) {
    console.warn('[alignment-tax] judge failed:', err.message);
    return { verdict: 'partial', confidence: 0, reasoning: `judge error: ${err.message}` };
  }
}

// ─── Prompt builders — adapters from task item to agent input ──────────────

function buildPrompt(taskType, item) {
  if (taskType === 'closed_qa') {
    return `Read the passage and answer the question using only information from the passage.\n\nPASSAGE: ${item.passage}\n\nQUESTION: ${item.question}`;
  }
  if (taskType === 'open_qa') {
    return item.question;
  }
  if (taskType === 'reading_comp') {
    return `Read the passage and answer the question, showing your reasoning briefly.\n\nPASSAGE: ${item.passage}\n\nQUESTION: ${item.question}`;
  }
  if (taskType === 'translation_fr_en') {
    return `Translate the following French sentence into English. Reply with the translation only.\n\n${item.source}`;
  }
  if (taskType === 'summarization') {
    return `Summarise the following passage in one concise sentence that captures the key facts.\n\nPASSAGE: ${item.passage}`;
  }
  throw new Error(`alignment-tax: unknown task type "${taskType}"`);
}

// ─── Single-variant run ────────────────────────────────────────────────────

async function runSingle({ openai, runAgent, items, model = DEFAULT_MODEL }) {
  if (typeof runAgent !== 'function') throw new Error('alignment-tax: runAgent required');
  const set = items || ITEMS;

  const allRuns = [];
  const byTaskType = {};
  for (const taskType of Object.keys(set)) {
    const taskRuns = [];
    for (const item of set[taskType]) {
      const prompt = buildPrompt(taskType, item);
      let response;
      try { response = await runAgent(prompt, taskType, item.id); }
      catch (err) { response = { error: err.message || String(err) }; }
      const text = typeof response === 'string' ? response : JSON.stringify(response);
      const v = await judgeItem({ openai, taskType, item, response: text, model });
      const run = { taskType, id: item.id, prompt, response, ...v };
      taskRuns.push(run);
      allRuns.push(run);
    }
    const matches = taskRuns.filter(r => r.verdict === 'matches').length;
    const partials = taskRuns.filter(r => r.verdict === 'partial').length;
    const wrongs = taskRuns.filter(r => r.verdict === 'wrong').length;
    const n = taskRuns.length;
    // Accuracy = matches / n ; "generous accuracy" gives partial half-credit.
    byTaskType[taskType] = {
      n,
      accuracy: n === 0 ? 0 : matches / n,
      generousAccuracy: n === 0 ? 0 : (matches + partials * 0.5) / n,
      matches, partials, wrongs,
      // Keep ci95 as a [lo, hi] array — callers want a 2-element tuple,
      // not the wrapper object. The full bootstrap result lives on the
      // private _ciReport field for advanced callers.
      ci95: bootstrap.rateCi(taskRuns.map(r => r.verdict === 'matches' ? 1 : 0)).ci95,
    };
  }

  const totalMatches = allRuns.filter(r => r.verdict === 'matches').length;
  const n = allRuns.length;
  return {
    n,
    accuracy: n === 0 ? 0 : totalMatches / n,
    ci95: bootstrap.rateCi(allRuns.map(r => r.verdict === 'matches' ? 1 : 0)).ci95,
    byTaskType,
    runs: allRuns,
  };
}

// ─── A/B mode — the KEY use case ──────────────────────────────────────────

/**
 * Compare two variants (baseline vs aligned) on the same capability set.
 * Reports per-task-type accuracy delta with bootstrap CI. A negative
 * delta on any task type = alignment regressed capability there.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {function} args.runA — baseline agent
 * @param {function} args.runB — challenger (usually aligned)
 * @param {Array<object>} [args.items] — override default ITEMS
 */
async function runAB({ openai, runA, runB, items, model = DEFAULT_MODEL }) {
  if (typeof runA !== 'function' || typeof runB !== 'function') {
    throw new Error('alignment-tax.runAB: runA and runB required');
  }
  const [a, b] = await Promise.all([
    runSingle({ openai, runAgent: runA, items, model }),
    runSingle({ openai, runAgent: runB, items, model }),
  ]);

  // Per-task-type deltas.
  const deltas = {};
  for (const taskType of Object.keys(a.byTaskType)) {
    const aAcc = a.byTaskType[taskType].accuracy;
    const bAcc = b.byTaskType[taskType].accuracy;
    deltas[taskType] = {
      baseline: aAcc,
      challenger: bAcc,
      delta: bAcc - aAcc,
      // Regression flag: challenger < baseline by > 5% → measurable regression
      regressed: (aAcc - bAcc) > 0.05,
    };
  }

  return {
    baseline: a,
    challenger: b,
    overallDelta: b.accuracy - a.accuracy,
    byTaskType: deltas,
    regressedTaskTypes: Object.entries(deltas).filter(([, v]) => v.regressed).map(([k]) => k),
  };
}

module.exports = {
  runSingle,
  runAB,
  buildPrompt,
  judgeItem,
  ITEMS,
  JUDGE_SYSTEM,
};
