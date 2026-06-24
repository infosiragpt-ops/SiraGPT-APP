/**
 * Tests for visual-media-tools.js
 *
 * Tests deterministic helper functions and SVG generation,
 * mocking external services (ai-service, code-sandbox).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Stub external deps before loading the module ──────────────────
const SERVICE_DIR = path.resolve(__dirname, '../src/services');
const AGENTS_DIR = path.resolve(__dirname, '../src/services/agents');

// Stub openai first
require.cache[require.resolve('openai')] = {
  exports: class FakeOpenAI {
    constructor() {
      this.chat = { completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }] }) } };
      this.embeddings = { create: async () => ({ data: [{ embedding: new Float32Array(8) }] }) };
    }
  },
};

// Stub ai-service
require.cache[require.resolve(path.join(SERVICE_DIR, 'ai-service'))] = {
  exports: {
    generateImage: async () => 'fakeBase64' + 'A'.repeat(100),
  },
};

// Stub the multi-provider image engine (generate_image / edit_image route
// through it now) so tests never hit a real provider.
require.cache[require.resolve(path.join(SERVICE_DIR, 'media/image-engine'))] = {
  exports: {
    generateImage: async () => ({
      ok: true,
      images: [{ b64: Buffer.from('fake-image-bytes').toString('base64'), mime: 'image/png' }],
      provider: 'openai',
      model: 'gpt-image-2',
      attempts: [{ provider: 'openai', model: 'gpt-image-2', ok: true }],
    }),
    editImage: async () => ({
      ok: true,
      images: [{ b64: Buffer.from('fake-edited-bytes').toString('base64'), mime: 'image/png' }],
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      attempts: [{ provider: 'gemini', model: 'gemini-2.5-flash-image', ok: true }],
    }),
  },
};

// Stub viz-generator
require.cache[require.resolve(path.join(SERVICE_DIR, 'viz-generator'))] = {
  exports: {},
};

// Stub code-sandbox (needed by both task-tools and visual-media-tools)
require.cache[require.resolve(path.join(AGENTS_DIR, 'code-sandbox'))] = {
  exports: {
    run: async ({ language, source }) => {
      if (source && source.includes('mmdc')) {
        return { ok: false, stdout: '', stderr: 'mermaid CLI not available' };
      }
      return { ok: true, stdout: 'done', stderr: '', exitCode: 0 };
    },
  },
};

// Stub agent-task-persistence for task-tools
require.cache[require.resolve(path.join(AGENTS_DIR, 'agent-task-persistence'))] = {
  exports: { saveSnapshot: async () => {}, loadSnapshot: async () => null },
};

// Set up artifact dir
const ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-test-'));
process.env.AGENT_ARTIFACT_DIR = ARTIFACT_DIR;

// Load visual-media-tools (lazy, after stubs are in cache)
const { VISUAL_MEDIA_TOOLS, __test_helpers: VIS_INTERNAL } = require(path.join(AGENTS_DIR, 'visual-media-tools'));

function tool(name) { return VISUAL_MEDIA_TOOLS.find(t => t.name === name); }

function fakeCtx(overrides = {}) {
  const events = [];
  return {
    userId: 'test-user', chatId: 'test-chat',
    signal: new AbortController().signal,
    onEvent: (e) => { events.push(e); },
    ...overrides,
    _events: events,
  };
}

// Helper to find the actual artifact file on disk.
// saveArtifact stores as ${id}-${filename} inside AGENT_ARTIFACT_DIR.
function findArtifactFile(result) {
  if (result.path && fs.existsSync(result.path)) return result.path;
  const dirs = [ARTIFACT_DIR, process.env.AGENT_ARTIFACT_DIR,
    path.join(process.cwd(), 'uploads', 'agent-artifacts')];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const match = fs.readdirSync(dir).find(f => f.endsWith(`-${result.filename}`));
    if (match) return path.join(dir, match);
  }
  return null;
}

function assertArtifact(result) {
  const fp = findArtifactFile(result);
  assert.ok(fp, `artifact for ${result.filename} not found in ${ARTIFACT_DIR}`);
  assert.ok(fs.statSync(fp).size > 0, `artifact ${result.filename} is empty`);
  return fp;
}

// ── generate_video ───────────────────────────────────────────────

test('generate_video: fallback storyboard SVG', async () => {
  const genVideo = tool('generate_video');
  assert.ok(genVideo);
  const orig = process.env.VIDEO_API_URL;
  delete process.env.VIDEO_API_URL;
  try {
    const ctx = fakeCtx();
    const r = await genVideo.execute({
      prompt: 'A sunny beach with waves crashing on the shore',
      title: 'Beach Day', duration: 10, aspectRatio: '16:9', style: 'realistic',
    }, ctx);
    assert.equal(r.ok, true, 'storyboard should succeed');
    assert.equal(r.storyboard, true);
    assert.ok(r.filename);
    assert.ok(r.downloadUrl);
    assert.ok(r.scenes > 0, 'should have scenes');
    const fp = assertArtifact(r);
    const content = fs.readFileSync(fp, 'utf8');
    assert.ok(content.includes('<svg'));
    assert.ok(content.includes('Escena'));
  } finally {
    if (orig) process.env.VIDEO_API_URL = orig;
  }
});

// ── generate_image ───────────────────────────────────────────────

test('generate_image: valid params', async () => {
  const genImg = tool('generate_image');
  assert.ok(genImg);
  const r = await genImg.execute({ prompt: 'A red apple on wood', style: 'realistic', aspectRatio: 'square' }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.png'));
  assert.equal(r.mime, 'image/png');
  assertArtifact(r);
});

test('generate_image: minimal context', async () => {
  const r = await tool('generate_image').execute({ prompt: 'Test' }, {});
  assert.equal(r.ok, true);
  assert.ok(r.downloadUrl);
});

// ── create_chart ─────────────────────────────────────────────────

test('create_chart: bar chart SVG', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'bar', title: 'Test Chart',
    labels: ['A', 'B', 'C'],
    datasets: [{ label: 'Series 1', data: [10, 20, 30] }],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.svg'));
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('Test Chart'));
});

test('create_chart: histogram renders as bars (rect), not a line', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'histogram', title: 'Distribution',
    labels: ['0-10', '10-20', '20-30'],
    datasets: [{ label: 'freq', data: [5, 12, 8] }],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  const c = fs.readFileSync(assertArtifact(r), 'utf8');
  // Bars, not a line/area path connecting the points.
  assert.ok(c.includes('<rect'), 'histogram should render rect bars');
});

test('create_chart: pie chart', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'pie', title: 'Pie', labels: ['A', 'B'], datasets: [{ label: 'V', data: [60, 40] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assertArtifact(r);
});

test('create_chart: multi-series line chart', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'line', title: 'Multi', labels: ['Q1', 'Q2', 'Q3', 'Q4'],
    datasets: [{ label: 'Sales', data: [100, 150, 130, 200] }, { label: 'Costs', data: [80, 90, 110, 120] }],
    xLabel: 'Q', yLabel: '$',
  }, fakeCtx());
  assert.equal(r.ok, true);
});

test('create_chart: single data point', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'bar', title: 'Single', labels: ['Only'], datasets: [{ label: 'V', data: [42] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
});

test('create_chart: empty labels', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'bar', title: 'Empty', labels: [], datasets: [{ label: 'N', data: [] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
});

test('create_chart: zero values', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'bar', title: 'Zeros', labels: ['A','B'], datasets: [{ label: 'V', data: [0, 0] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
});

test('create_chart: pie with single 100% slice renders a full circle', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'pie', title: 'Whole', labels: ['Only'],
    datasets: [{ label: 'V', data: [42] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  // Must contain a real circle, not an empty arc that renders nothing.
  assert.ok(/<circle\s[^>]*r="\d/.test(c), 'expected a <circle> for full-circle pie');
});

test('create_chart: pie skips zero-value slices', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'pie', title: 'WithZero', labels: ['A', 'B', 'C'],
    datasets: [{ label: 'V', data: [50, 0, 50] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  // Two real slices (paths), zero slice does not render a wedge.
  const paths = c.match(/<path d="M /g) || [];
  assert.ok(paths.length === 2, `expected 2 wedges, got ${paths.length}`);
});

test('create_chart: donut', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'donut', title: 'Donut', labels: ['A','B','C'], datasets: [{ label: 'V', data: [30,30,40] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
});

test('create_chart: horizontal bar', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'horizontal_bar', title: 'H-Bar', labels: ['Long Label','Short'], datasets: [{ label: 'V', data: [5, 15] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
});

test('create_chart: funnel', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'funnel', title: 'Sales Funnel',
    labels: ['Visits', 'Signups', 'Trials', 'Customers'],
    datasets: [{ label: 'Users', data: [10000, 4000, 1500, 600] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('Visits'));
  assert.ok(c.includes('Sales Funnel'));
});

test('create_chart: gauge', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'gauge', title: 'CPU Usage',
    labels: ['Usage'],
    datasets: [{ label: 'Now', data: [72, 100] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('CPU Usage'));
  assert.ok(c.includes('72'));
});

test('create_chart: heatmap', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'heatmap', title: 'Activity',
    labels: ['Mon','Tue','Wed','Thu','Fri'],
    datasets: [
      { label: '9am', data: [1, 2, 3, 4, 5] },
      { label: '12pm', data: [5, 4, 3, 2, 1] },
      { label: '3pm', data: [2, 4, 6, 8, 10] },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('Activity'));
  assert.ok(c.includes('9am'));
});

test('create_chart: treemap', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'treemap', title: 'Market Share',
    labels: ['Apple','Google','MS','Amazon','Other'],
    datasets: [{ label: '%', data: [35, 25, 20, 12, 8] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('Apple'));
});

test('create_chart: waterfall', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'waterfall', title: 'P&L Bridge',
    labels: ['Start', 'Revenue', 'COGS', 'OpEx', 'End'],
    datasets: [{ label: 'Δ', data: [100, 50, -20, -15, 115] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('P&amp;L Bridge'));
});

// ── create_timeline ──────────────────────────────────────────────

test('create_timeline: horizontal events', async () => {
  const tl = tool('create_timeline');
  assert.ok(tl);
  const r = await tl.execute({
    title: 'Product Roadmap 2026',
    events: [
      { date: 'Q1 2026', title: 'Beta Launch', description: 'Limited beta release', category: 'launch' },
      { date: 'Q2 2026', title: 'Public Release', description: 'GA for all customers', category: 'milestone' },
      { date: 'Q3 2026', title: 'Mobile App', description: 'iOS and Android', color: '#10B981' },
      { date: 'Q4 2026', title: 'Enterprise Tier', description: 'Advanced features' },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.svg'));
  assert.equal(r.events, 4);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('Beta Launch'));
  assert.ok(c.includes('Q1 2026'));
});

test('create_timeline: vertical orientation', async () => {
  const r = await tool('create_timeline').execute({
    title: 'Company History',
    events: [
      { date: '2020', title: 'Founded' },
      { date: '2022', title: 'Series A', description: '$10M raised' },
      { date: '2024', title: 'Series B' },
    ],
    orientation: 'vertical',
    theme: 'modern',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.orientation, 'vertical');
});

test('create_timeline: empty events fails gracefully', async () => {
  const r = await tool('create_timeline').execute({
    title: 'Empty', events: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
});

test('create_timeline: a hostile event color cannot break out of the SVG fill', async () => {
  // Regression: ev.color was interpolated raw into fill="..."; a value with a
  // quote could break the attribute. safeColor() now falls back to the palette.
  const r = await tool('create_timeline').execute({
    title: 'T',
    events: [{ date: '2026', title: 'E', color: '"><script>alert(1)</script>' }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const c = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(!c.includes('<script>alert(1)</script>'), 'hostile color must not inject markup');
  assert.ok(!c.includes('fill="">'), 'attribute must not be broken open');
});

// ── create_kanban_board ──────────────────────────────────────────

test('create_kanban_board: 3-column board', async () => {
  const kb = tool('create_kanban_board');
  assert.ok(kb);
  const r = await kb.execute({
    title: 'Sprint 12',
    columns: [
      { name: 'To Do', cards: [
        { title: 'Design API spec', priority: 'high', assignee: 'Ana', tags: ['backend'] },
        { title: 'Wireframes', priority: 'medium' },
      ] },
      { name: 'In Progress', cards: [
        { title: 'Implement auth', description: 'OAuth + JWT refresh tokens', priority: 'critical', assignee: 'Bob' },
      ] },
      { name: 'Done', cards: [
        { title: 'Setup CI', priority: 'low' },
      ] },
    ],
    theme: 'light',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.svg'));
  assert.equal(r.columns, 3);
  assert.equal(r.cards, 4);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('Sprint 12'));
  assert.ok(c.includes('To Do'));
  assert.ok(c.includes('Design API spec'));
});

test('create_kanban_board: empty columns fails', async () => {
  const r = await tool('create_kanban_board').execute({ title: 'Empty', columns: [] }, fakeCtx());
  assert.equal(r.ok, false);
});

test('create_comparison_table: plan comparison', async () => {
  const ct = tool('create_comparison_table');
  assert.ok(ct);
  const r = await ct.execute({
    title: 'Plan Comparison',
    columns: ['Free', 'Pro', 'Enterprise'],
    rows: [
      { feature: 'Users', values: ['1', '10', 'Unlimited'] },
      { feature: 'API Access', values: [false, true, true] },
      { feature: 'Priority Support', values: [false, false, true], highlight: true },
      { feature: 'Storage', values: ['1GB', '50GB', '500GB'] },
    ],
    highlightColumn: 1,
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.columns, 3);
  assert.equal(r.rows, 4);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('Plan Comparison'));
  assert.ok(c.includes('Free'));
  assert.ok(c.includes('RECOMENDADO'));
});

// ── create_process_flow ──────────────────────────────────────────

test('create_process_flow: horizontal arrows', async () => {
  const pf = tool('create_process_flow');
  assert.ok(pf);
  const r = await pf.execute({
    title: 'Customer Onboarding',
    steps: [
      { label: 'Sign Up', description: 'User creates account' },
      { label: 'Verify', description: 'Email confirmation', icon: 'check' },
      { label: 'Setup', description: 'Configure preferences' },
      { label: 'Activate', description: 'First login complete', color: '#10B981' },
    ],
    style: 'arrows',
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.steps, 4);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('Customer Onboarding'));
  assert.ok(c.includes('Sign Up'));
});

test('create_process_flow: chevron style', async () => {
  const r = await tool('create_process_flow').execute({
    title: 'Pipeline',
    steps: [{ label: 'Build' }, { label: 'Test' }, { label: 'Deploy' }],
    style: 'chevrons',
  }, fakeCtx());
  assert.equal(r.ok, true);
});

test('create_process_flow: vertical orientation', async () => {
  const r = await tool('create_process_flow').execute({
    title: 'Recipe',
    steps: [
      { label: 'Mix ingredients', description: 'Combine dry and wet' },
      { label: 'Bake', description: '350°F for 30 min' },
      { label: 'Cool', description: 'Let rest 10 min' },
    ],
    orientation: 'vertical',
    theme: 'warm',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.orientation, 'vertical');
});

test('create_process_flow: empty steps fails', async () => {
  const r = await tool('create_process_flow').execute({ title: 'X', steps: [] }, fakeCtx());
  assert.equal(r.ok, false);
});

test('create_comparison_table: empty rows fails', async () => {
  const r = await tool('create_comparison_table').execute({
    title: 'X', columns: ['A'], rows: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
});

test('create_kanban_board: dark theme, single column', async () => {
  const r = await tool('create_kanban_board').execute({
    title: 'Backlog',
    columns: [{ name: 'Backlog', cards: [{ title: 'Item 1' }, { title: 'Item 2' }] }],
    theme: 'dark',
  }, fakeCtx());
  assert.equal(r.ok, true);
});

// ── create_organigram ────────────────────────────────────────────

test('create_organigram: hierarchy SVG', async () => {
  const org = tool('create_organigram');
  assert.ok(org);
  const r = await org.execute({
    title: 'Acme Corp',
    root: {
      name: 'CEO', role: 'Chief',
      children: [{ name: 'CTO', role: 'Tech', children: [{ name: 'Dev Lead' }, { name: 'QA Lead' }] }, { name: 'CFO', role: 'Finance' }],
    },
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.svg'));
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('CEO'));
  assert.ok(c.includes('CTO'));
});

test('create_organigram: single node', async () => {
  const r = await tool('create_organigram').execute({
    title: 'Solo', root: { name: 'Only Me', role: 'Founder' },
  }, fakeCtx());
  assert.equal(r.ok, true);
});

test('create_organigram: supports structure alias', async () => {
  const r = await tool('create_organigram').execute({
    title: 'Alias', structure: { name: 'Boss', role: 'Head' },
  }, fakeCtx());
  assert.equal(r.ok, true);
});

// ── create_mermaid_diagram ───────────────────────────────────────

test('create_mermaid_diagram: fallback HTML+SVG', async () => {
  const mmd = tool('create_mermaid_diagram');
  assert.ok(mmd);
  const ctx = fakeCtx();
  const r = await mmd.execute({
    diagramType: 'flowchart', title: 'Login Flow',
    definition: 'A[Start] --> B{Valid?}\nB -->|Yes| C[Success]\nB -->|No| D[Error]',
  }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.svg'));
  const htmlEvents = ctx._events.filter(e => e.type === 'file_artifact');
  assert.ok(htmlEvents.length >= 1, 'should emit file_artifact events');
});

test('create_mermaid_diagram: sequence diagram', async () => {
  const r = await tool('create_mermaid_diagram').execute({
    diagramType: 'sequenceDiagram', title: 'API Call',
    definition: 'Client->>Server: GET /users\nServer-->>Client: 200 OK',
  }, fakeCtx());
  assert.equal(r.ok, true);
});

// ── create_infographic_svg ───────────────────────────────────────

test('create_infographic_svg: professional infographic', async () => {
  const info = tool('create_infographic_svg');
  assert.ok(info);
  const r = await info.execute({
    title: 'Annual Report 2024',
    sections: [
      { type: 'stat', heading: 'Revenue', content: '$2.4M', subtext: '+18% YoY' },
      { type: 'list', heading: 'Achievements', content: ['Expanded to 3 markets', '40% growth'] },
      { type: 'text', heading: 'Outlook', content: 'Continued expansion with AI.' },
    ],
    theme: 'professional', width: 600,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.svg'));
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('Annual Report'));
});

test('create_infographic_svg: empty sections', async () => {
  const r = await tool('create_infographic_svg').execute({ title: 'Empty', sections: [] }, fakeCtx());
  assert.equal(r.ok, true);
});

test('create_infographic_svg: new icons render', async () => {
  const r = await tool('create_infographic_svg').execute({
    title: 'Security & Growth',
    sections: [
      { type: 'text', heading: 'Security', content: 'End-to-end encrypted', icon: 'lock' },
      { type: 'stat', heading: 'Revenue', content: '$5M', icon: 'money' },
      { type: 'text', heading: 'Trend', content: 'Growing', icon: 'growth' },
      { type: 'text', heading: 'Risk', content: 'Mitigated', icon: 'warning' },
      { type: 'text', heading: 'Comms', content: 'Email integrated', icon: 'mail' },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
});

test('create_infographic_svg: rich section types (stat/list/quote/progress)', async () => {
  const r = await tool('create_infographic_svg').execute({
    title: 'Q4 Highlights',
    sections: [
      { type: 'stat', heading: 'Revenue', content: '$2.4M', subtext: 'Up 18% YoY', icon: 'chart' },
      { type: 'list', heading: 'Wins', content: ['Launched in EU', 'Doubled team', 'Closed Series B'] },
      { type: 'quote', heading: 'Customer Voice', content: 'Best product in its category — saved us hundreds of hours.' },
      { type: 'progress', heading: 'Goals', content: [
        { label: 'Revenue', percent: 95 },
        { label: 'Hiring', percent: 70 },
        { label: 'Retention', percent: 88 },
      ] },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('Q4 Highlights'));
  assert.ok(c.includes('$2.4M'));
  assert.ok(c.includes('Launched in EU'));
  assert.ok(c.includes('95%'));
});

test('create_infographic_svg: heading without content still renders', async () => {
  const r = await tool('create_infographic_svg').execute({
    title: 'Headings only',
    sections: [{ heading: 'Just a heading' }],
  }, fakeCtx());
  assert.equal(r.ok, true);
});

// ── create_dashboard_html ────────────────────────────────────────

test('create_dashboard_html: interactive HTML', async () => {
  const dash = tool('create_dashboard_html');
  assert.ok(dash);
  const r = await dash.execute({
    title: 'Sales Dashboard',
    metrics: [
      { label: 'Revenue', value: '$1.2M', change: '+12%' },
      { label: 'Users', value: '8,450', change: '+5.2%' },
    ],
    charts: [
      { type: 'bar', title: 'Monthly', labels: ['Jan','Feb','Mar'], datasets: [{ label: 'Sales', data: [200,300,400] }] },
      { type: 'line', title: 'Trend', labels: ['Q1','Q2','Q3'], datasets: [{ label: 'Growth', data: [5,12,18] }] },
    ],
    theme: 'light',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.html'));
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.includes('Sales Dashboard'));
  assert.ok(c.includes('chart.js'), 'should reference chart.js library');
  assert.ok(c.includes('Revenue'));
});

test('create_dashboard_html: dark theme', async () => {
  const r = await tool('create_dashboard_html').execute({
    title: 'KPI', metrics: [{ label: 'Uptime', value: '99.9%' }],
    charts: [{ type: 'bar', title: 'Reliability', labels: ['Jan'], datasets: [{ label: 'U', data: [99.9] }] }],
    theme: 'dark',
  }, fakeCtx());
  assert.equal(r.ok, true);
  const fp = assertArtifact(r);
  assert.ok(fs.readFileSync(fp, 'utf8').length > 200);
});

test('create_dashboard_html: no charts', async () => {
  const r = await tool('create_dashboard_html').execute({
    title: 'Minimal', metrics: [{ label: 'Test', value: '42' }], charts: [],
  }, fakeCtx());
  assert.equal(r.ok, true);
});

test('create_dashboard_html: hostile metric/dataset color cannot break out of HTML/JS', async () => {
  // Regression: m.color was interpolated raw into a style="" attribute and
  // ds.color raw into a JS string literal. A safeColor() gate now falls back
  // to the theme color for any non-hex/rgb value.
  const r = await tool('create_dashboard_html').execute({
    title: 'XSS Probe',
    metrics: [{ label: 'x', value: '1', color: '"><script>alert(1)</script>' }],
    charts: [{
      type: 'bar', title: 'C', labels: ['a'],
      datasets: [{ label: 'S', data: [1], color: "'+evil+'" }],
    }],
    theme: 'light',
  }, fakeCtx());
  assert.equal(r.ok, true);
  const c = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(!c.includes('<script>alert(1)</script>'), 'HTML breakout must be neutralised');
  assert.ok(!c.includes("'+evil+'"), 'JS string-literal breakout must be neutralised');
});

test('create_dashboard_html: a chart label cannot close the inline <script>', async () => {
  // Regression: chart label/data went through plain JSON.stringify into a
  // <script> block; a label of "</script>…" terminated the script element.
  const r = await tool('create_dashboard_html').execute({
    title: 'Probe', metrics: [],
    charts: [{
      type: 'bar', title: 'C',
      labels: ['</script><img src=x onerror=alert(1)>'],
      datasets: [{ label: 'L', data: [1] }],
    }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const c = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(!c.includes('</script><img'), 'user </script> must be escaped, not terminate the script');
  assert.ok(c.includes('\\u003c/script'), 'the < should be \\u003c-escaped inside the script');
});


// ── Tool metadata ────────────────────────────────────────────────

test('all 35 tools have valid metadata', () => {
  assert.equal(VISUAL_MEDIA_TOOLS.length, 35);
  for (const t of VISUAL_MEDIA_TOOLS) {
    assert.ok(t.name);
    assert.ok(t.description);
    assert.ok(t.parameters?.type === 'object');
    assert.ok(typeof t.execute === 'function');
    for (const [k, p] of Object.entries(t.parameters.properties || {})) {
      assert.ok(p.description, `${t.name}.${k} missing description`);
    }
  }
});

test('all tool names are unique', () => {
  const names = VISUAL_MEDIA_TOOLS.map(t => t.name);
  assert.equal(new Set(names).size, names.length);
});

// ── Internal helpers ─────────────────────────────────────────────

test('VIS_INTERNAL.xmlEscape: escapes the five XML metacharacters', () => {
  const { xmlEscape } = VIS_INTERNAL;
  assert.equal(xmlEscape('a & b < c > d "e"'), 'a &amp; b &lt; c &gt; d &quot;e&quot;');
  assert.equal(xmlEscape(null), '');
  assert.equal(xmlEscape(undefined), '');
  assert.equal(xmlEscape(42), '42');
});

test('VIS_INTERNAL.svgDocument: well-formed SVG with title/desc and shadow filter', () => {
  const { svgDocument } = VIS_INTERNAL;
  const svg = svgDocument({ width: 400, height: 300, title: 'T & X', description: 'd', body: '<rect/>' });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('viewBox="0 0 400 300"'));
  assert.ok(svg.includes('<title id="vis-title">T &amp; X</title>'));
  assert.ok(svg.includes('vis-shadow'));
  assert.ok(svg.includes('<rect/>'));
  assert.ok(svg.endsWith('</svg>'));
});

test('VIS_INTERNAL.generateScenesFromPrompt: scene count, durations, and time ranges', () => {
  const { generateScenesFromPrompt } = VIS_INTERNAL;
  const scenes = generateScenesFromPrompt('A quick narrative about innovation in technology', 12);
  assert.ok(scenes.length >= 3 && scenes.length <= 8);
  const total = scenes.reduce((s, x) => s + x.duration, 0);
  assert.equal(total, 12);
  for (const s of scenes) {
    assert.ok(typeof s.description === 'string' && s.description.length > 0);
    assert.ok(/^\d+s - \d+s$/.test(s.timeRange));
    assert.ok(/^#[0-9A-F]{6}$/i.test(s.color));
    assert.ok(s.duration >= 1);
  }
});

test('VIS_INTERNAL.generateScenesFromPrompt: handles empty / tiny prompts gracefully', () => {
  const { generateScenesFromPrompt } = VIS_INTERNAL;
  const empty = generateScenesFromPrompt('', 8);
  assert.ok(empty.length >= 3);
  assert.equal(empty.reduce((s, x) => s + x.duration, 0), 8);

  const oneWord = generateScenesFromPrompt('hi', 6);
  assert.ok(oneWord.length >= 3);
  for (const s of oneWord) assert.ok(s.description.length > 0);
});

// ── create_chart input hardening ─────────────────────────────────

test('create_chart: tolerates NaN / null / string values without crashing', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'bar',
    title: 'numeric safety',
    labels: ['A', 'B', 'C', 'D'],
    datasets: [{ label: 'mixed', data: [10, NaN, null, '20'] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const fp = assertArtifact(r);
  const svg = fs.readFileSync(fp, 'utf8');
  assert.ok(svg.startsWith('<svg'));
  // No literal "NaN" rendered into the SVG (would indicate poisoned arithmetic)
  assert.equal(svg.includes('NaN'), false, 'SVG should not contain literal NaN');
  assert.equal(svg.includes('Infinity'), false, 'SVG should not contain literal Infinity');
});

test('create_chart: empty dataset still produces a valid SVG', async () => {
  const r = await tool('create_chart').execute({
    chartType: 'line',
    title: 'Empty data',
    labels: ['x'],
    datasets: [{ label: 'empty', data: [] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('<svg'));
});

// ── create_swot_analysis ─────────────────────────────────────────

test('create_swot_analysis: full 2x2 SWOT with all quadrants populated', async () => {
  const sw = tool('create_swot_analysis');
  assert.ok(sw);
  const r = await sw.execute({
    title: 'Q1 2026 Product Review',
    subtitle: 'SiraGPT — mercado LatAm',
    strengths: ['Marca reconocida', 'Equipo senior', 'Producto maduro'],
    weaknesses: ['Onboarding lento', 'Documentación incompleta'],
    opportunities: ['Expansión a Brasil', 'Integraciones MCP', 'Tier enterprise'],
    threats: ['Competencia OpenAI', 'Cambios regulatorios'],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.svg'));
  assert.equal(r.counts.strengths, 3);
  assert.equal(r.counts.weaknesses, 2);
  assert.equal(r.counts.opportunities, 3);
  assert.equal(r.counts.threats, 2);
  assert.equal(r.total, 10);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.startsWith('<svg'), 'output should be a well-formed SVG');
  assert.ok(c.includes('Q1 2026 Product Review'));
  assert.ok(c.includes('SiraGPT'), 'subtitle should render');
  assert.ok(c.includes('STRENGTHS'));
  assert.ok(c.includes('WEAKNESSES'));
  assert.ok(c.includes('OPPORTUNITIES'));
  assert.ok(c.includes('THREATS'));
  assert.ok(c.includes('Marca reconocida'));
  assert.ok(c.includes('Onboarding lento'));
  assert.ok(c.includes('Expansión a Brasil'));
  assert.ok(c.includes('Competencia OpenAI'));
});

test('create_swot_analysis: succeeds with one quadrant populated, others empty', async () => {
  const r = await tool('create_swot_analysis').execute({
    title: 'Lean SWOT',
    strengths: ['Solo item de S'],
    weaknesses: [],
    opportunities: [],
    threats: [],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.counts.strengths, 1);
  assert.equal(r.counts.weaknesses, 0);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Solo item de S'));
  // Empty quadrants render a "sin elementos" placeholder, not real items.
  assert.ok(svg.includes('— sin elementos —'));
});

test('create_swot_analysis: all empty quadrants fails', async () => {
  const r = await tool('create_swot_analysis').execute({
    title: 'Empty',
    strengths: [], weaknesses: [], opportunities: [], threats: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /empty|provide at least/i);
});

test('create_swot_analysis: non-array input fails fast', async () => {
  const r = await tool('create_swot_analysis').execute({
    title: 'Bad input',
    strengths: 'should be array',
    weaknesses: [],
    opportunities: [],
    threats: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /must be arrays/i);
});

test('create_swot_analysis: caps items at 8 per quadrant', async () => {
  const tenItems = Array.from({ length: 10 }, (_, i) => `Item ${i + 1}`);
  const r = await tool('create_swot_analysis').execute({
    title: 'Overflow guard',
    strengths: tenItems,
    weaknesses: ['W1'],
    opportunities: ['O1'],
    threats: ['T1'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.counts.strengths, 8, 'should cap at 8 items');
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Item 1'));
  assert.ok(svg.includes('Item 8'));
  // Items 9 and 10 should NOT appear (trimmed past the 8-item cap)
  assert.equal(svg.includes('Item 9'), false);
  assert.equal(svg.includes('Item 10'), false);
});

test('create_swot_analysis: long item text is truncated, not overflowed', async () => {
  const longItem = 'A'.repeat(200);
  const r = await tool('create_swot_analysis').execute({
    title: 'Truncation',
    strengths: [longItem],
    weaknesses: [], opportunities: [], threats: [],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // 200 A's get truncated to lineMaxChars (56) before rendering.
  assert.equal(svg.includes('A'.repeat(57)), false, 'should not render 57+ A in a row');
});

test('create_swot_analysis: xml-escapes item content (prevents SVG injection)', async () => {
  const r = await tool('create_swot_analysis').execute({
    title: 'XSS guard',
    strengths: ['<script>alert(1)</script>'],
    weaknesses: ['"injected"'],
    opportunities: ['&amp;already'],
    threats: ['<img onerror=x>'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // Raw < or > from user input must be escaped; the only allowed unescaped
  // < / > are the ones we emit ourselves as SVG element delimiters.
  assert.equal(svg.includes('<script>alert(1)</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_swot_analysis: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_swot_analysis').execute({
      title: `Theme ${theme}`,
      strengths: ['S'], weaknesses: ['W'], opportunities: ['O'], threats: ['T'],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'), `theme ${theme} should yield valid SVG`);
  }
});

test('create_swot_analysis: unknown theme falls back to professional', async () => {
  const r = await tool('create_swot_analysis').execute({
    title: 'Unknown theme',
    strengths: ['x'], weaknesses: [], opportunities: [], threats: [],
    theme: 'rainbow-unicorn',
  }, fakeCtx());
  // The schema's enum doesn't strictly block invalid themes at this layer;
  // the implementation defensively falls back instead of crashing.
  assert.equal(r.ok, true);
});

test('create_swot_analysis: emits tool_call, file_artifact, and tool_output events', async () => {
  const ctx = fakeCtx();
  await tool('create_swot_analysis').execute({
    title: 'Events',
    strengths: ['s1'], weaknesses: [], opportunities: [], threats: [],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_eisenhower_matrix ─────────────────────────────────────

test('create_eisenhower_matrix: full Q1-Q4 with all four quadrants populated', async () => {
  const em = tool('create_eisenhower_matrix');
  assert.ok(em);
  const r = await em.execute({
    title: 'Sprint 14 Triage',
    subtitle: 'SiraGPT — week of 2026-05-18',
    do: ['Fix prod incident', 'Ship hotfix for billing'],
    schedule: ['Migrate auth to passkeys', 'Refactor RAG cache'],
    delegate: ['Renew SSL cert', 'Update docs links'],
    eliminate: ['Old A/B test cleanup'],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.svg'));
  assert.equal(r.counts.do, 2);
  assert.equal(r.counts.schedule, 2);
  assert.equal(r.counts.delegate, 2);
  assert.equal(r.counts.eliminate, 1);
  assert.equal(r.total, 7);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.startsWith('<svg'), 'output should be a well-formed SVG');
  assert.ok(c.includes('Sprint 14 Triage'));
  assert.ok(c.includes('SiraGPT'), 'subtitle should render');
  // Verbs on the action pills
  assert.ok(c.includes('DO'));
  assert.ok(c.includes('SCHEDULE'));
  assert.ok(c.includes('DELEGATE'));
  assert.ok(c.includes('ELIMINATE'));
  // Axis labels
  assert.ok(c.includes('URGENT'));
  assert.ok(c.includes('NOT URGENT'));
  assert.ok(c.includes('IMPORTANT'));
  assert.ok(c.includes('NOT IMPORTANT'));
  // Items appear
  assert.ok(c.includes('Fix prod incident'));
  assert.ok(c.includes('Migrate auth to passkeys'));
  assert.ok(c.includes('Renew SSL cert'));
  assert.ok(c.includes('Old A/B test cleanup'));
});

test('create_eisenhower_matrix: singleton in DO quadrant, others empty', async () => {
  const r = await tool('create_eisenhower_matrix').execute({
    title: 'Single action',
    do: ['Only urgent + important thing'],
    schedule: [],
    delegate: [],
    eliminate: [],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.counts.do, 1);
  assert.equal(r.counts.schedule, 0);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Only urgent + important thing'));
  assert.ok(svg.includes('— sin elementos —'));
});

test('create_eisenhower_matrix: all empty quadrants fails', async () => {
  const r = await tool('create_eisenhower_matrix').execute({
    title: 'Empty',
    do: [], schedule: [], delegate: [], eliminate: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /empty|provide at least/i);
});

test('create_eisenhower_matrix: non-array input fails fast', async () => {
  const r = await tool('create_eisenhower_matrix').execute({
    title: 'Bad input',
    do: 'should be array',
    schedule: [],
    delegate: [],
    eliminate: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /must be arrays/i);
});

test('create_eisenhower_matrix: caps items at 8 per quadrant', async () => {
  const tenItems = Array.from({ length: 10 }, (_, i) => `Task ${i + 1}`);
  const r = await tool('create_eisenhower_matrix').execute({
    title: 'Overflow guard',
    do: tenItems,
    schedule: ['s1'],
    delegate: ['d1'],
    eliminate: ['e1'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.counts.do, 8, 'should cap at 8 items');
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Task 1'));
  assert.ok(svg.includes('Task 8'));
  assert.equal(svg.includes('Task 9'), false);
  assert.equal(svg.includes('Task 10'), false);
});

test('create_eisenhower_matrix: long item text is truncated', async () => {
  const longItem = 'B'.repeat(200);
  const r = await tool('create_eisenhower_matrix').execute({
    title: 'Truncation',
    do: [longItem],
    schedule: [], delegate: [], eliminate: [],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('B'.repeat(57)), false, 'should not render 57+ B in a row');
});

test('create_eisenhower_matrix: xml-escapes item content (prevents SVG injection)', async () => {
  const r = await tool('create_eisenhower_matrix').execute({
    title: 'XSS guard',
    do: ['<script>alert(1)</script>'],
    schedule: ['"injected"'],
    delegate: ['&amp;already'],
    eliminate: ['<img onerror=x>'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>alert(1)</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_eisenhower_matrix: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_eisenhower_matrix').execute({
      title: `Theme ${theme}`,
      do: ['d'], schedule: ['s'], delegate: ['de'], eliminate: ['el'],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'), `theme ${theme} should yield valid SVG`);
  }
});

test('create_eisenhower_matrix: unknown theme falls back to professional', async () => {
  const r = await tool('create_eisenhower_matrix').execute({
    title: 'Unknown theme',
    do: ['x'], schedule: [], delegate: [], eliminate: [],
    theme: 'rainbow-unicorn',
  }, fakeCtx());
  assert.equal(r.ok, true);
});

test('create_eisenhower_matrix: emits tool_call, file_artifact, and tool_output events', async () => {
  const ctx = fakeCtx();
  await tool('create_eisenhower_matrix').execute({
    title: 'Events',
    do: ['x'], schedule: [], delegate: [], eliminate: [],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

test('create_eisenhower_matrix: layout — Schedule top-left, Do top-right, Eliminate bottom-left, Delegate bottom-right', async () => {
  // Verify the canonical Eisenhower layout: importance increases UP,
  // urgency increases RIGHT. A reader should be able to find each
  // quadrant by position alone.
  const r = await tool('create_eisenhower_matrix').execute({
    title: 'Layout check',
    do: ['DO_ITEM'],
    schedule: ['SCHED_ITEM'],
    delegate: ['DEL_ITEM'],
    eliminate: ['ELIM_ITEM'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // Schedule item renders BEFORE Do item in source order (Schedule
  // is the top-left quadrant, drawn first). Then Do (top-right),
  // then Eliminate (bottom-left), then Delegate (bottom-right).
  const idxSched = svg.indexOf('SCHED_ITEM');
  const idxDo    = svg.indexOf('DO_ITEM');
  const idxElim  = svg.indexOf('ELIM_ITEM');
  const idxDel   = svg.indexOf('DEL_ITEM');
  assert.ok(idxSched > 0 && idxDo > idxSched, 'Schedule (top-left) drawn before Do (top-right)');
  assert.ok(idxDo > 0 && idxElim > idxDo, 'Do (top-right) drawn before Eliminate (bottom-left)');
  assert.ok(idxElim > 0 && idxDel > idxElim, 'Eliminate (bottom-left) drawn before Delegate (bottom-right)');
});

// ── create_raci_matrix ───────────────────────────────────────────

test('create_raci_matrix: standard 4-role × 3-task grid', async () => {
  const rm = tool('create_raci_matrix');
  assert.ok(rm);
  const r = await rm.execute({
    title: 'Deploy Pipeline RACI',
    subtitle: 'SiraGPT — 2026 Q2',
    roles: ['DevOps', 'Engineering', 'PM', 'Security'],
    rows: [
      { task: 'Approve release', assignments: ['I', 'C', 'A', 'C'] },
      { task: 'Run smoke tests', assignments: ['R', 'R', 'I', ''] },
      { task: 'Sign-off compliance', assignments: ['', 'I', 'C', 'A'] },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.svg'));
  assert.equal(r.roles, 4);
  assert.equal(r.rows, 3);
  // Tally counts: R=2, A=2, C=3, I=3
  assert.equal(r.tally.R, 2);
  assert.equal(r.tally.A, 2);
  assert.equal(r.tally.C, 3);
  assert.equal(r.tally.I, 3);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.startsWith('<svg'));
  assert.ok(c.includes('Deploy Pipeline RACI'));
  assert.ok(c.includes('SiraGPT'));
  assert.ok(c.includes('DevOps'));
  assert.ok(c.includes('Approve release'));
  assert.ok(c.includes('TAREA / ACTIVIDAD'));
  // Legend rendered
  assert.ok(c.includes('Responsible'));
  assert.ok(c.includes('Accountable'));
  assert.ok(c.includes('Consulted'));
  assert.ok(c.includes('Informed'));
});

test('create_raci_matrix: empty roles fails', async () => {
  const r = await tool('create_raci_matrix').execute({
    title: 'No roles',
    roles: [],
    rows: [{ task: 'x', assignments: [] }],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /roles.*empty/i);
});

test('create_raci_matrix: empty rows fails', async () => {
  const r = await tool('create_raci_matrix').execute({
    title: 'No rows',
    roles: ['A', 'B'],
    rows: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /rows.*empty/i);
});

test('create_raci_matrix: lowercase r/a/c/i normalises to uppercase', async () => {
  const r = await tool('create_raci_matrix').execute({
    title: 'Case norm',
    roles: ['X', 'Y'],
    rows: [{ task: 't1', assignments: ['r', 'a'] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.tally.R, 1);
  assert.equal(r.tally.A, 1);
});

test('create_raci_matrix: invalid assignment letters render as blank', async () => {
  const r = await tool('create_raci_matrix').execute({
    title: 'Bad letters',
    roles: ['X', 'Y', 'Z'],
    rows: [{ task: 't', assignments: ['R', 'Z', 'X'] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  // Only R counts; Z and X are not valid RACI letters and stay blank.
  assert.equal(r.tally.R, 1);
  assert.equal(r.tally.A, 0);
  assert.equal(r.tally.C, 0);
  assert.equal(r.tally.I, 0);
});

test('create_raci_matrix: caps roles at 8 and rows at 20', async () => {
  const r = await tool('create_raci_matrix').execute({
    title: 'Caps',
    roles: Array.from({ length: 12 }, (_, i) => `Role ${i + 1}`),
    rows: Array.from({ length: 30 }, (_, i) => ({ task: `Task ${i + 1}`, assignments: ['R', 'A', 'C', 'I'] })),
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.roles, 8, 'roles capped at 8');
  assert.equal(r.rows, 20, 'rows capped at 20');
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Role 8'));
  assert.equal(svg.includes('Role 9'), false);
  assert.ok(svg.includes('Task 20'));
  assert.equal(svg.includes('Task 21'), false);
});

test('create_raci_matrix: xml-escapes role and task content', async () => {
  const r = await tool('create_raci_matrix').execute({
    title: 'XSS guard',
    roles: ['<script>evil</script>', 'Safe'],
    rows: [{ task: '"injected" task', assignments: ['R', 'A'] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>evil</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_raci_matrix: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_raci_matrix').execute({
      title: `Theme ${theme}`,
      roles: ['A', 'B'],
      rows: [{ task: 't', assignments: ['R', 'A'] }],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_raci_matrix: emits tool_call and file_artifact events', async () => {
  const ctx = fakeCtx();
  await tool('create_raci_matrix').execute({
    title: 'Events',
    roles: ['A'],
    rows: [{ task: 't', assignments: ['R'] }],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

test('create_raci_matrix: mismatched assignment-array length is tolerated (extra cells blank)', async () => {
  const r = await tool('create_raci_matrix').execute({
    title: 'Short assignments',
    roles: ['A', 'B', 'C', 'D'],
    // Only 2 of 4 assignments provided — the other 2 columns should render as blank cells.
    rows: [{ task: 't', assignments: ['R', 'A'] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.tally.R, 1);
  assert.equal(r.tally.A, 1);
  assert.equal(r.tally.C, 0);
  assert.equal(r.tally.I, 0);
});

// ── create_business_model_canvas ─────────────────────────────────

test('create_business_model_canvas: full 9-block canvas', async () => {
  const bmc = tool('create_business_model_canvas');
  assert.ok(bmc);
  const r = await bmc.execute({
    title: 'SiraGPT BMC 2026',
    subtitle: 'AI platform — LATAM',
    keyPartners: ['OpenAI', 'Hostinger VPS'],
    keyActivities: ['Modelo training', 'Producto dev'],
    keyResources: ['Equipo senior', 'Marca SiraGPT'],
    valuePropositions: ['Chat AI español-first', 'Análisis de documentos pro'],
    customerRelationships: ['Self-service', 'Soporte premium'],
    channels: ['Web app', 'Mobile app'],
    customerSegments: ['Profesionales LATAM', 'PYMES'],
    costStructure: ['LLM API costs', 'Infra cloud'],
    revenueStreams: ['Subscripción Pro', 'Tier Enterprise'],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.svg'));
  assert.equal(r.total, 18);
  assert.equal(r.counts.keyPartners, 2);
  assert.equal(r.counts.valuePropositions, 2);
  assert.equal(r.counts.revenueStreams, 2);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.startsWith('<svg'));
  assert.ok(c.includes('SiraGPT BMC 2026'));
  assert.ok(c.includes('AI platform'));
  assert.ok(c.includes('KEY PARTNERS'));
  assert.ok(c.includes('KEY ACTIVITIES'));
  assert.ok(c.includes('KEY RESOURCES'));
  assert.ok(c.includes('VALUE PROPOSITIONS'));
  assert.ok(c.includes('CUSTOMER RELATIONSHIPS'));
  assert.ok(c.includes('CHANNELS'));
  assert.ok(c.includes('CUSTOMER SEGMENTS'));
  assert.ok(c.includes('COST STRUCTURE'));
  assert.ok(c.includes('REVENUE STREAMS'));
  assert.ok(c.includes('OpenAI'));
  assert.ok(c.includes('Subscripción Pro'));
});

test('create_business_model_canvas: partial canvas with only Value Prop populated', async () => {
  const r = await tool('create_business_model_canvas').execute({
    title: 'Lean BMC',
    valuePropositions: ['Just the value prop'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.counts.valuePropositions, 1);
  assert.equal(r.counts.keyPartners, 0);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Just the value prop'));
  // Empty blocks render as "vacío" placeholder
  assert.ok(svg.includes('— vacío —'));
});

test('create_business_model_canvas: empty canvas fails', async () => {
  const r = await tool('create_business_model_canvas').execute({
    title: 'Empty BMC',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /empty|provide at least/i);
});

test('create_business_model_canvas: non-array block fails fast', async () => {
  const r = await tool('create_business_model_canvas').execute({
    title: 'Bad input',
    keyPartners: 'should be array',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /must be arrays/i);
});

test('create_business_model_canvas: caps items at 8 per block', async () => {
  const tenItems = Array.from({ length: 10 }, (_, i) => `Item ${i + 1}`);
  const r = await tool('create_business_model_canvas').execute({
    title: 'Overflow guard',
    valuePropositions: tenItems,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.counts.valuePropositions, 8, 'should cap at 8 items');
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Item 1'));
  assert.ok(svg.includes('Item 8'));
  assert.equal(svg.includes('Item 9'), false);
  assert.equal(svg.includes('Item 10'), false);
});

test('create_business_model_canvas: long item text is truncated', async () => {
  const longItem = 'C'.repeat(200);
  const r = await tool('create_business_model_canvas').execute({
    title: 'Truncation',
    valuePropositions: [longItem],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // BMC's per-line cap is 38 chars; 39+ of any single char should not appear.
  assert.equal(svg.includes('C'.repeat(39)), false, 'should not render 39+ C in a row');
});

test('create_business_model_canvas: xml-escapes block content', async () => {
  const r = await tool('create_business_model_canvas').execute({
    title: 'XSS guard',
    valuePropositions: ['<script>evil</script>'],
    keyPartners: ['"injected"'],
    revenueStreams: ['<img onerror=x>'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>evil</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_business_model_canvas: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_business_model_canvas').execute({
      title: `Theme ${theme}`,
      valuePropositions: ['vp'],
      customerSegments: ['cs'],
      revenueStreams: ['rs'],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_business_model_canvas: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_business_model_canvas').execute({
    title: 'Events',
    valuePropositions: ['vp'],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

test('create_business_model_canvas: counts object exposes all 9 block sizes', async () => {
  const r = await tool('create_business_model_canvas').execute({
    title: 'Counts shape',
    valuePropositions: ['vp'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  // The counts object MUST include all 9 keys, even for empty blocks
  // — consumers downstream rely on this for dashboards.
  for (const k of ['keyPartners', 'keyActivities', 'keyResources', 'valuePropositions', 'customerRelationships', 'channels', 'customerSegments', 'costStructure', 'revenueStreams']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.counts, k), `counts.${k} should be present`);
    assert.equal(typeof r.counts[k], 'number');
  }
});

// ── create_pyramid_diagram ───────────────────────────────────────

test('create_pyramid_diagram: 5-level Maslow', async () => {
  const pd = tool('create_pyramid_diagram');
  assert.ok(pd);
  const r = await pd.execute({
    title: 'Maslow Hierarchy of Needs',
    subtitle: 'Clásico de Abraham Maslow',
    levels: [
      { label: 'Self-actualization', description: 'Realizar el potencial personal' },
      { label: 'Esteem', description: 'Reconocimiento y respeto' },
      { label: 'Belonging', description: 'Amor, amistad, pertenencia' },
      { label: 'Safety', description: 'Seguridad física, económica' },
      { label: 'Physiological', description: 'Necesidades básicas' },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.svg'));
  assert.equal(r.levels, 5);
  assert.equal(r.inverted, false);
  const fp = assertArtifact(r);
  const c = fs.readFileSync(fp, 'utf8');
  assert.ok(c.startsWith('<svg'));
  assert.ok(c.includes('Maslow Hierarchy of Needs'));
  assert.ok(c.includes('Self-actualization'));
  assert.ok(c.includes('Physiological'));
  // Descriptions wrap to 2 lines so we check for an inner fragment that
  // survives the wrap rather than the full string.
  assert.ok(c.includes('Realizar') && c.includes('potencial'));
});

test('create_pyramid_diagram: inverted pyramid', async () => {
  const r = await tool('create_pyramid_diagram').execute({
    title: 'Inverted',
    levels: [{ label: 'Top' }, { label: 'Bottom' }],
    inverted: true,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.inverted, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('invertida'));
});

test('create_pyramid_diagram: empty levels fails', async () => {
  const r = await tool('create_pyramid_diagram').execute({
    title: 'Empty',
    levels: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /levels.*empty/i);
});

test('create_pyramid_diagram: single level fails (need >= 2)', async () => {
  const r = await tool('create_pyramid_diagram').execute({
    title: 'One level',
    levels: [{ label: 'Only one' }],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /at least 2/i);
});

test('create_pyramid_diagram: caps levels at 8', async () => {
  const tenLevels = Array.from({ length: 10 }, (_, i) => ({ label: `Level ${i + 1}` }));
  const r = await tool('create_pyramid_diagram').execute({
    title: 'Too many',
    levels: tenLevels,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.levels, 8, 'should cap at 8 levels');
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Level 1'));
  assert.ok(svg.includes('Level 8'));
  assert.equal(svg.includes('Level 9'), false);
});

test('create_pyramid_diagram: per-level color override is respected', async () => {
  const r = await tool('create_pyramid_diagram').execute({
    title: 'Custom colors',
    levels: [
      { label: 'Top', color: '#FF00FF' },
      { label: 'Bottom', color: '#00FFFF' },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // Hex codes are case-insensitive in SVG; both should appear in the output.
  assert.ok(svg.toUpperCase().includes('#FF00FF'));
  assert.ok(svg.toUpperCase().includes('#00FFFF'));
});

test('create_pyramid_diagram: invalid color falls back to theme palette', async () => {
  const r = await tool('create_pyramid_diagram').execute({
    title: 'Bad color',
    levels: [
      { label: 'Top', color: 'red' },               // not hex
      { label: 'Bottom', color: '#GGGGGG' },        // invalid hex
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // Invalid color must not appear in the SVG verbatim
  assert.equal(svg.includes('fill="red"'), false);
  assert.equal(svg.includes('#GGGGGG'), false);
});

test('create_pyramid_diagram: xml-escapes labels and descriptions', async () => {
  const r = await tool('create_pyramid_diagram').execute({
    title: 'XSS',
    levels: [
      // Long enough description that "wrap-to-2-lines" still keeps
      // each escape entity intact within one half.
      { label: '<script>evil</script>', description: 'the description text only contains safe words' },
      { label: 'Safe', description: 'no special chars here either' },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // Label was a script tag — must be escaped to &lt;script&gt;, never raw.
  assert.equal(svg.includes('<script>evil</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  // Description text appears (uppercased or not, with our wrap)
  assert.ok(svg.includes('description text') || svg.includes('description'));
});

test('create_pyramid_diagram: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_pyramid_diagram').execute({
      title: `Theme ${theme}`,
      levels: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_pyramid_diagram: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_pyramid_diagram').execute({
    title: 'Events',
    levels: [{ label: 'A' }, { label: 'B' }],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_porters_five_forces ───────────────────────────────────

test("create_porters_five_forces: full Porter's analysis", async () => {
  const pf = tool('create_porters_five_forces');
  assert.ok(pf);
  const r = await pf.execute({
    title: 'AI Chat Platforms — Five Forces',
    subtitle: 'LATAM 2026',
    rivalry: { items: ['OpenAI', 'Anthropic', 'Google'], intensity: 'high' },
    newEntrants: { items: ['Open-source LLM forks', 'Cloud-native startups'], intensity: 'medium' },
    substitutes: { items: ['Traditional BPO', 'In-house ML teams'], intensity: 'low' },
    suppliers: { items: ['NVIDIA (GPUs)', 'OpenAI API'], intensity: 'high' },
    buyers: { items: ['Enterprise CIOs', 'SMB self-service'], intensity: 'medium' },
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.svg'));
  assert.equal(r.counts.rivalry, 3);
  assert.equal(r.counts.newEntrants, 2);
  assert.equal(r.counts.substitutes, 2);
  assert.equal(r.counts.suppliers, 2);
  assert.equal(r.counts.buyers, 2);
  assert.equal(r.total, 11);
  const c = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(c.startsWith('<svg'));
  assert.ok(c.includes('AI Chat Platforms'));
  assert.ok(c.includes('LATAM 2026'));
  assert.ok(c.includes('INDUSTRY RIVALRY'));
  assert.ok(c.includes('THREAT OF NEW ENTRANTS'));
  assert.ok(c.includes('THREAT OF SUBSTITUTES'));
  assert.ok(c.includes('BARGAINING POWER OF SUPPLIERS'));
  assert.ok(c.includes('BARGAINING POWER OF BUYERS'));
  assert.ok(c.includes('OpenAI'));
  assert.ok(c.includes('NVIDIA'));
  // Intensity pills rendered
  assert.ok(c.includes('HIGH'));
  assert.ok(c.includes('MEDIUM'));
  assert.ok(c.includes('LOW'));
});

test("create_porters_five_forces: only one force populated still succeeds", async () => {
  const r = await tool('create_porters_five_forces').execute({
    title: 'Sparse',
    rivalry: { items: ['Some rivalry note'] },
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.counts.rivalry, 1);
  assert.equal(r.counts.newEntrants, 0);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // Empty forces render a "sin elementos" placeholder
  assert.ok(svg.includes('— sin elementos —'));
});

test("create_porters_five_forces: all empty fails", async () => {
  const r = await tool('create_porters_five_forces').execute({
    title: 'Empty',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /empty|provide at least/i);
});

test("create_porters_five_forces: non-object force coerces to empty (no crash)", async () => {
  const r = await tool('create_porters_five_forces').execute({
    title: 'Malformed',
    rivalry: 'should be object',
    newEntrants: { items: ['ok'] },
  }, fakeCtx());
  assert.equal(r.ok, true);
  // Malformed rivalry treated as empty; only newEntrants contributes
  assert.equal(r.counts.rivalry, 0);
  assert.equal(r.counts.newEntrants, 1);
});

test("create_porters_five_forces: caps items at 6 per force", async () => {
  const tenItems = Array.from({ length: 10 }, (_, i) => `Item ${i + 1}`);
  const r = await tool('create_porters_five_forces').execute({
    title: 'Overflow',
    rivalry: { items: tenItems, intensity: 'high' },
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Item 1'));
  assert.ok(svg.includes('Item 6'));
  // Item 7+ should NOT appear (capped at 6)
  assert.equal(svg.includes('Item 7'), false);
});

test("create_porters_five_forces: invalid intensity is ignored (no pill rendered)", async () => {
  const r = await tool('create_porters_five_forces').execute({
    title: 'Bad intensity',
    rivalry: { items: ['x'], intensity: 'rainbow' },
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // None of HIGH/MEDIUM/LOW should appear since the intensity was invalid
  assert.equal(svg.includes('>HIGH<'), false);
  assert.equal(svg.includes('>MEDIUM<'), false);
  assert.equal(svg.includes('>LOW<'), false);
  // The invalid value also shouldn't leak verbatim into the SVG
  assert.equal(svg.toUpperCase().includes('>RAINBOW<'), false);
});

test("create_porters_five_forces: xml-escapes force content", async () => {
  const r = await tool('create_porters_five_forces').execute({
    title: 'XSS',
    rivalry: { items: ['<script>alert(1)</script>'] },
    buyers: { items: ['"injected"'] },
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>alert(1)</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test("create_porters_five_forces: supports all four themes", async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_porters_five_forces').execute({
      title: `Theme ${theme}`,
      rivalry: { items: ['x'] },
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test("create_porters_five_forces: emits expected events", async () => {
  const ctx = fakeCtx();
  await tool('create_porters_five_forces').execute({
    title: 'Events',
    rivalry: { items: ['x'] },
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_risk_matrix ───────────────────────────────────────────

test('create_risk_matrix: 5x5 with 4 risks plotted', async () => {
  const rm = tool('create_risk_matrix');
  assert.ok(rm);
  const r = await rm.execute({
    title: 'Q2 Project Risk Register',
    subtitle: 'SiraGPT Platform — 2026',
    risks: [
      { label: 'Vendor delay', probability: 4, impact: 5, category: 'operational' },
      { label: 'Regulatory change', probability: 2, impact: 5, category: 'legal' },
      { label: 'Talent attrition', probability: 3, impact: 3, category: 'people' },
      { label: 'Cost overrun', probability: 4, impact: 4, category: 'financial' },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.size, 5);
  assert.equal(r.risks, 4);
  // Risk bands (score/25): CRITICAL ≥ 70%, HIGH ≥ 40%, MEDIUM ≥ 20%, else LOW.
  // Vendor delay 20 → 80% → CRITICAL.
  // Cost overrun 16 → 64% → HIGH.
  // Regulatory change 10 → 40% → HIGH (boundary inclusive).
  // Talent attrition 9 → 36% → MEDIUM.
  assert.equal(r.tally.CRITICAL, 1);
  assert.equal(r.tally.HIGH, 2);
  assert.equal(r.tally.MEDIUM, 1);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('Q2 Project Risk Register'));
  assert.ok(svg.includes('PROBABILIDAD'));
  assert.ok(svg.includes('IMPACTO'));
  assert.ok(svg.includes('Vendor delay'));
  assert.ok(svg.includes('Regulatory change'));
  assert.ok(svg.includes('CRITICAL'));
  assert.ok(svg.includes('HIGH'));
  assert.ok(svg.includes('MEDIUM'));
  assert.ok(svg.includes('NIVEL DE RIESGO'));
});

test('create_risk_matrix: 3x3 grid', async () => {
  const r = await tool('create_risk_matrix').execute({
    title: 'Compact',
    size: 3,
    risks: [
      { label: 'Risk A', probability: 1, impact: 1 },
      { label: 'Risk B', probability: 3, impact: 3 },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.size, 3);
  // Risk B: 9/9 = 100% → CRITICAL; Risk A: 1/9 = 11% → LOW
  assert.equal(r.tally.CRITICAL, 1);
  assert.equal(r.tally.LOW, 1);
});

test('create_risk_matrix: empty risks fails', async () => {
  const r = await tool('create_risk_matrix').execute({
    title: 'Empty',
    risks: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /risks.*empty/i);
});

test('create_risk_matrix: clamps probability/impact to [1, size]', async () => {
  const r = await tool('create_risk_matrix').execute({
    title: 'Out of range',
    risks: [
      { label: 'Too high', probability: 99, impact: 99 },
      { label: 'Too low', probability: -5, impact: 0 },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  // Both should still plot — clamped to 5,5 and 1,1 respectively
  assert.equal(r.tally.CRITICAL, 1);
  assert.equal(r.tally.LOW, 1);
});

test('create_risk_matrix: caps risks at 20 plotted', async () => {
  const manyRisks = Array.from({ length: 30 }, (_, i) => ({
    label: `Risk ${i + 1}`,
    probability: ((i % 5) + 1),
    impact: ((i % 5) + 1),
  }));
  const r = await tool('create_risk_matrix').execute({
    title: 'Overflow',
    risks: manyRisks,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.risks, 20, 'plot count capped at 20');
});

test('create_risk_matrix: invalid size falls back to 5', async () => {
  const r = await tool('create_risk_matrix').execute({
    title: 'Bad size',
    size: 7,
    risks: [{ label: 'x', probability: 1, impact: 1 }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.size, 5);
});

test('create_risk_matrix: xml-escapes risk labels', async () => {
  const r = await tool('create_risk_matrix').execute({
    title: 'XSS',
    risks: [{ label: '<script>alert(1)</script>', probability: 3, impact: 3 }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>alert(1)</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
});

test('create_risk_matrix: multiple risks in the same cell stack vertically', async () => {
  const r = await tool('create_risk_matrix').execute({
    title: 'Stacked',
    risks: [
      { label: 'R1', probability: 3, impact: 3 },
      { label: 'R2', probability: 3, impact: 3 },
      { label: 'R3', probability: 3, impact: 3 },
      { label: 'R4', probability: 3, impact: 3 },
      { label: 'R5', probability: 3, impact: 3 },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  // All 5 risks plotted; overflow indicator '+2' for risks beyond the 3-stack limit
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('+2'));
});

test('create_risk_matrix: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_risk_matrix').execute({
      title: `Theme ${theme}`,
      risks: [{ label: 'x', probability: 2, impact: 3 }],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_risk_matrix: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_risk_matrix').execute({
    title: 'Events',
    risks: [{ label: 'x', probability: 2, impact: 3 }],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_funnel_diagram ────────────────────────────────────────

test('create_funnel_diagram: 4-stage signup funnel', async () => {
  const fd = tool('create_funnel_diagram');
  assert.ok(fd);
  const r = await fd.execute({
    title: 'Q2 Signup Funnel',
    subtitle: 'SiraGPT — 2026',
    stages: [
      { label: 'Visitors',  value: 10000, description: 'organic + paid traffic' },
      { label: 'Signed up', value: 1200,  description: 'created account' },
      { label: 'Activated', value: 520,   description: 'completed first task' },
      { label: 'Paying',    value: 96,    description: 'converted to Pro' },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.stages, 4);
  assert.equal(r.topValue, 10000);
  assert.equal(r.endValue, 96);
  // 96 / 10000 = 0.96%
  assert.ok(Math.abs(r.totalConversionPct - 1.0) < 0.5, `total conversion ≈ 0.96%, got ${r.totalConversionPct}`);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('Q2 Signup Funnel'));
  assert.ok(svg.includes('Visitors'));
  assert.ok(svg.includes('Paying'));
  // Counts formatted (10K, 1,200, 520, 96)
  assert.ok(svg.includes('10K') || svg.includes('10,000'));
  // Conversion pills appear (e.g. 12.0% from Visitors → Signed up)
  assert.ok(/12\.\d%/.test(svg));
});

test('create_funnel_diagram: empty stages fails', async () => {
  const r = await tool('create_funnel_diagram').execute({
    title: 'Empty',
    stages: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /stages.*empty/i);
});

test('create_funnel_diagram: single stage fails (need >= 2)', async () => {
  const r = await tool('create_funnel_diagram').execute({
    title: 'One',
    stages: [{ label: 'Only', value: 100 }],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /at least 2/i);
});

test('create_funnel_diagram: caps stages at 8', async () => {
  const tenStages = Array.from({ length: 10 }, (_, i) => ({ label: `Stage ${i + 1}`, value: 1000 - i * 50 }));
  const r = await tool('create_funnel_diagram').execute({
    title: 'Overflow',
    stages: tenStages,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.stages, 8);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Stage 1'));
  assert.ok(svg.includes('Stage 8'));
  assert.equal(svg.includes('Stage 9'), false);
});

test('create_funnel_diagram: showConversion=false hides per-stage conversion pills', async () => {
  // Use values where the end-to-end conversion (rendered in the header
  // line) differs from the per-stage conversion (which we want hidden).
  const r = await tool('create_funnel_diagram').execute({
    title: 'No conversion',
    stages: [
      { label: 'A', value: 1000 },
      { label: 'B', value: 750 },
      { label: 'C', value: 500 },
    ],
    showConversion: false,
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // Per-stage conversion pill: A→B = 75.0% (not the same as the end-to-end
  // 50.0% rendered in the header). Hidden when showConversion=false.
  assert.equal(/75\.\d%/.test(svg), false, 'per-stage 75% pill should be hidden');
  // The end-to-end 50% in the header is intentional — keep it.
  assert.ok(svg.includes('50.0%'));
});

test('create_funnel_diagram: showDropoff=false hides drop-off side annotations', async () => {
  const r = await tool('create_funnel_diagram').execute({
    title: 'No dropoff',
    stages: [
      { label: 'A', value: 1000 },
      { label: 'B', value: 500 },
    ],
    showDropoff: false,
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // No "↓ N" drop-off arrow should appear
  assert.equal(svg.includes('↓'), false);
});

test('create_funnel_diagram: zero values clamp without crash', async () => {
  const r = await tool('create_funnel_diagram').execute({
    title: 'Zero edge',
    stages: [
      { label: 'A', value: 100 },
      { label: 'B', value: 0 },
      { label: 'C', value: 0 },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.endValue, 0);
  // 0/100 → 0%
  assert.equal(r.totalConversionPct, 0);
});

test('create_funnel_diagram: per-stage color override', async () => {
  const r = await tool('create_funnel_diagram').execute({
    title: 'Custom',
    stages: [
      { label: 'A', value: 100, color: '#FF00FF' },
      { label: 'B', value: 50,  color: '#00FFFF' },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.toUpperCase().includes('#FF00FF'));
  assert.ok(svg.toUpperCase().includes('#00FFFF'));
});

test('create_funnel_diagram: xml-escapes labels and descriptions', async () => {
  const r = await tool('create_funnel_diagram').execute({
    title: 'XSS',
    stages: [
      { label: '<script>x</script>', value: 100 },
      { label: 'Safe', value: 50, description: '"quoted"' },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>x</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;quoted&quot;'));
});

test('create_funnel_diagram: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_funnel_diagram').execute({
      title: `Theme ${theme}`,
      stages: [{ label: 'A', value: 100 }, { label: 'B', value: 50 }],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_funnel_diagram: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_funnel_diagram').execute({
    title: 'Events',
    stages: [{ label: 'A', value: 100 }, { label: 'B', value: 50 }],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_value_proposition_canvas ──────────────────────────────

test('create_value_proposition_canvas: full 6-section canvas', async () => {
  const vpc = tool('create_value_proposition_canvas');
  assert.ok(vpc);
  const r = await vpc.execute({
    title: 'SiraGPT VPC',
    subtitle: 'SMB segment LATAM',
    customerJobs: ['Analizar documentos legales', 'Generar reportes rápido'],
    pains: ['LLM API costos altos', 'Resultados inconsistentes en español'],
    gains: ['Insights accionables', 'Tiempo ahorrado'],
    productsServices: ['Chat AI español-first', 'Pipeline de documentos pro'],
    painRelievers: ['Cache local', 'Validación deterministica'],
    gainCreators: ['Análisis profesional sin LLM', 'Plantillas españolas'],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.ok(r.filename?.endsWith('.svg'));
  assert.equal(r.total, 12);
  assert.equal(r.counts.customerJobs, 2);
  assert.equal(r.counts.pains, 2);
  assert.equal(r.counts.gainCreators, 2);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('SiraGPT VPC'));
  assert.ok(svg.includes('CUSTOMER PROFILE'));
  assert.ok(svg.includes('VALUE MAP'));
  assert.ok(svg.includes('Customer Jobs'));
  assert.ok(svg.includes('Pains'));
  assert.ok(svg.includes('Gains'));
  assert.ok(svg.includes('Products &amp; Services') || svg.includes('Products & Services'));
  assert.ok(svg.includes('Pain Relievers'));
  assert.ok(svg.includes('Gain Creators'));
  assert.ok(svg.includes('FIT'));
  // Items appear
  assert.ok(svg.includes('Analizar documentos'));
  assert.ok(svg.includes('Cache local'));
});

test('create_value_proposition_canvas: partial canvas with only Customer Jobs', async () => {
  const r = await tool('create_value_proposition_canvas').execute({
    title: 'Lean VPC',
    customerJobs: ['Just the customer job'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.counts.customerJobs, 1);
  assert.equal(r.counts.pains, 0);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Just the customer job'));
  // Other sections render "vacío" placeholder
  assert.ok(svg.includes('— vacío —'));
});

test('create_value_proposition_canvas: empty canvas fails', async () => {
  const r = await tool('create_value_proposition_canvas').execute({
    title: 'Empty',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /empty|provide at least/i);
});

test('create_value_proposition_canvas: non-array section fails fast', async () => {
  const r = await tool('create_value_proposition_canvas').execute({
    title: 'Bad input',
    customerJobs: 'should be array',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /must be arrays/i);
});

test('create_value_proposition_canvas: caps items at 6 per section', async () => {
  const eightItems = Array.from({ length: 8 }, (_, i) => `Item ${i + 1}`);
  const r = await tool('create_value_proposition_canvas').execute({
    title: 'Overflow',
    customerJobs: eightItems,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.counts.customerJobs, 6, 'should cap at 6 items');
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Item 1'));
  assert.ok(svg.includes('Item 6'));
  assert.equal(svg.includes('Item 7'), false);
});

test('create_value_proposition_canvas: xml-escapes content', async () => {
  const r = await tool('create_value_proposition_canvas').execute({
    title: 'XSS',
    customerJobs: ['<script>evil</script>'],
    productsServices: ['"injected"'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>evil</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_value_proposition_canvas: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_value_proposition_canvas').execute({
      title: `Theme ${theme}`,
      customerJobs: ['j'],
      productsServices: ['p'],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_value_proposition_canvas: counts object exposes all 6 section sizes', async () => {
  const r = await tool('create_value_proposition_canvas').execute({
    title: 'Counts shape',
    customerJobs: ['j'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  for (const k of ['customerJobs', 'pains', 'gains', 'productsServices', 'painRelievers', 'gainCreators']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.counts, k), `counts.${k} should be present`);
    assert.equal(typeof r.counts[k], 'number');
  }
});

test('create_value_proposition_canvas: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_value_proposition_canvas').execute({
    title: 'Events',
    customerJobs: ['x'],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_pestel_analysis ───────────────────────────────────────

test('create_pestel_analysis: full 6-section analysis', async () => {
  const pa = tool('create_pestel_analysis');
  assert.ok(pa);
  const r = await pa.execute({
    title: 'LATAM AI PESTEL',
    subtitle: 'Mercado 2026',
    political: ['Data protection laws', 'AI governance frameworks'],
    economic: ['USD volatility', 'Inflation 8%'],
    social: ['Digital adoption rise', 'Remote work norm'],
    technological: ['LLM adoption', '5G rollout'],
    environmental: ['ESG pressure', 'Renewable energy'],
    legal: ['GDPR-equivalent laws', 'Labor reform'],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 12);
  assert.equal(r.counts.political, 2);
  assert.equal(r.counts.economic, 2);
  assert.equal(r.counts.legal, 2);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('LATAM AI PESTEL'));
  assert.ok(svg.includes('POLITICAL'));
  assert.ok(svg.includes('ECONOMIC'));
  assert.ok(svg.includes('SOCIAL'));
  assert.ok(svg.includes('TECHNOLOGICAL'));
  assert.ok(svg.includes('ENVIRONMENTAL'));
  assert.ok(svg.includes('LEGAL'));
  assert.ok(svg.includes('Data protection laws'));
  assert.ok(svg.includes('USD volatility'));
});

test('create_pestel_analysis: only Technological populated', async () => {
  const r = await tool('create_pestel_analysis').execute({
    title: 'Tech-only',
    technological: ['Solo LLM trend'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.counts.technological, 1);
  assert.equal(r.counts.political, 0);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Solo LLM trend'));
  assert.ok(svg.includes('— sin elementos —'));
});

test('create_pestel_analysis: empty fails', async () => {
  const r = await tool('create_pestel_analysis').execute({
    title: 'Empty',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /empty|provide at least/i);
});

test('create_pestel_analysis: non-array section fails fast', async () => {
  const r = await tool('create_pestel_analysis').execute({
    title: 'Bad',
    political: 'should be array',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /must be arrays/i);
});

test('create_pestel_analysis: caps items at 6 per section', async () => {
  const eightItems = Array.from({ length: 8 }, (_, i) => `Item ${i + 1}`);
  const r = await tool('create_pestel_analysis').execute({
    title: 'Overflow',
    political: eightItems,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.counts.political, 6);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Item 6'));
  assert.equal(svg.includes('Item 7'), false);
});

test('create_pestel_analysis: xml-escapes content', async () => {
  const r = await tool('create_pestel_analysis').execute({
    title: 'XSS',
    political: ['<script>evil</script>'],
    legal: ['"injected"'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>evil</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_pestel_analysis: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_pestel_analysis').execute({
      title: `Theme ${theme}`,
      political: ['p'],
      economic: ['e'],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_pestel_analysis: counts object exposes all 6 section sizes', async () => {
  const r = await tool('create_pestel_analysis').execute({
    title: 'Counts',
    political: ['p'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  for (const k of ['political', 'economic', 'social', 'technological', 'environmental', 'legal']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.counts, k), `counts.${k} should be present`);
    assert.equal(typeof r.counts[k], 'number');
  }
});

test('create_pestel_analysis: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_pestel_analysis').execute({
    title: 'Events',
    political: ['x'],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_radar_chart ───────────────────────────────────────────

test('create_radar_chart: 5-axis 2-series vendor benchmark', async () => {
  const rc = tool('create_radar_chart');
  assert.ok(rc);
  const r = await rc.execute({
    title: 'Vendor Scorecard',
    subtitle: 'Q2 2026 evaluation',
    axes: ['Price', 'Docs', 'API', 'Support', 'Uptime'],
    series: [
      { name: 'Vendor A', values: [4, 5, 4, 3, 5] },
      { name: 'Vendor B', values: [5, 3, 4, 4, 4] },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.axes, 5);
  assert.equal(r.series, 2);
  assert.equal(r.max, 5);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('Vendor Scorecard'));
  assert.ok(svg.includes('Vendor A'));
  assert.ok(svg.includes('Vendor B'));
  assert.ok(svg.includes('Price'));
  assert.ok(svg.includes('Uptime'));
  // Should contain polygon elements (one per ring + one per series)
  const polygonCount = (svg.match(/<polygon /g) || []).length;
  assert.ok(polygonCount >= 7, `expected at least 7 polygons (5 grid rings + 2 series), got ${polygonCount}`);
});

test('create_radar_chart: auto-detects max from values', async () => {
  const r = await tool('create_radar_chart').execute({
    title: 'Auto-max',
    axes: ['A', 'B', 'C'],
    series: [{ name: 'S', values: [3, 7, 5] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.max, 7);
});

test('create_radar_chart: explicit max overrides auto-detect', async () => {
  const r = await tool('create_radar_chart').execute({
    title: 'Explicit',
    axes: ['A', 'B', 'C'],
    series: [{ name: 'S', values: [1, 2, 3] }],
    max: 10,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.max, 10);
});

test('create_radar_chart: fewer than 3 axes fails', async () => {
  const r = await tool('create_radar_chart').execute({
    title: 'Too few',
    axes: ['A', 'B'],
    series: [{ name: 'S', values: [1, 2] }],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /at least 3 axes/i);
});

test('create_radar_chart: more than 8 axes fails', async () => {
  const r = await tool('create_radar_chart').execute({
    title: 'Too many',
    axes: ['A','B','C','D','E','F','G','H','I'],
    series: [{ name: 'S', values: [1,2,3,4,5,6,7,8,9] }],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /at most 8 axes/i);
});

test('create_radar_chart: empty series fails', async () => {
  const r = await tool('create_radar_chart').execute({
    title: 'No series',
    axes: ['A','B','C'],
    series: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /series.*empty/i);
});

test('create_radar_chart: caps series at 4', async () => {
  const sixSeries = Array.from({ length: 6 }, (_, i) => ({ name: `S${i+1}`, values: [3,3,3] }));
  const r = await tool('create_radar_chart').execute({
    title: 'Many',
    axes: ['A','B','C'],
    series: sixSeries,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.series, 4);
});

test('create_radar_chart: NaN / missing values render as 0', async () => {
  const r = await tool('create_radar_chart').execute({
    title: 'Bad values',
    axes: ['A','B','C'],
    series: [{ name: 'S', values: [NaN, null, 3] }],
    max: 10,
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  // No literal NaN should appear
  assert.equal(svg.includes('NaN'), false);
});

test('create_radar_chart: xml-escapes labels', async () => {
  const r = await tool('create_radar_chart').execute({
    title: 'XSS',
    axes: ['<script>x</script>', 'Safe', 'Other'],
    series: [{ name: '"injected"', values: [1, 2, 3] }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>x</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_radar_chart: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_radar_chart').execute({
      title: `Theme ${theme}`,
      axes: ['A','B','C'],
      series: [{ name: 'S', values: [1, 2, 3] }],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_radar_chart: per-series color override', async () => {
  const r = await tool('create_radar_chart').execute({
    title: 'Custom',
    axes: ['A','B','C'],
    series: [
      { name: 'A', values: [1, 2, 3], color: '#FF00FF' },
      { name: 'B', values: [2, 3, 1], color: '#00FFFF' },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.toUpperCase().includes('#FF00FF'));
  assert.ok(svg.toUpperCase().includes('#00FFFF'));
});

test('create_radar_chart: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_radar_chart').execute({
    title: 'Events',
    axes: ['A','B','C'],
    series: [{ name: 'S', values: [1, 2, 3] }],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_user_journey_map ──────────────────────────────────────

test('create_user_journey_map: 4-stage onboarding journey', async () => {
  const uj = tool('create_user_journey_map');
  assert.ok(uj);
  const r = await uj.execute({
    title: 'SiraGPT onboarding journey',
    subtitle: 'New SMB customer',
    stages: [
      { name: 'Awareness', emotion: 3, touchpoints: ['Google ad', 'Blog post'], actions: ['Search "AI español"'], thoughts: ['¿Funciona en español?'], painPoints: ['Demasiadas opciones'], opportunities: ['SEO content'] },
      { name: 'Signup', emotion: 4, touchpoints: ['Landing page'], actions: ['Create account'], painPoints: ['Pide tarjeta'], opportunities: ['Try without card'] },
      { name: 'Activation', emotion: 2, touchpoints: ['Dashboard'], actions: ['Upload doc'], painPoints: ['Errores'], opportunities: ['Better onboarding'] },
      { name: 'Retention', emotion: 5, touchpoints: ['Email digest'], actions: ['Daily use'], opportunities: ['Referral program'] },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.stages, 4);
  assert.equal(r.lanes, 5);
  // Avg emotion = (3+4+2+5)/4 = 3.5
  assert.equal(r.avgEmotion, 3.5);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('SiraGPT onboarding journey'));
  assert.ok(svg.includes('EMOCIÓN'));
  assert.ok(svg.includes('TOUCHPOINTS'));
  assert.ok(svg.includes('USER ACTIONS'));
  assert.ok(svg.includes('THOUGHTS'));
  assert.ok(svg.includes('PAIN POINTS'));
  assert.ok(svg.includes('OPPORTUNITIES'));
  assert.ok(svg.includes('Awareness'));
  assert.ok(svg.includes('Retention'));
  assert.ok(svg.includes('Google ad'));
});

test('create_user_journey_map: empty stages fails', async () => {
  const r = await tool('create_user_journey_map').execute({
    title: 'Empty',
    stages: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /stages.*empty/i);
});

test('create_user_journey_map: single stage fails (need >= 2)', async () => {
  const r = await tool('create_user_journey_map').execute({
    title: 'One',
    stages: [{ name: 'Only', emotion: 3 }],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /at least 2/i);
});

test('create_user_journey_map: caps stages at 8', async () => {
  const tenStages = Array.from({ length: 10 }, (_, i) => ({ name: `S${i + 1}`, emotion: 3 }));
  const r = await tool('create_user_journey_map').execute({
    title: 'Overflow',
    stages: tenStages,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.stages, 8);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('S1'));
  assert.ok(svg.includes('S8'));
  assert.equal(svg.includes('S9'), false);
});

test('create_user_journey_map: emotion is clamped to [1, 5]', async () => {
  const r = await tool('create_user_journey_map').execute({
    title: 'Clamp',
    stages: [
      { name: 'A', emotion: 99 },
      { name: 'B', emotion: -5 },
      { name: 'C', emotion: undefined },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  // Avg = (5 + 1 + 3) / 3 = 3.0 (undefined defaults to 3)
  assert.equal(r.avgEmotion, 3);
});

test('create_user_journey_map: lanes with empty items show "—" placeholder', async () => {
  const r = await tool('create_user_journey_map').execute({
    title: 'Sparse',
    stages: [
      { name: 'A', emotion: 3 },
      { name: 'B', emotion: 4 },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // All lanes are empty → 10 dash placeholders (2 stages × 5 lanes)
  const dashCount = (svg.match(/>—</g) || []).length;
  assert.ok(dashCount >= 10, `expected at least 10 placeholders, got ${dashCount}`);
});

test('create_user_journey_map: xml-escapes content', async () => {
  const r = await tool('create_user_journey_map').execute({
    title: 'XSS',
    stages: [
      { name: '<script>x</script>', emotion: 3, actions: ['"injected"'] },
      { name: 'Safe', emotion: 4 },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>x</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_user_journey_map: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_user_journey_map').execute({
      title: `Theme ${theme}`,
      stages: [{ name: 'A', emotion: 3 }, { name: 'B', emotion: 4 }],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_user_journey_map: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_user_journey_map').execute({
    title: 'Events',
    stages: [{ name: 'A', emotion: 3 }, { name: 'B', emotion: 4 }],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_okr_dashboard ─────────────────────────────────────────

test('create_okr_dashboard: 2-objective dashboard with progress bars', async () => {
  const okr = tool('create_okr_dashboard');
  assert.ok(okr);
  const r = await okr.execute({
    title: 'Q2 2026 OKRs',
    subtitle: 'SiraGPT team',
    objectives: [
      {
        title: 'Grow LATAM MRR',
        owner: 'Sales',
        keyResults: [
          { label: 'MRR LATAM',            current: 35,  target: 50,  unit: 'K$' },
          { label: 'Países LATAM activos', current: 4,   target: 6 },
          { label: 'NRR LATAM',            current: 110, target: 115, unit: '%' },
        ],
      },
      {
        title: 'Mejorar activación',
        owner: 'Product',
        keyResults: [
          { label: 'Día-7 retention', current: 28, target: 45, unit: '%' },
          { label: 'Tiempo a primer valor', current: 8, target: 4, unit: 'min' },
        ],
      },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.objectives, 2);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('Q2 2026 OKRs'));
  assert.ok(svg.includes('Grow LATAM MRR'));
  assert.ok(svg.includes('Mejorar activación'));
  assert.ok(svg.includes('KR1'));
  assert.ok(svg.includes('OBJETIVO 1'));
  assert.ok(svg.includes('OBJETIVO 2'));
  // Status pills
  assert.ok(svg.includes('ON TRACK') || svg.includes('AT RISK') || svg.includes('BEHIND'));
});

test('create_okr_dashboard: status thresholds (red < 33%, amber < 67%, green >= 67%)', async () => {
  const r = await tool('create_okr_dashboard').execute({
    title: 'Thresholds',
    objectives: [
      // 80% → green / ON TRACK
      { title: 'Green', keyResults: [{ label: 'a', current: 80, target: 100 }] },
      // 50% → amber / AT RISK
      { title: 'Amber', keyResults: [{ label: 'b', current: 50, target: 100 }] },
      // 10% → red / BEHIND
      { title: 'Red',   keyResults: [{ label: 'c', current: 10, target: 100 }] },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.tally.onTrack, 1);
  assert.equal(r.tally.atRisk, 1);
  assert.equal(r.tally.behind, 1);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('ON TRACK'));
  assert.ok(svg.includes('AT RISK'));
  assert.ok(svg.includes('BEHIND'));
});

test('create_okr_dashboard: empty objectives fails', async () => {
  const r = await tool('create_okr_dashboard').execute({
    title: 'Empty',
    objectives: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /objectives.*empty/i);
});

test('create_okr_dashboard: caps objectives at 6 and KRs at 5', async () => {
  const objs = Array.from({ length: 8 }, (_, i) => ({
    title: `O${i + 1}`,
    keyResults: Array.from({ length: 7 }, (_, k) => ({ label: `kr${k + 1}`, current: k, target: 10 })),
  }));
  const r = await tool('create_okr_dashboard').execute({
    title: 'Overflow',
    objectives: objs,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.objectives, 6, 'objective cap at 6');
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // 5 KRs per cap
  assert.ok(svg.includes('KR5'));
  // KR6 from any obj should NOT appear
  assert.equal(svg.includes('KR6'), false);
});

test('create_okr_dashboard: progress clamped to [0, 100]%', async () => {
  const r = await tool('create_okr_dashboard').execute({
    title: 'Clamp',
    objectives: [
      // Beyond target → should clamp at 100%
      { title: 'Over', keyResults: [{ label: 'over', current: 200, target: 100 }] },
      // Negative current → should clamp at 0%
      { title: 'Under', keyResults: [{ label: 'under', current: -50, target: 100 }] },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // 100% pill rendered for first obj, 0% for second
  assert.ok(svg.includes('100%'));
  assert.ok(svg.includes('0%'));
});

test('create_okr_dashboard: target=0 with current=0 treated as 100% (not NaN)', async () => {
  const r = await tool('create_okr_dashboard').execute({
    title: 'Zero target',
    objectives: [
      { title: 'Zero', keyResults: [{ label: 'kr', current: 0, target: 0 }] },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('NaN'), false);
  // 0/0 case is treated as 100% (the only sensible interpretation)
  assert.ok(svg.includes('100%'));
});

test('create_okr_dashboard: xml-escapes content', async () => {
  const r = await tool('create_okr_dashboard').execute({
    title: 'XSS',
    objectives: [
      { title: '<script>x</script>', keyResults: [{ label: '"injected"', current: 5, target: 10 }] },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>x</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_okr_dashboard: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_okr_dashboard').execute({
      title: `Theme ${theme}`,
      objectives: [{ title: 'O', keyResults: [{ label: 'k', current: 5, target: 10 }] }],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_okr_dashboard: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_okr_dashboard').execute({
    title: 'Events',
    objectives: [{ title: 'O', keyResults: [{ label: 'k', current: 5, target: 10 }] }],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_empathy_map ───────────────────────────────────────────

test('create_empathy_map: full 4-quadrant + pains/gains', async () => {
  const em = tool('create_empathy_map');
  assert.ok(em);
  const r = await em.execute({
    title: 'SMB power user',
    persona: 'Carla, COO en PYME LATAM',
    says: ['¿Funciona en español?', '¿Cuánto cuesta al mes?'],
    thinks: ['¿Vale el costo?', '¿Es confiable?'],
    does: ['Compara 3 vendors', 'Pide demos'],
    feels: ['Cauta', 'Curiosa'],
    pains: ['Demasiados vendors', 'Falta tiempo para evaluar'],
    gains: ['Ahorro de tiempo', 'Insights accionables'],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 12);
  assert.equal(r.counts.says, 2);
  assert.equal(r.counts.pains, 2);
  assert.equal(r.counts.gains, 2);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('SMB power user'));
  assert.ok(svg.includes('Carla'));
  assert.ok(svg.includes('SAYS'));
  assert.ok(svg.includes('THINKS'));
  assert.ok(svg.includes('DOES'));
  assert.ok(svg.includes('FEELS'));
  assert.ok(svg.includes('PAINS'));
  assert.ok(svg.includes('GAINS'));
  assert.ok(svg.includes('¿Funciona en español?'));
});

test('create_empathy_map: only Says populated, no pains/gains strip', async () => {
  const r = await tool('create_empathy_map').execute({
    title: 'Lean empathy',
    persona: 'Ana',
    says: ['Solo dijo esto'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.counts.says, 1);
  assert.equal(r.counts.pains, 0);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // Empty quadrants render "vacío" placeholder
  assert.ok(svg.includes('— vacío —'));
  // Pains / Gains strips should NOT render when both are empty
  assert.equal(svg.includes('PAINS'), false);
  assert.equal(svg.includes('GAINS'), false);
});

test('create_empathy_map: empty empathy map fails', async () => {
  const r = await tool('create_empathy_map').execute({
    title: 'Empty',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /empty|provide at least/i);
});

test('create_empathy_map: non-array quadrant fails fast', async () => {
  const r = await tool('create_empathy_map').execute({
    title: 'Bad',
    says: 'should be array',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /must be arrays/i);
});

test('create_empathy_map: caps items at 6 per quadrant', async () => {
  const eight = Array.from({ length: 8 }, (_, i) => `Item ${i + 1}`);
  const r = await tool('create_empathy_map').execute({
    title: 'Overflow',
    persona: 'X',
    says: eight,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.counts.says, 6);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Item 6'));
  assert.equal(svg.includes('Item 7'), false);
});

test('create_empathy_map: xml-escapes content', async () => {
  const r = await tool('create_empathy_map').execute({
    title: 'XSS',
    persona: '<script>x</script>',
    says: ['"injected"'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>x</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_empathy_map: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_empathy_map').execute({
      title: `Theme ${theme}`,
      persona: 'P',
      says: ['s'],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_empathy_map: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_empathy_map').execute({
    title: 'Events',
    persona: 'P',
    says: ['x'],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_lean_canvas ───────────────────────────────────────────

test('create_lean_canvas: full 9-block startup canvas', async () => {
  const lc = tool('create_lean_canvas');
  assert.ok(lc);
  const r = await lc.execute({
    title: 'SiraGPT Lean Canvas',
    subtitle: 'Iteración 3 — May 2026',
    problem: ['LLM API en español caro', 'Pipeline genérico no funciona'],
    customerSegments: ['PYMES LATAM', 'Equipos legales pequeños'],
    uniqueValueProposition: ['AI análisis-documentos español-first', 'Costo predictible'],
    solution: ['Pipeline determinístico', 'Cache local'],
    unfairAdvantage: ['Datos de entrenamiento LATAM', 'Marca SiraGPT'],
    channels: ['Web app', 'Referrals'],
    revenueStreams: ['Subscripción Pro $49/mes', 'Tier Enterprise'],
    costStructure: ['LLM API', 'Cloud infra', 'Soporte'],
    keyMetrics: ['MRR', 'Activación 7-día'],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 19);
  assert.equal(r.counts.problem, 2);
  assert.equal(r.counts.uniqueValueProposition, 2);
  assert.equal(r.counts.unfairAdvantage, 2);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('SiraGPT Lean Canvas'));
  assert.ok(svg.includes('PROBLEM'));
  assert.ok(svg.includes('SOLUTION'));
  assert.ok(svg.includes('UNIQUE VALUE PROPOSITION'));
  assert.ok(svg.includes('UNFAIR ADVANTAGE'));
  assert.ok(svg.includes('CHANNELS'));
  assert.ok(svg.includes('CUSTOMER SEGMENTS'));
  assert.ok(svg.includes('COST STRUCTURE'));
  assert.ok(svg.includes('REVENUE STREAMS'));
  assert.ok(svg.includes('KEY METRICS'));
  assert.ok(svg.includes('LLM API en español caro'));
  assert.ok(svg.includes('Marca SiraGPT'));
});

test('create_lean_canvas: partial canvas with only Problem populated', async () => {
  const r = await tool('create_lean_canvas').execute({
    title: 'Lean MVP',
    problem: ['Just the problem'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.counts.problem, 1);
  assert.equal(r.counts.customerSegments, 0);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Just the problem'));
  assert.ok(svg.includes('— vacío —'));
});

test('create_lean_canvas: empty canvas fails', async () => {
  const r = await tool('create_lean_canvas').execute({
    title: 'Empty',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /empty|provide at least/i);
});

test('create_lean_canvas: non-array block fails fast', async () => {
  const r = await tool('create_lean_canvas').execute({
    title: 'Bad',
    problem: 'should be array',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /must be arrays/i);
});

test('create_lean_canvas: caps items at 8 per block', async () => {
  const ten = Array.from({ length: 10 }, (_, i) => `Item ${i + 1}`);
  const r = await tool('create_lean_canvas').execute({
    title: 'Overflow',
    problem: ten,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.counts.problem, 8);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Item 8'));
  assert.equal(svg.includes('Item 9'), false);
});

test('create_lean_canvas: xml-escapes content', async () => {
  const r = await tool('create_lean_canvas').execute({
    title: 'XSS',
    problem: ['<script>evil</script>'],
    uniqueValueProposition: ['"injected"'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>evil</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_lean_canvas: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_lean_canvas').execute({
      title: `Theme ${theme}`,
      problem: ['p'],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_lean_canvas: counts object exposes all 9 block sizes', async () => {
  const r = await tool('create_lean_canvas').execute({
    title: 'Counts',
    problem: ['p'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  for (const k of ['problem', 'customerSegments', 'uniqueValueProposition', 'solution', 'unfairAdvantage', 'channels', 'revenueStreams', 'costStructure', 'keyMetrics']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.counts, k), `counts.${k} should be present`);
    assert.equal(typeof r.counts[k], 'number');
  }
});

test('create_lean_canvas: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_lean_canvas').execute({
    title: 'Events',
    problem: ['x'],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_balanced_scorecard ────────────────────────────────────

test('create_balanced_scorecard: 4-perspective full BSC', async () => {
  const bsc = tool('create_balanced_scorecard');
  assert.ok(bsc);
  const r = await bsc.execute({
    title: 'Q2 2026 BSC',
    subtitle: 'SiraGPT corporate',
    financial: [
      { objective: 'Grow MRR LATAM', measure: 'MRR USD', target: 100, current: 70, status: 'on_track' },
      { objective: 'Reduce CAC', measure: 'CAC USD', target: 200, current: 280, status: 'at_risk' },
    ],
    customer: [
      { objective: 'Improve NPS', target: 50, current: 38, status: 'at_risk' },
    ],
    internalProcess: [
      { objective: 'Speed up onboarding', measure: 'Days to first value', target: 1, current: 3, status: 'behind' },
    ],
    learningGrowth: [
      { objective: 'Upskill engineers', measure: 'Trainings/q', target: 4, current: 5, status: 'ahead' },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 5);
  assert.equal(r.counts.financial, 2);
  assert.equal(r.counts.customer, 1);
  assert.equal(r.counts.internalProcess, 1);
  assert.equal(r.counts.learningGrowth, 1);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('Q2 2026 BSC'));
  assert.ok(svg.includes('FINANCIAL'));
  assert.ok(svg.includes('CUSTOMER'));
  assert.ok(svg.includes('INTERNAL PROCESS'));
  assert.ok(svg.includes('LEARNING &amp; GROWTH') || svg.includes('LEARNING & GROWTH'));
  assert.ok(svg.includes('Grow MRR LATAM'));
  assert.ok(svg.includes('Upskill engineers'));
  // Status pills
  assert.ok(svg.includes('ON TRACK'));
  assert.ok(svg.includes('AT RISK'));
  assert.ok(svg.includes('BEHIND'));
  assert.ok(svg.includes('AHEAD'));
  // Cause-effect arrow label
  assert.ok(svg.includes('CAUSA'));
});

test('create_balanced_scorecard: only Financial populated', async () => {
  const r = await tool('create_balanced_scorecard').execute({
    title: 'Solo Financial',
    financial: [{ objective: 'Solo objective' }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.counts.financial, 1);
  assert.equal(r.counts.customer, 0);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Solo objective'));
  // Empty bands render "sin objetivos" placeholder
  assert.ok(svg.includes('— sin objetivos —'));
});

test('create_balanced_scorecard: empty BSC fails', async () => {
  const r = await tool('create_balanced_scorecard').execute({
    title: 'Empty',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /empty|provide at least/i);
});

test('create_balanced_scorecard: non-array perspective fails fast', async () => {
  const r = await tool('create_balanced_scorecard').execute({
    title: 'Bad',
    financial: 'should be array',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /must be arrays/i);
});

test('create_balanced_scorecard: caps objectives at 6 per perspective', async () => {
  const eight = Array.from({ length: 8 }, (_, i) => ({ objective: `Obj ${i + 1}` }));
  const r = await tool('create_balanced_scorecard').execute({
    title: 'Overflow',
    financial: eight,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.counts.financial, 6);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Obj 6'));
  assert.equal(svg.includes('Obj 7'), false);
});

test('create_balanced_scorecard: invalid status ignored (no pill rendered)', async () => {
  const r = await tool('create_balanced_scorecard').execute({
    title: 'Bad status',
    financial: [{ objective: 'x', status: 'rainbow' }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // None of the valid status labels should appear
  assert.equal(svg.includes('AHEAD'), false);
  assert.equal(svg.includes('ON TRACK'), false);
  assert.equal(svg.includes('AT RISK'), false);
  assert.equal(svg.includes('BEHIND'), false);
});

test('create_balanced_scorecard: xml-escapes objective content', async () => {
  const r = await tool('create_balanced_scorecard').execute({
    title: 'XSS',
    financial: [{ objective: '<script>evil</script>', measure: '"injected"' }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>evil</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_balanced_scorecard: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_balanced_scorecard').execute({
      title: `Theme ${theme}`,
      financial: [{ objective: 'o' }],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_balanced_scorecard: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_balanced_scorecard').execute({
    title: 'Events',
    financial: [{ objective: 'o' }],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_ansoff_matrix ─────────────────────────────────────────

test('create_ansoff_matrix: full 4-quadrant growth strategy', async () => {
  const am = tool('create_ansoff_matrix');
  assert.ok(am);
  const r = await am.execute({
    title: '2027 Growth strategy',
    subtitle: 'SiraGPT',
    marketPenetration: ['Upsell Pro tier', 'Reduce churn -2%'],
    marketDevelopment: ['Expand to Brasil', 'Open BR market segment'],
    productDevelopment: ['AI generative video', 'Voice features'],
    diversification: ['Launch Enterprise GovCloud'],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 7);
  assert.equal(r.counts.marketPenetration, 2);
  assert.equal(r.counts.diversification, 1);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('2027 Growth strategy'));
  assert.ok(svg.includes('MARKET PENETRATION'));
  assert.ok(svg.includes('MARKET DEVELOPMENT'));
  assert.ok(svg.includes('PRODUCT DEVELOPMENT'));
  assert.ok(svg.includes('DIVERSIFICATION'));
  assert.ok(svg.includes('EXISTING MARKET'));
  assert.ok(svg.includes('NEW MARKET'));
  assert.ok(svg.includes('EXISTING PRODUCT'));
  assert.ok(svg.includes('NEW PRODUCT'));
  // Risk pills (LOW, MEDIUM × 2, HIGH)
  assert.ok(svg.includes('LOW RISK'));
  assert.ok(svg.includes('MEDIUM RISK'));
  assert.ok(svg.includes('HIGH RISK'));
});

test('create_ansoff_matrix: only Diversification populated', async () => {
  const r = await tool('create_ansoff_matrix').execute({
    title: 'Aggressive',
    diversification: ['New product in new market'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.counts.diversification, 1);
  assert.equal(r.counts.marketPenetration, 0);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('New product in new market'));
  assert.ok(svg.includes('— sin iniciativas —'));
});

test('create_ansoff_matrix: empty matrix fails', async () => {
  const r = await tool('create_ansoff_matrix').execute({
    title: 'Empty',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /empty|provide at least/i);
});

test('create_ansoff_matrix: non-array quadrant fails fast', async () => {
  const r = await tool('create_ansoff_matrix').execute({
    title: 'Bad',
    marketPenetration: 'should be array',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /must be arrays/i);
});

test('create_ansoff_matrix: caps initiatives at 8 per quadrant', async () => {
  const ten = Array.from({ length: 10 }, (_, i) => `Init ${i + 1}`);
  const r = await tool('create_ansoff_matrix').execute({
    title: 'Overflow',
    marketPenetration: ten,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.counts.marketPenetration, 8);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Init 8'));
  assert.equal(svg.includes('Init 9'), false);
});

test('create_ansoff_matrix: xml-escapes content', async () => {
  const r = await tool('create_ansoff_matrix').execute({
    title: 'XSS',
    marketPenetration: ['<script>evil</script>'],
    diversification: ['"injected"'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>evil</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_ansoff_matrix: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_ansoff_matrix').execute({
      title: `Theme ${theme}`,
      marketPenetration: ['mp'],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_ansoff_matrix: layout — MP top-left, MD top-right, PD bottom-left, DV bottom-right', async () => {
  // Verify the canonical Ansoff layout: existing market on left (existing × new),
  // existing product on top (existing × new).
  const r = await tool('create_ansoff_matrix').execute({
    title: 'Layout',
    marketPenetration: ['MP_ITEM'],
    marketDevelopment: ['MD_ITEM'],
    productDevelopment: ['PD_ITEM'],
    diversification: ['DV_ITEM'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // Source order: MP (top-left) → MD (top-right) → PD (bottom-left) → DV (bottom-right)
  const idxMP = svg.indexOf('MP_ITEM');
  const idxMD = svg.indexOf('MD_ITEM');
  const idxPD = svg.indexOf('PD_ITEM');
  const idxDV = svg.indexOf('DV_ITEM');
  assert.ok(idxMP > 0 && idxMD > idxMP, 'MP (top-left) before MD (top-right)');
  assert.ok(idxMD > 0 && idxPD > idxMD, 'MD (top-right) before PD (bottom-left)');
  assert.ok(idxPD > 0 && idxDV > idxPD, 'PD (bottom-left) before DV (bottom-right)');
});

test('create_ansoff_matrix: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_ansoff_matrix').execute({
    title: 'Events',
    marketPenetration: ['x'],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_bcg_matrix ────────────────────────────────────────────

test('create_bcg_matrix: full portfolio with all 4 quadrants', async () => {
  const bcg = tool('create_bcg_matrix');
  assert.ok(bcg);
  const r = await bcg.execute({
    title: 'SiraGPT 2026 portfolio',
    products: [
      // Star: high share, high growth
      { name: 'Pro tier',  marketShare: 1.8, marketGrowth: 22, revenue: 5_000_000 },
      // Cash cow: high share, low growth
      { name: 'Legacy',    marketShare: 1.5, marketGrowth: 4,  revenue: 8_000_000 },
      // Question mark: low share, high growth
      { name: 'Mobile',    marketShare: 0.4, marketGrowth: 28, revenue: 200_000 },
      // Dog: low share, low growth
      { name: 'Free tier', marketShare: 0.3, marketGrowth: 3,  revenue: 50_000 },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.products, 4);
  assert.equal(r.tally.stars, 1);
  assert.equal(r.tally.cashCows, 1);
  assert.equal(r.tally.questionMarks, 1);
  assert.equal(r.tally.dogs, 1);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('SiraGPT 2026 portfolio'));
  assert.ok(svg.includes('STARS'));
  assert.ok(svg.includes('CASH COWS'));
  assert.ok(svg.includes('QUESTION MARKS'));
  assert.ok(svg.includes('DOGS'));
  assert.ok(svg.includes('Pro tier'));
  assert.ok(svg.includes('Mobile'));
  // Axis labels
  assert.ok(svg.includes('RELATIVE MARKET SHARE'));
  assert.ok(svg.includes('MARKET GROWTH RATE'));
});

test('create_bcg_matrix: custom thresholds reshape the quadrants', async () => {
  const r = await tool('create_bcg_matrix').execute({
    title: 'Aggressive thresholds',
    growthThreshold: 5,    // anything ≥ 5% is "high growth"
    shareThreshold: 0.5,   // anything ≥ 0.5 share is "high share"
    products: [
      { name: 'A', marketShare: 0.6, marketGrowth: 6 }, // Star with default thresholds it'd be a dog
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  // With custom thresholds, this product lands in the Star quadrant
  assert.equal(r.tally.stars, 1);
  assert.equal(r.tally.dogs, 0);
});

test('create_bcg_matrix: empty products fails', async () => {
  const r = await tool('create_bcg_matrix').execute({
    title: 'Empty',
    products: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /products.*empty/i);
});

test('create_bcg_matrix: caps products at 20', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    name: `Prod ${i + 1}`,
    marketShare: (i % 4) * 0.5,
    marketGrowth: (i % 4) * 10,
  }));
  const r = await tool('create_bcg_matrix').execute({
    title: 'Overflow',
    products: many,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.products, 20);
});

test('create_bcg_matrix: out-of-range share/growth clamped (no SVG overflow)', async () => {
  const r = await tool('create_bcg_matrix').execute({
    title: 'Clamp',
    products: [
      { name: 'Huge', marketShare: 99, marketGrowth: 500 },
      { name: 'Tiny', marketShare: -5, marketGrowth: -10 },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  // Huge → Star (high/high), Tiny → Dog (low/low)
  assert.equal(r.tally.stars, 1);
  assert.equal(r.tally.dogs, 1);
});

test('create_bcg_matrix: xml-escapes product names', async () => {
  const r = await tool('create_bcg_matrix').execute({
    title: 'XSS',
    products: [{ name: '<script>alert(1)</script>', marketShare: 1.5, marketGrowth: 15 }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>alert(1)</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
});

test('create_bcg_matrix: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_bcg_matrix').execute({
      title: `Theme ${theme}`,
      products: [{ name: 'X', marketShare: 1, marketGrowth: 10 }],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_bcg_matrix: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_bcg_matrix').execute({
    title: 'Events',
    products: [{ name: 'X', marketShare: 1, marketGrowth: 10 }],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_moscow_chart ──────────────────────────────────────────

test('create_moscow_chart: full 4-column MoSCoW', async () => {
  const mc = tool('create_moscow_chart');
  assert.ok(mc);
  const r = await mc.execute({
    title: 'MVP Sprint 14',
    subtitle: 'SiraGPT MVP scope',
    mustHave: ['Auth + login', 'Document upload', 'Chat AI core'],
    shouldHave: ['Email verification', 'Password reset', '2FA optional'],
    couldHave: ['Dark mode', 'Export to PDF'],
    wontHave: ['Native mobile apps', 'Plugins marketplace'],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 10);
  assert.equal(r.counts.mustHave, 3);
  assert.equal(r.counts.shouldHave, 3);
  assert.equal(r.counts.couldHave, 2);
  assert.equal(r.counts.wontHave, 2);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('MVP Sprint 14'));
  assert.ok(svg.includes('MUST HAVE'));
  assert.ok(svg.includes('SHOULD HAVE'));
  assert.ok(svg.includes('COULD HAVE'));
  assert.ok(svg.includes("WON'T HAVE") || svg.includes("WON&#39;T HAVE"));
  assert.ok(svg.includes('Auth + login') || svg.includes('Auth + login'));
  assert.ok(svg.includes('Dark mode'));
});

test('create_moscow_chart: only Must Have populated', async () => {
  const r = await tool('create_moscow_chart').execute({
    title: 'Lean MVP',
    mustHave: ['Just the critical bit'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.counts.mustHave, 1);
  assert.equal(r.counts.shouldHave, 0);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Just the critical bit'));
  // Empty columns render "sin items" placeholder
  assert.ok(svg.includes('— sin items —'));
});

test('create_moscow_chart: empty fails', async () => {
  const r = await tool('create_moscow_chart').execute({
    title: 'Empty',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /empty|provide at least/i);
});

test('create_moscow_chart: non-array bucket fails fast', async () => {
  const r = await tool('create_moscow_chart').execute({
    title: 'Bad',
    mustHave: 'should be array',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /must be arrays/i);
});

test('create_moscow_chart: caps items at 10 per column', async () => {
  const fifteen = Array.from({ length: 15 }, (_, i) => `Item ${i + 1}`);
  const r = await tool('create_moscow_chart').execute({
    title: 'Overflow',
    mustHave: fifteen,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.counts.mustHave, 10);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('Item 10'));
  assert.equal(svg.includes('Item 11'), false);
});

test('create_moscow_chart: xml-escapes content', async () => {
  const r = await tool('create_moscow_chart').execute({
    title: 'XSS',
    mustHave: ['<script>evil</script>'],
    wontHave: ['"injected"'],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>evil</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_moscow_chart: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_moscow_chart').execute({
      title: `Theme ${theme}`,
      mustHave: ['m'],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_moscow_chart: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_moscow_chart').execute({
    title: 'Events',
    mustHave: ['x'],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_decision_tree ─────────────────────────────────────────

test('create_decision_tree: 3-level eligibility tree', async () => {
  const dt = tool('create_decision_tree');
  assert.ok(dt);
  const r = await dt.execute({
    title: 'Account eligibility',
    root: {
      text: 'Has signed up?',
      branches: [
        { label: 'Yes', node: {
          text: 'Has activated?',
          branches: [
            { label: 'Yes', node: { text: 'Pro tier ready', isOutcome: true } },
            { label: 'No',  node: { text: 'Send onboarding', isOutcome: true } },
          ],
        }},
        { label: 'No',  node: { text: 'Show signup CTA', isOutcome: true } },
      ],
    },
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.nodes, 5);
  // 3 leaves are outcomes; 2 are decisions
  assert.equal(r.outcomes, 3);
  assert.equal(r.decisions, 2);
  assert.equal(r.depth, 3);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('Account eligibility'));
  assert.ok(svg.includes('Has signed up?'));
  assert.ok(svg.includes('Pro tier ready'));
  assert.ok(svg.includes('Show signup CTA'));
  // Branch label pills
  assert.ok(svg.includes('Yes'));
  assert.ok(svg.includes('No'));
});

test('create_decision_tree: single root with no branches counts as 1 outcome', async () => {
  const r = await tool('create_decision_tree').execute({
    title: 'Lonely root',
    root: { text: 'Just decide', isOutcome: true },
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.nodes, 1);
  assert.equal(r.outcomes, 1);
  assert.equal(r.decisions, 0);
  assert.equal(r.depth, 1);
});

test('create_decision_tree: missing root fails', async () => {
  const r = await tool('create_decision_tree').execute({
    title: 'Empty',
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /root.*missing|invalid/i);
});

test('create_decision_tree: caps depth at 4 (deeper nodes become outcomes)', async () => {
  // Build a 6-level deep tree; should be cut to 4 levels.
  function nest(depth) {
    if (depth === 0) return { text: 'leaf', isOutcome: true };
    return { text: `level ${depth}`, branches: [{ label: 'go', node: nest(depth - 1) }] };
  }
  const r = await tool('create_decision_tree').execute({
    title: 'Deep',
    root: nest(6),
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.depth, 4, 'depth should be clamped to 4');
});

test('create_decision_tree: caps branches at 4 per node', async () => {
  const root = {
    text: 'Pick',
    branches: Array.from({ length: 7 }, (_, i) => ({
      label: `b${i + 1}`,
      node: { text: `O${i + 1}`, isOutcome: true },
    })),
  };
  const r = await tool('create_decision_tree').execute({
    title: 'Wide',
    root,
  }, fakeCtx());
  assert.equal(r.ok, true);
  // root + 4 outcome leaves = 5 nodes
  assert.equal(r.nodes, 5);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('O1'));
  assert.ok(svg.includes('O4'));
  assert.equal(svg.includes('O5'), false, 'branches beyond the 4-cap should not render');
});

test('create_decision_tree: xml-escapes node text and branch labels', async () => {
  const r = await tool('create_decision_tree').execute({
    title: 'XSS',
    root: {
      text: '<script>evil</script>',
      branches: [
        { label: '"injected"', node: { text: 'Safe', isOutcome: true } },
      ],
    },
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>evil</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_decision_tree: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_decision_tree').execute({
      title: `Theme ${theme}`,
      root: {
        text: 'x?',
        branches: [
          { label: 'a', node: { text: 'A', isOutcome: true } },
          { label: 'b', node: { text: 'B', isOutcome: true } },
        ],
      },
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_decision_tree: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_decision_tree').execute({
    title: 'Events',
    root: { text: 'x', isOutcome: true },
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_concept_map ───────────────────────────────────────────

test('create_concept_map: 6-node AI components map with 5 edges', async () => {
  const cm = tool('create_concept_map');
  assert.ok(cm);
  const r = await cm.execute({
    title: 'AI Agent Components',
    subtitle: 'sirAGPT architecture',
    nodes: [
      { id: 'p', label: 'Planner',  category: 'core' },
      { id: 'e', label: 'Executor', category: 'core' },
      { id: 'm', label: 'Memory',   category: 'storage' },
      { id: 'r', label: 'RAG',      category: 'storage' },
      { id: 't', label: 'Tools',    category: 'integration' },
      { id: 'o', label: 'Observer', category: 'integration' },
    ],
    edges: [
      { from: 'p', to: 'e', label: 'delegates' },
      { from: 'e', to: 't', label: 'invokes' },
      { from: 'e', to: 'm', label: 'writes' },
      { from: 'p', to: 'r', label: 'queries' },
      { from: 'o', to: 'e', label: 'watches' },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.nodes, 6);
  assert.equal(r.edges, 5);
  assert.equal(r.categories, 3);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('AI Agent Components'));
  assert.ok(svg.includes('Planner'));
  assert.ok(svg.includes('Executor'));
  assert.ok(svg.includes('delegates'));
  assert.ok(svg.includes('CATEGORÍAS'));
});

test('create_concept_map: fewer than 2 nodes fails', async () => {
  const r = await tool('create_concept_map').execute({
    title: 'Solo',
    nodes: [{ id: 'a', label: 'A' }],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /at least 2 nodes/i);
});

test('create_concept_map: more than 12 nodes fails', async () => {
  const r = await tool('create_concept_map').execute({
    title: 'Too many',
    nodes: Array.from({ length: 15 }, (_, i) => ({ id: `n${i}`, label: `N${i}` })),
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /at most 12 nodes/i);
});

test('create_concept_map: invalid edge ids are silently dropped', async () => {
  const r = await tool('create_concept_map').execute({
    title: 'Mixed',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    edges: [
      { from: 'a', to: 'b', label: 'valid' },
      { from: 'a', to: 'nonexistent', label: 'invalid' },
      { from: 'nope', to: 'a', label: 'invalid2' },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  // Only the valid a→b edge survives
  assert.equal(r.edges, 1);
});

test('create_concept_map: caps edges at 30', async () => {
  const nodes = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
  const manyEdges = Array.from({ length: 50 }, (_, i) => ({ from: 'a', to: 'b', label: `e${i}` }));
  const r = await tool('create_concept_map').execute({
    title: 'Many edges',
    nodes,
    edges: manyEdges,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.edges, 30, 'edges capped at 30');
});

test('create_concept_map: no edges still renders (just disconnected nodes)', async () => {
  const r = await tool('create_concept_map').execute({
    title: 'Isolated',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.edges, 0);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('A'));
  assert.ok(svg.includes('B'));
});

test('create_concept_map: xml-escapes node labels and edge labels', async () => {
  const r = await tool('create_concept_map').execute({
    title: 'XSS',
    nodes: [
      { id: '1', label: '<script>x</script>' },
      { id: '2', label: 'Safe' },
    ],
    edges: [{ from: '1', to: '2', label: '"hi"' }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>x</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;hi&quot;'));
});

test('create_concept_map: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_concept_map').execute({
      title: `Theme ${theme}`,
      nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      edges: [{ from: 'a', to: 'b' }],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_concept_map: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_concept_map').execute({
    title: 'Events',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_mindmap_radial ────────────────────────────────────────

test('create_mindmap_radial: 4-branch mindmap with sub-topics', async () => {
  const mm = tool('create_mindmap_radial');
  assert.ok(mm);
  const r = await mm.execute({
    title: 'Sprint 14 scope',
    subtitle: 'SiraGPT team',
    centralTopic: 'Sprint 14',
    branches: [
      { label: 'Auth',     children: ['Login', 'OAuth', '2FA'] },
      { label: 'Billing',  children: ['Stripe', 'Refunds'] },
      { label: 'Onboard',  children: ['Tour', 'Sample docs'] },
      { label: 'Docs API', children: ['OpenAPI'] },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.branches, 4);
  assert.equal(r.subtopics, 8);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('Sprint 14 scope'));
  assert.ok(svg.includes('Sprint 14'));
  assert.ok(svg.includes('Auth'));
  assert.ok(svg.includes('Login'));
  assert.ok(svg.includes('Stripe'));
  assert.ok(svg.includes('OpenAPI'));
});

test('create_mindmap_radial: single branch fails (need >= 2)', async () => {
  const r = await tool('create_mindmap_radial').execute({
    title: 'Lonely',
    centralTopic: 'X',
    branches: [{ label: 'only' }],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /at least 2/i);
});

test('create_mindmap_radial: empty branches fails', async () => {
  const r = await tool('create_mindmap_radial').execute({
    title: 'Empty',
    centralTopic: 'X',
    branches: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /branches.*empty/i);
});

test('create_mindmap_radial: caps branches at 8 and children at 5', async () => {
  const tenBranches = Array.from({ length: 10 }, (_, i) => ({
    label: `B${i + 1}`,
    children: Array.from({ length: 7 }, (_, j) => `c${j + 1}`),
  }));
  const r = await tool('create_mindmap_radial').execute({
    title: 'Overflow',
    centralTopic: 'Root',
    branches: tenBranches,
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.branches, 8, 'branches cap at 8');
  // 8 branches × 5 children cap = 40 subtopics
  assert.equal(r.subtopics, 40);
});

test('create_mindmap_radial: per-branch color override', async () => {
  const r = await tool('create_mindmap_radial').execute({
    title: 'Colors',
    centralTopic: 'Root',
    branches: [
      { label: 'A', color: '#FF00FF' },
      { label: 'B', color: '#00FFFF' },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.toUpperCase().includes('#FF00FF'));
  assert.ok(svg.toUpperCase().includes('#00FFFF'));
});

test('create_mindmap_radial: xml-escapes content', async () => {
  const r = await tool('create_mindmap_radial').execute({
    title: 'XSS',
    centralTopic: '<script>x</script>',
    branches: [
      { label: '"injected"', children: ['<img onerror=x>'] },
      { label: 'Safe' },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>x</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_mindmap_radial: branches without children still render', async () => {
  const r = await tool('create_mindmap_radial').execute({
    title: 'No children',
    centralTopic: 'Root',
    branches: [
      { label: 'A' },
      { label: 'B' },
      { label: 'C' },
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.subtopics, 0);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.includes('A'));
});

test('create_mindmap_radial: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_mindmap_radial').execute({
      title: `Theme ${theme}`,
      centralTopic: 'Root',
      branches: [{ label: 'A' }, { label: 'B' }],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_mindmap_radial: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_mindmap_radial').execute({
    title: 'Events',
    centralTopic: 'Root',
    branches: [{ label: 'A' }, { label: 'B' }],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── create_swimlane_diagram ──────────────────────────────────────

test('create_swimlane_diagram: 3-actor onboarding process with handoffs', async () => {
  const sw = tool('create_swimlane_diagram');
  assert.ok(sw);
  const r = await sw.execute({
    title: 'Customer onboarding',
    subtitle: 'SiraGPT funnel',
    lanes: ['Customer', 'Sales', 'Engineering'],
    stages: ['Sign up', 'Activate', 'Use', 'Renew'],
    tasks: [
      { label: 'Fill signup form', lane: 0, stage: 0 },
      { label: 'Verify lead',      lane: 1, stage: 0 },
      { label: 'Provision instance', lane: 2, stage: 1 },
      { label: 'Run demo',         lane: 1, stage: 1 },
      { label: 'Daily use',        lane: 0, stage: 2 },
      { label: 'Renewal notice',   lane: 1, stage: 3 },
    ],
    theme: 'professional',
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.lanes, 3);
  assert.equal(r.stages, 4);
  assert.equal(r.tasks, 6);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('Customer onboarding'));
  assert.ok(svg.includes('Customer'));
  assert.ok(svg.includes('Engineering'));
  assert.ok(svg.includes('Sign up'));
  assert.ok(svg.includes('Renew'));
  assert.ok(svg.includes('Fill signup form'));
  // Task label gets wrapped to 2 lines for long strings (~18 chars/line),
  // so check the individual halves rather than the full string.
  assert.ok(svg.includes('Provision') && svg.includes('instance'));
});

test('create_swimlane_diagram: empty lanes fails', async () => {
  const r = await tool('create_swimlane_diagram').execute({
    title: 'No lanes',
    lanes: [],
    stages: ['A', 'B'],
    tasks: [{ label: 'x', lane: 0, stage: 0 }],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /lanes.*empty/i);
});

test('create_swimlane_diagram: single lane fails (need >= 2)', async () => {
  const r = await tool('create_swimlane_diagram').execute({
    title: 'One lane',
    lanes: ['A'],
    stages: ['1', '2'],
    tasks: [{ label: 'x', lane: 0, stage: 0 }],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /at least 2 lanes/i);
});

test('create_swimlane_diagram: single stage fails (need >= 2)', async () => {
  const r = await tool('create_swimlane_diagram').execute({
    title: 'One stage',
    lanes: ['A', 'B'],
    stages: ['only'],
    tasks: [{ label: 'x', lane: 0, stage: 0 }],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /at least 2 stages/i);
});

test('create_swimlane_diagram: empty tasks fails', async () => {
  const r = await tool('create_swimlane_diagram').execute({
    title: 'No tasks',
    lanes: ['A', 'B'],
    stages: ['1', '2'],
    tasks: [],
  }, fakeCtx());
  assert.equal(r.ok, false);
  assert.match(r.error || '', /tasks.*empty/i);
});

test('create_swimlane_diagram: out-of-range lane/stage clamped to valid range', async () => {
  const r = await tool('create_swimlane_diagram').execute({
    title: 'OOR',
    lanes: ['A', 'B'],
    stages: ['S1', 'S2'],
    tasks: [
      { label: 't', lane: 99, stage: 99 },  // both out of range
      { label: 'u', lane: -5, stage: -3 },  // both negative
    ],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.tasks, 2);
});

test('create_swimlane_diagram: caps lanes at 6 and stages at 7', async () => {
  const r = await tool('create_swimlane_diagram').execute({
    title: 'Overflow',
    lanes: Array.from({ length: 10 }, (_, i) => `L${i + 1}`),
    stages: Array.from({ length: 12 }, (_, i) => `S${i + 1}`),
    tasks: [{ label: 'x', lane: 0, stage: 0 }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.lanes, 6);
  assert.equal(r.stages, 7);
});

test('create_swimlane_diagram: showHandoffs=false hides arrows', async () => {
  const r = await tool('create_swimlane_diagram').execute({
    title: 'No arrows',
    lanes: ['A', 'B'],
    stages: ['1', '2'],
    tasks: [
      { label: 't1', lane: 0, stage: 0 },
      { label: 't2', lane: 1, stage: 1 },
    ],
    showHandoffs: false,
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  // No polygon-shaped arrowheads should be rendered
  assert.equal(/polygon points="[\d.-]+,[\d.-]+ [\d.-]+,[\d.-]+ [\d.-]+,[\d.-]+"/.test(svg.split('<rect')[0]), false);
});

test('create_swimlane_diagram: xml-escapes content', async () => {
  const r = await tool('create_swimlane_diagram').execute({
    title: 'XSS',
    lanes: ['<script>x</script>', 'Safe'],
    stages: ['1', '2'],
    tasks: [{ label: '"injected"', lane: 0, stage: 0 }],
  }, fakeCtx());
  assert.equal(r.ok, true);
  const svg = fs.readFileSync(assertArtifact(r), 'utf8');
  assert.equal(svg.includes('<script>x</script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;injected&quot;'));
});

test('create_swimlane_diagram: supports all four themes', async () => {
  for (const theme of ['professional', 'modern', 'minimal', 'corporate']) {
    const r = await tool('create_swimlane_diagram').execute({
      title: `Theme ${theme}`,
      lanes: ['A', 'B'],
      stages: ['1', '2'],
      tasks: [{ label: 'x', lane: 0, stage: 0 }],
      theme,
    }, fakeCtx());
    assert.equal(r.ok, true, `theme ${theme} should succeed`);
    const svg = fs.readFileSync(assertArtifact(r), 'utf8');
    assert.ok(svg.startsWith('<svg'));
  }
});

test('create_swimlane_diagram: emits expected events', async () => {
  const ctx = fakeCtx();
  await tool('create_swimlane_diagram').execute({
    title: 'Events',
    lanes: ['A', 'B'],
    stages: ['1', '2'],
    tasks: [{ label: 'x', lane: 0, stage: 0 }],
  }, ctx);
  const types = ctx._events.map(e => e.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('file_artifact'));
  assert.ok(types.includes('tool_output'));
});

// ── Cleanup ──────────────────────────────────────────────────────

test.after(() => {
  try { fs.rmSync(ARTIFACT_DIR, { recursive: true, force: true }); } catch {}
});
