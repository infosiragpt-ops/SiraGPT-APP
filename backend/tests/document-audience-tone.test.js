'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-audience-tone');
const {
  classifyDocument,
  buildAudienceToneForFiles,
  renderAudienceToneBlock,
  _internal,
} = engine;
const { describeAudience, describeTone, scoreAxis, AUDIENCE_SIGNALS, TONE_SIGNALS } = _internal;

test('empty / non-string input returns general/neutral defaults', () => {
  const r1 = classifyDocument('');
  assert.equal(r1.audience, 'general');
  assert.equal(r1.tone, 'neutral');
  const r2 = classifyDocument(null);
  assert.equal(r2.audience, 'general');
});

test('legal contract text → audience: legal', () => {
  const text = `THIS AGREEMENT is entered into hereby by the parties whereas the Provider shall indemnify the Client.
Section 4.1 — Liability. Notwithstanding any other provision herein, the parties acknowledge that liability shall not exceed the fees paid.
Section 5.2 — Termination. The contract may be terminated upon material breach with thirty (30) days written notice.`;
  const r = classifyDocument(text);
  assert.equal(r.audience, 'legal', `got ${r.audience}`);
  assert.ok(r.audienceConfidence > 0.18);
});

test('technical SRE doc → audience: technical', () => {
  const text = `When the API returns HTTP 503 the SDK should not retry blindly. JSON envelopes include an idempotency-key header.
We observed elevated p99 latency on the gRPC backend; the stack trace points to a race condition in the worker pool.
Run \`kubectl describe pod\` to inspect the failure; the Dockerfile pins NodeJS 24.`;
  const r = classifyDocument(text);
  assert.equal(r.audience, 'technical');
});

test('academic paper text → audience: academic', () => {
  const text = `Abstract: We test the hypothesis that contextual chunking improves retrieval. The methodology relies on the BEIR benchmark.
Smith et al. (2023) report similar findings. Confidence interval analysis shows p < 0.05 across runs.
Future work will explore meta-analysis across the systematic review by Pérez and Vega (2024).
References:
[1] Smith, J. (2023). Contextual retrieval.
[2] Pérez, A., & Vega, M. (2024). Sistematic review on RAG.`;
  const r = classifyDocument(text);
  assert.equal(r.audience, 'academic');
});

test('marketing copy → audience: marketing', () => {
  const text = `Unlock the power of AI today! Join us now and elevate your workflow with our breakthrough platform.
Limited-time offer — sign up now and transform your business. Click here to get started!`;
  const r = classifyDocument(text);
  assert.equal(r.audience, 'marketing');
});

test('executive briefing → audience: executive', () => {
  const text = `Executive summary
This quarter's OKR review shows EBITDA grew 12% with positive ROI across our top-3 KPIs.
The board approved a Q3 2026 budget adjustment; stakeholder alignment remains strong.
Forecast: revenue runway extends 14 months. North star metric: monthly active users.`;
  const r = classifyDocument(text);
  assert.equal(r.audience, 'executive');
});

test('clinical document → audience: clinical', () => {
  const text = `Patient diagnosis: type 2 diabetes mellitus. Posology: 500 mg twice daily, adjust dosage based on creatinine clearance.
Contraindications: pediatric population, severe renal impairment. Adverse events: monitor for hypoglycaemia.
Treatment plan tailored for geriatric patients with comorbidities.`;
  const r = classifyDocument(text);
  assert.equal(r.audience, 'clinical');
});

test('formal tone detected from regulatory phrasing', () => {
  const text = `Pursuant to the agreement herein, the parties hereby acknowledge that they have read and understood the obligations enumerated above.
In accordance with section 4.2, the aforementioned provisions shall remain in force until terminated.`;
  const r = classifyDocument(text);
  assert.equal(r.tone, 'formal');
});

test('persuasive tone detected', () => {
  const text = `We must act now. It is imperative that we adopt this approach. Without a doubt, this is critical for our success.
Clearly, this is a game-changer that should be prioritized!`;
  const r = classifyDocument(text);
  assert.equal(r.tone, 'persuasive');
});

test('instructional tone detected', () => {
  const text = `Step 1: open the terminal. Step 2: run the command below. Step 3: select the option you prefer.
Follow these steps in order: first, click the menu; next, tap on settings; finally, press save.`;
  const r = classifyDocument(text);
  assert.equal(r.tone, 'instructional');
});

test('analytical tone detected', () => {
  const text = `The data suggest that performance may improve under load. However, the effect appears to weaken at higher concurrency.
Furthermore, the results indicate that, based on the evidence, scaling horizontally is preferable. In contrast, vertical scaling shows diminishing returns.`;
  const r = classifyDocument(text);
  assert.equal(r.tone, 'analytical');
});

test('urgent tone detected from deadline triggers', () => {
  const text = `URGENT!! The deadline is tomorrow. Need this ASAP — please escalate immediately.
SEV-1 incident requires action right away. P0 priority!`;
  const r = classifyDocument(text);
  assert.equal(r.tone, 'urgent');
});

test('describeAudience covers every documented label', () => {
  for (const label of AUDIENCE_SIGNALS.map((s) => s.label).concat('general')) {
    assert.ok(describeAudience(label).length > 10);
  }
});

test('describeTone covers every documented label', () => {
  for (const label of TONE_SIGNALS.map((s) => s.label).concat('neutral')) {
    assert.ok(describeTone(label).length > 10);
  }
});

test('buildAudienceToneForFiles aggregates and detects mixed batch', () => {
  const files = [
    { name: 'contract.pdf', extractedText: 'THIS AGREEMENT hereby entered whereas the parties shall indemnify under section 4.1 liability. Pursuant to clause 7.' },
    { name: 'launch.txt', extractedText: 'Unlock the power today! Join us now and transform your workflow with our breakthrough platform. Sign up now!' },
  ];
  const batch = buildAudienceToneForFiles(files);
  assert.equal(batch.perFile.length, 2);
  assert.ok(batch.aggregate.mixed, 'mixed-register batch should be detected');
});

test('renderAudienceToneBlock returns markdown with both axes', () => {
  const files = [{ name: 'sample.pdf', extractedText: 'THIS AGREEMENT hereby entered whereas the parties shall indemnify under section 4.1 liability.' }];
  const batch = buildAudienceToneForFiles(files);
  const md = renderAudienceToneBlock(batch);
  assert.match(md, /^## DOCUMENT AUDIENCE & TONE/);
  assert.match(md, /audience=/);
  assert.match(md, /tone=/);
});

test('renderAudienceToneBlock returns empty when no files', () => {
  assert.equal(renderAudienceToneBlock({ perFile: [] }), '');
  assert.equal(renderAudienceToneBlock(null), '');
});

test('scoreAxis: empty patterns / no hits → confidence 0', () => {
  const out = scoreAxis('hello world', [{ label: 'x', weight: 1, patterns: [/foo/] }]);
  assert.equal(out.confidence, 0);
});
