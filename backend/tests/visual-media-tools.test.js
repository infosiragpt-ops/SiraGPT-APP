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
const { VISUAL_MEDIA_TOOLS } = require(path.join(AGENTS_DIR, 'visual-media-tools'));

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

// ── Tool metadata ────────────────────────────────────────────────

test('all 9 tools have valid metadata', () => {
  assert.equal(VISUAL_MEDIA_TOOLS.length, 9);
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

// ── Cleanup ──────────────────────────────────────────────────────

test.after(() => {
  try { fs.rmSync(ARTIFACT_DIR, { recursive: true, force: true }); } catch {}
});
