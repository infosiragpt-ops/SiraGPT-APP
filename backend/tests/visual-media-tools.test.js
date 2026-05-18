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

// ── Tool metadata ────────────────────────────────────────────────

test('all 13 tools have valid metadata', () => {
  assert.equal(VISUAL_MEDIA_TOOLS.length, 13);
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

// ── Cleanup ──────────────────────────────────────────────────────

test.after(() => {
  try { fs.rmSync(ARTIFACT_DIR, { recursive: true, force: true }); } catch {}
});
