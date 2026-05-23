const path = require('path');
const fs = require('fs');
const os = require('os');
const SERVICE_DIR = path.resolve('/Users/luis/Desktop/siraGPT', 'backend/src/services');
const AGENTS_DIR = path.resolve('/Users/luis/Desktop/siraGPT', 'backend/src/services/agents');
require.cache[require.resolve('openai')] = { exports: class {} };
require.cache[require.resolve(path.join(SERVICE_DIR, 'ai-service'))] = { exports: { generateImage: async()=>'x' } };
require.cache[require.resolve(path.join(SERVICE_DIR, 'viz-generator'))] = { exports: {} };
require.cache[require.resolve(path.join(AGENTS_DIR, 'code-sandbox'))] = { exports: { run: async()=>({ ok: true, stdout:'',stderr:'',exitCode:0 }) } };
require.cache[require.resolve(path.join(AGENTS_DIR, 'agent-task-persistence'))] = { exports: { saveSnapshot: async()=>{}, loadSnapshot: async()=>null } };

const ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-debug-'));
process.env.AGENT_ARTIFACT_DIR = ARTIFACT_DIR;
const { VISUAL_MEDIA_TOOLS } = require(path.join(AGENTS_DIR, 'visual-media-tools'));
(async () => {
  const tool = VISUAL_MEDIA_TOOLS.find(t => t.name === 'create_chart');
  const r = await tool.execute({
    chartType: 'bar', title: 'Stacked', labels: ['A', 'B', 'C'],
    datasets: [
      { label: 'X', data: [10, 8, 6] },
      { label: 'Y', data: [10, 8, 6] },
      { label: 'Z', data: [10, 8, 6] },
    ],
    stacked: true,
  }, { signal: new AbortController().signal });
  console.log('result:', JSON.stringify({ ok: r.ok, file: r.filename }));
  // Find file
  const files = fs.readdirSync(ARTIFACT_DIR);
  const file = files.find(f => f.endsWith(r.filename));
  if (!file) { console.log('NO FILE'); return; }
  const c = fs.readFileSync(path.join(ARTIFACT_DIR, file), 'utf8');
  console.log('size:', c.length);
  console.log('rx="0" matches:', (c.match(/rx="0"/g) || []).length);
  console.log('rect matches:', (c.match(/<rect /g) || []).length);
  // Print first stacked segment
  const m = c.match(/<rect [^>]*rx="0"[^>]*>/);
  console.log('FIRST STACK:', m ? m[0] : 'NONE');
  fs.rmSync(ARTIFACT_DIR, { recursive: true });
})();
