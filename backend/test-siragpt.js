require('dotenv').config({ path: '../.env.local' });
const aiService = require('./src/services/ai-service');

// Fake Express res that just captures stream chunks
const chunks = [];
const fakeRes = {
  write: (s) => { chunks.push(s); return true; },
  setHeader: () => {},
  flushHeaders: () => {},
  on: () => {},
  once: () => {},
  end: () => {},
  writableEnded: false,
};

(async () => {
  try {
    const result = await aiService.generateStream({
      provider: 'OpenRouter',
      model: 'siragpt-1.0',
      messages: [{ role: 'user', content: 'Di "hola desde siragpt 1.0" en una sola línea.' }],
      res: fakeRes,
      files: [],
      language: 'es',
      temperature: 0.3,
      skipDoneSentinel: true,
    });
    console.log('--- RESPONSE ---');
    console.log(result);
    console.log('--- END (length:', result.length, ') ---');
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
