'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildHierarchicalTree,
  detectMarkdownSections,
  splitParagraphs,
  splitSentences,
  classifyQuery,
  retrieveHierarchical,
  cosine,
  nestSections,
  flattenToNodes,
  fallbackSummarize,
  persistTree,
  loadTree,
} = require('../src/services/rag/hierarchical-chunker');

// ─── deterministic mocks ────────────────────────────────────────────────

// Toy embedding: bag-of-words vector over a fixed lexicon. Lets cosine
// behave deterministically without spinning up a model.
const LEXICON = [
  'pricing', 'price', 'cost', 'pay', 'payment',
  'feature', 'features', 'product',
  'security', 'auth', 'token',
  'install', 'setup', 'config', 'configure',
  'support', 'contact',
  'roadmap', 'future',
  'overview', 'introduction', 'summary',
  'document', 'section', 'chapter',
  'data', 'api', 'endpoint',
];

function bagEmbed(texts) {
  return texts.map(t => {
    const lower = String(t).toLowerCase();
    return LEXICON.map(w => {
      const re = new RegExp('\\b' + w + '\\b', 'g');
      return (lower.match(re) || []).length;
    });
  });
}

// Mock summarizer: prepend "[SUM]" + heading + first child summary so
// we can verify the bottom-up flow.
async function mockSummarize({ heading, childSummaries, text }) {
  const head = heading ? `[${heading}] ` : '';
  if (childSummaries && childSummaries.length) {
    return head + 'AGG:' + childSummaries.map(c => c.summary.slice(0, 24)).join(' | ');
  }
  return head + (text || '').slice(0, 80);
}

// ─── fixture documents ─────────────────────────────────────────────────

const DOC_MD = `# Acme Cloud Handbook

This handbook explains the Acme Cloud product, its features, and pricing.

## Overview

Acme Cloud is a managed platform with three core services: storage,
compute, and networking. Customers connect via the API.

## Pricing

The price for Storage is 0.02 per GB. Compute is billed per second.
Pay annually for 20% off.

### Enterprise pricing

Enterprise customers get custom pricing through their account manager
and may receive volume discounts on payment plans.

## Security

Security features include token-based auth, encrypted storage, and
isolated tenants. The auth flow uses short-lived tokens.

## Roadmap

The roadmap for next year focuses on a new API endpoint for batch
data export and a redesigned product onboarding.
`;

// ─── unit-level tests ───────────────────────────────────────────────────

test('detectMarkdownSections — splits by # / ## / ###', () => {
  const flat = detectMarkdownSections(DOC_MD);
  // Expect: doc title (#), Overview, Pricing, Enterprise pricing,
  // Security, Roadmap = 6 entries; preamble before # also present.
  const headings = flat.map(s => s.heading);
  assert.ok(headings.includes('Acme Cloud Handbook'));
  assert.ok(headings.includes('Overview'));
  assert.ok(headings.includes('Pricing'));
  assert.ok(headings.includes('Enterprise pricing'));
  assert.ok(headings.includes('Security'));
  assert.ok(headings.includes('Roadmap'));
});

test('splitParagraphs — splits on blank lines and respects maxChars', () => {
  const paras = splitParagraphs('A\n\nB\n\nC');
  assert.deepEqual(paras, ['A', 'B', 'C']);
  const long = 'x'.repeat(2500);
  const out = splitParagraphs(long, 1000);
  assert.equal(out.length, 3);
});

test('splitSentences — handles ., !, ? and CJK terminals', () => {
  const s = splitSentences('Hello world. This is a test! ¿Funciona? 你好。再见。');
  assert.ok(s.length >= 4);
  assert.equal(s[0], 'Hello world.');
});

test('cosine — sanity', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], []), 0);
});

test('classifyQuery — global keywords win', () => {
  assert.equal(classifyQuery('hazme un resumen del documento').mode, 'global');
  assert.equal(classifyQuery('what is the document about').mode, 'global');
  assert.equal(classifyQuery('tl;dr please').mode, 'global');
  assert.equal(classifyQuery('overview').mode, 'global');
  assert.equal(classifyQuery('what is the price of storage').mode, 'specific');
  assert.equal(classifyQuery('tell me about token auth').mode, 'specific');
  assert.equal(classifyQuery('').mode, 'specific');
});

