'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAutopilot } = require('../src/services/social-company/autopilot');

test('CEO autopilot creates at most one approved daily post for connected enabled channels', async () => {
  const creates = [];
  const prisma = {
    systemSettings: {
      findMany: async () => [{
        key: 'social_company_policy:u1',
        value: JSON.stringify({
          enabled: true,
          mode: 'auto',
          autopilot: true,
          objective: 'Enseñar a equipos a usar IA responsablemente',
          platforms: { facebook: true, linkedin: true, x: true },
        }),
      }],
    },
    scheduledPost: {
      findFirst: async () => null,
      create: async ({ data }) => {
        creates.push(data);
        return { id: 'post-auto-1', ...data };
      },
    },
    socialConnection: {
      findMany: async () => [{ platform: 'linkedin' }, { platform: 'x' }],
    },
  };
  const result = await runAutopilot({
    prisma,
    now: () => new Date('2026-07-23T18:00:00.000Z'),
    chatComplete: async () => ({
      content: JSON.stringify({
        caption: 'Tres prácticas concretas para introducir IA con control humano.',
        mediaBrief: 'Equipo revisando un tablero de riesgos y resultados.',
      }),
    }),
  });
  assert.equal(result[0].action, 'generated');
  assert.deepEqual(creates[0].platforms, ['linkedin', 'x']);
  assert.equal(creates[0].config.approved, true);
  assert.equal(creates[0].config.source, 'ceo_autopilot');
  assert.match(creates[0].batchId, /^ceo-autopilot:2026-07-23:u1$/);
});
