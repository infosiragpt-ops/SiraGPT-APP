'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-twilio');
const { extractTwilio, buildTwilioForFiles, renderTwilioBlock, _internal } = engine;
const { maskSid, isTwilioLike } = _internal;

const TWILIO_FIXTURE = `import twilio from 'twilio';

const client = twilio(
  'ACabcdef0123456789abcdef0123456789ab',  // Account SID
  process.env.AUTH_TOKEN
);

async function sendSms(to, body) {
  const message = await client.messages.create({
    from: 'PN1234567890abcdef1234567890abcdef12',
    to,
    body,
    messagingServiceSid: 'MGdeadbeefcafebabe0123456789abcdef01',
  });
  return message.sid; // e.g. SMabcdef0123456789abcdef0123456789ab
}

async function makeCall(to) {
  const call = await client.calls.create({
    url: 'https://example.com/voice.xml',
    to,
    from: 'PN1234567890abcdef1234567890abcdef12',
  });
  return call.sid; // e.g. CAabcdef0123456789abcdef0123456789ab
}

async function verifyCode(serviceSid, phone) {
  const v = await client.verify.services(serviceSid).verifications.create({
    to: phone,
    channel: 'sms',
  });
  return v.sid; // e.g. VEabcdef0123456789abcdef0123456789ab
}

// Webhook signature validation
function verifyWebhook(req, res, next) {
  const sig = req.headers['x-twilio-signature'] || req.headers['X-Twilio-Signature'];
  if (!twilio.validateRequest(authToken, sig, url, req.body)) {
    return res.status(403).end();
  }
  next();
}

// TwiML response
const twiml = \`<Response>
  <Say voice="alice">Hello!</Say>
  <Pause length="1"/>
  <Gather input="dtmf speech" timeout="5" numDigits="1">
    <Say>Press 1 for sales.</Say>
  </Gather>
  <Dial>
    <Number>+1234567890</Number>
  </Dial>
  <Record action="/recorded" maxLength="30"/>
  <Hangup/>
</Response>\`;

const webhookUrl = 'https://my-app.com/twilio/webhook';
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractTwilio('').total, 0);
  assert.equal(extractTwilio(null).total, 0);
});

test('non-Twilio text returns empty', () => {
  const r = extractTwilio('Just regular code without Twilio');
  assert.equal(r.total, 0);
});

test('maskSid truncates SID', () => {
  assert.equal(maskSid('AC', 'abcdefg'), 'ACabcdefg');
  const masked = maskSid('CA', 'abcdef0123456789abcdef0123456789ab');
  assert.match(masked, /^CA…/);
  assert.ok(masked.length < 15);
});

test('isTwilioLike heuristic', () => {
  assert.ok(isTwilioLike('twilio.messages.create({})'));
  assert.ok(isTwilioLike('<Response><Say>Hi</Say></Response>'));
  assert.ok(!isTwilioLike('plain text'));
});

test('detects Account SID (AC prefix)', () => {
  const r = extractTwilio(TWILIO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'sid' && e.detail === 'account'));
});

test('detects Phone Number SID (PN)', () => {
  const r = extractTwilio(TWILIO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'sid' && e.detail === 'phoneNumber'));
});

test('detects Messaging Service SID (MG)', () => {
  const r = extractTwilio(TWILIO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'sid' && e.detail === 'message'));
});

test('SIDs are masked, not raw', () => {
  const r = extractTwilio(TWILIO_FIXTURE);
  const allText = JSON.stringify(r.entries);
  // Full 34-char SID should not be in output
  assert.ok(!/AC[a-z]{32}/.test(allText));
  assert.ok(/AC…/.test(allText));
});

test('detects twilio.messages resource', () => {
  const r = extractTwilio(TWILIO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'resource' && e.name === 'twilio.messages'));
});

test('detects twilio.calls resource', () => {
  const r = extractTwilio(TWILIO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'resource' && e.name === 'twilio.calls'));
});

test('detects twilio.verify resource', () => {
  const r = extractTwilio(TWILIO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'resource' && e.name === 'twilio.verify'));
});

test('detects .create method', () => {
  const r = extractTwilio(TWILIO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'method' && e.name === '.create'));
});

test('detects TwiML verbs (Response, Say, Dial, Gather, Hangup)', () => {
  const r = extractTwilio(TWILIO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'twimlVerb' && e.name === '<Response>'));
  assert.ok(r.entries.some((e) => e.kind === 'twimlVerb' && e.name === '<Say>'));
  assert.ok(r.entries.some((e) => e.kind === 'twimlVerb' && e.name === '<Dial>'));
  assert.ok(r.entries.some((e) => e.kind === 'twimlVerb' && e.name === '<Gather>'));
});

test('detects X-Twilio-Signature usage', () => {
  const r = extractTwilio(TWILIO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'signature'));
});

test('dedupes identical SIDs', () => {
  const sid = 'ACabcdef0123456789abcdef0123456789ab';
  const r = extractTwilio(`const a = "${sid}"; const b = "${sid}";`);
  assert.equal(r.entries.filter((e) => e.kind === 'sid').length, 1);
});

test('caps entries per file', () => {
  let text = 'twilio.messages.create({});\n';
  for (let i = 0; i < 30; i++) text += `<Say>msg${i}</Say> `;
  const r = extractTwilio(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractTwilio(TWILIO_FIXTURE);
  assert.ok(r.totals.sid >= 3);
  assert.ok(r.totals.resource >= 2);
  assert.ok(r.totals.twimlVerb >= 4);
});

test('buildTwilioForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.ts', extractedText: 'twilio.messages.create({})' },
    { name: 'b.ts', extractedText: '<Response><Say>Hi</Say></Response>' },
  ];
  const r = buildTwilioForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTwilioBlock returns markdown when entries exist', () => {
  const files = [{ name: 'sms.ts', extractedText: TWILIO_FIXTURE }];
  const r = buildTwilioForFiles(files);
  const md = renderTwilioBlock(r);
  assert.match(md, /^## TWILIO/);
});

test('renderTwilioBlock empty when nothing surfaces', () => {
  assert.equal(renderTwilioBlock({ perFile: [] }), '');
  assert.equal(renderTwilioBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTwilioForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: TWILIO_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