test('classifyQuery — short meta-question detected as global', () => {
  assert.equal(classifyQuery('¿de qué trata?').mode, 'global');
  assert.equal(classifyQuery('what does it say').mode, 'global');
});

test('classifyQuery — intentClassifier hook', () => {
  const cls = classifyQuery('tell me everything', {
    intentClassifier: () => 'summarize',
  });
  assert.equal(cls.mode, 'global');
});

test('nestSections + flattenToNodes — tree shape mirrors document', () => {
  const flat = detectMarkdownSections(DOC_MD);
  const nested = nestSections(flat, { docTitle: 'doc', docText: DOC_MD });
  const { nodes, byId, rootId } = flattenToNodes(nested, { paragraphMaxChars: 1200 });

  // Root present, exactly one root.
  const roots = nodes.filter(n => n.level === 0);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].id, rootId);

  // Section nodes have role=section.
  const sections = nodes.filter(n => n.metadata?.role === 'section');
  assert.ok(sections.length >= 5);

  // Enterprise pricing should be a child of Pricing (not Acme Cloud
  // Handbook directly).
  const pricing = sections.find(s => s.heading === 'Pricing');
  const enterprise = sections.find(s => s.heading === 'Enterprise pricing');
  assert.ok(pricing && enterprise);
  assert.equal(enterprise.parentId, pricing.id);

  // Paragraph leaves attach to their section.
  const paras = nodes.filter(n => n.metadata?.role === 'paragraph');
  assert.ok(paras.length > 0);
  for (const p of paras) {
    const parent = byId.get(p.parentId);
    assert.ok(parent, `paragraph ${p.id} missing parent`);
    assert.equal(parent.metadata.role, 'section');
  }
});

// ─── integration: build + retrieve ──────────────────────────────────────

test('buildHierarchicalTree — bottom-up summaries propagate', async () => {
  const tree = await buildHierarchicalTree({
    text: DOC_MD,
    title: 'Acme Cloud Handbook',
    summarize: mockSummarize,
    embed: bagEmbed,
  });

  const root = tree.nodes.find(n => n.id === tree.rootId);
  assert.ok(root.summary, 'root has summary');
  // Root summary comes from AGG of its children (mock prefixes "AGG:").
  assert.match(root.summary, /AGG:/);

  // Sections have summaries.
  const pricingSec = tree.nodes.find(n => n.heading === 'Pricing');
  assert.ok(pricingSec.summary);
  assert.match(pricingSec.summary, /\[Pricing\]/);

  // Every node has an embedding of the right dimension.
  for (const n of tree.nodes) {
    assert.ok(Array.isArray(n.embedding), `node ${n.id} has embedding`);
    assert.equal(n.embedding.length, LEXICON.length);
  }

  assert.ok(tree.stats.sectionCount >= 5);
  assert.ok(tree.stats.paragraphCount >= 4);
});

test('retrieveHierarchical — global query returns root + level-1 summaries', async () => {
  const tree = await buildHierarchicalTree({
    text: DOC_MD, title: 'Acme', summarize: mockSummarize, embed: bagEmbed,
  });
  const out = retrieveHierarchical({
    tree, query: 'dame un resumen del documento', k: 4,
  });
  assert.equal(out.mode, 'global');
  assert.equal(out.results[0].role, 'root');
  // Should include at least one level-1 section summary.
  assert.ok(out.results.some(r => r.role === 'section' && r.level === 1));
});

test('retrieveHierarchical — specific query ranks leaves and stitches section context', async () => {
  const tree = await buildHierarchicalTree({
    text: DOC_MD, title: 'Acme', summarize: mockSummarize, embed: bagEmbed,
  });
  const [qVec] = bagEmbed(['what is the price of storage']);

  const out = retrieveHierarchical({
    tree, query: 'what is the price of storage',
    queryEmbedding: qVec, k: 5,
  });
  assert.equal(out.mode, 'specific');
  assert.ok(out.results.length > 0);

  // Top hit should come from a Pricing-related leaf (its parent
  // section heading should mention pricing).
  const top = out.results[0];
  assert.equal(top.role, 'paragraph');
  assert.ok(top.sectionContext, 'leaf carries section context');
  assert.match(top.sectionContext.heading.toLowerCase(), /pric/);
});

