'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.resolve(__dirname, '..');
const SECURITY_SOURCES = [
  'src/services/LoginService.js',
  'src/middleware/require-permission.js',
];

test('authentication and authorization sources contain no development-admin bypass', () => {
  const forbidden = [
    /DEV_ADMIN_(?:EMAIL|PASSWORD)/,
    /\bisDevAdmin\b/,
    /_isDevAdminLogin/,
    /_ensureDevAdminUser/,
    /dev_admin_bypass/,
  ];

  for (const relativePath of SECURITY_SOURCES) {
    const source = fs.readFileSync(path.join(BACKEND, relativePath), 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${relativePath} still contains ${pattern}`);
    }
  }
});

test('LoginService always sends development credentials through normal password verification', async () => {
  const { LoginService } = require('../src/services/LoginService');
  const calls = { lookup: 0, compare: 0, create: 0 };
  const service = new LoginService({
    users: {
      async findByEmail() {
        calls.lookup += 1;
        return {
          id: 'legacy-dev-user',
          email: 'legacy-dev@example.test',
          password: 'stored-hash',
          isAdmin: true,
          isSuperAdmin: true,
          twoFactorEnabled: false,
          totpEnabled: false,
        };
      },
    },
    sessions: {
      async create() {
        calls.create += 1;
      },
    },
    audit: () => {},
    prisma: {
      user: {
        async create() {
          throw new Error('login must never provision a privileged user');
        },
        async update() {
          throw new Error('login must never elevate a privileged user');
        },
      },
    },
    lockout: {
      isLocked: () => ({ locked: false, attempts: 0 }),
      recordFailure: () => ({ locked: false, attempts: 1 }),
      recordSuccess: () => {},
    },
    resolveOrgBySsoDomain: async () => null,
    signSessionToken: () => 'must-not-mint',
    comparePassword: async () => {
      calls.compare += 1;
      return false;
    },
    userHasTwoFactor: () => false,
    orgRequiresTwoFactor: () => false,
  });

  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    const result = await service.login({
      email: 'legacy-dev@example.test',
      password: 'known-development-password',
      req: {},
    });
    assert.deepEqual(result, { ok: false, kind: 'invalid_credentials' });
    assert.deepEqual(calls, { lookup: 1, compare: 1, create: 0 });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