test('retrieveHierarchical — no embeddings → keyword fallback still works', async () => {
  const tree = await buildHierarchicalTree({
    text: DOC_MD, title: 'Acme', summarize: mockSummarize, // no embed
  });
  const out = retrieveHierarchical({
    tree, query: 'token auth security', k: 3,
  });
  assert.equal(out.mode, 'specific');
  assert.ok(out.results.length > 0);
  // Top hit should be from the Security section.
  assert.match(out.results[0].sectionContext.heading.toLowerCase(), /sec/);
});

test('buildHierarchicalTree — caller-provided sections (e.g. PDF outline) skip MD detection', async () => {
  const sections = [
    { level: 1, heading: 'Chapter A', body: 'Alpha content about pricing models.' },
    { level: 1, heading: 'Chapter B', body: 'Beta content about security tokens.' },
  ];
  const tree = await buildHierarchicalTree({
    text: '', title: 'Book', sections,
    summarize: mockSummarize, embed: bagEmbed,
  });
  const titles = tree.nodes
    .filter(n => n.metadata?.role === 'section')
    .map(n => n.heading);
  assert.deepEqual(titles, ['Chapter A', 'Chapter B']);
});

test('buildHierarchicalTree — empty text yields a root + (body) section', async () => {
  const tree = await buildHierarchicalTree({
    text: 'just one paragraph with no heading.',
    summarize: mockSummarize, embed: bagEmbed,
  });
  // Should not throw and should have at least a root + 1 section.
  assert.ok(tree.nodes.length >= 2);
  assert.ok(tree.nodes.some(n => n.level === 0));
});

test('summarize failure is degraded, not fatal', async () => {
  const flaky = async () => { throw new Error('LLM down'); };
  const tree = await buildHierarchicalTree({
    text: DOC_MD, summarize: flaky, embed: bagEmbed,
  });
  // Tree still builds, internal nodes get fallback summaries.
  const root = tree.nodes.find(n => n.id === tree.rootId);
  assert.ok(typeof root.summary === 'string'); // not undefined
});

test('fallbackSummarize — clips long text and ends with ellipsis', () => {
  const long = 'word '.repeat(200);
  const s = fallbackSummarize(long);
  assert.ok(s.length <= 322); // 320 + ellipsis
});

// ─── persistence (mocked Prisma) ────────────────────────────────────────

function mockPrisma() {
  const rows = [];
  return {
    rows,
    documentNode: {
      async createMany({ data }) {
        for (const r of data) {
          if (!rows.find(x => x.id === r.id)) rows.push({ ...r });
        }
        return { count: data.length };
      },
      async findMany({ where, orderBy }) {
        let out = rows.filter(r => r.fileId === where.fileId);
        if (orderBy?.ordinal === 'asc') out = out.slice().sort((a, b) => a.ordinal - b.ordinal);
        return out;
      },
    },
  };
}

test('persistTree + loadTree — round-trip preserves structure', async () => {
  const tree = await buildHierarchicalTree({
    text: DOC_MD, title: 'Acme', summarize: mockSummarize, embed: bagEmbed,
  });
  const prisma = mockPrisma();
  const { written } = await persistTree(prisma, { fileId: 'file-1', tree });
  assert.equal(written, tree.nodes.length);

  const loaded = await loadTree(prisma, { fileId: 'file-1' });
  assert.equal(loaded.nodes.length, tree.nodes.length);

  // Root parentId is null.
  const root = loaded.nodes.find(n => n.level === 0);
  assert.equal(root.parentId, null);

  // Pricing section still has Enterprise pricing as a child.
  const pricing = loaded.nodes.find(n => n.heading === 'Pricing');
  const enterprise = loaded.nodes.find(n => n.heading === 'Enterprise pricing');
  assert.equal(enterprise.parentId, pricing.id);
  assert.ok(pricing.childrenIds.includes(enterprise.id));

  // Specific retrieval works on a loaded tree.
  const [qVec] = bagEmbed(['storage pricing per GB']);
  const out = retrieveHierarchical({
    tree: loaded, query: 'storage pricing per GB',
    queryEmbedding: qVec, k: 3,
  });
  assert.equal(out.mode, 'specific');
  assert.ok(out.results.length > 0);
});
