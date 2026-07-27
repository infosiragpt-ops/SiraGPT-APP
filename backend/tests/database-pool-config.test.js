'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const database = require('../src/config/database');
const databaseUrls = require('../src/config/database-url');
const backendPackage = require('../package.json');

test.after(async () => {
  if (typeof database.$disconnect === 'function') await database.$disconnect();
});

test('pool config uses defaults and converts milliseconds to whole Prisma seconds', () => {
  const config = database.resolveDatabasePoolConfig({});

  assert.deepEqual(config, {
    poolMin: 2,
    poolMax: 10,
    poolTimeoutMs: 10_000,
    poolTimeoutSeconds: 10,
  });
});

test('pool config strictly validates values, clamps bounds, and rounds timeout up', () => {
  assert.deepEqual(
    database.resolveDatabasePoolConfig({
      DATABASE_POOL_MIN: '500',
      DATABASE_POOL_MAX: '999',
      DATABASE_POOL_TIMEOUT_MS: '999999',
    }),
    {
      poolMin: database.DATABASE_POOL_LIMIT_BOUNDS.max,
      poolMax: database.DATABASE_POOL_LIMIT_BOUNDS.max,
      poolTimeoutMs: database.DATABASE_POOL_TIMEOUT_MS_BOUNDS.max,
      poolTimeoutSeconds: database.DATABASE_POOL_TIMEOUT_MS_BOUNDS.max / 1000,
    },
  );

  assert.deepEqual(
    database.resolveDatabasePoolConfig({
      DATABASE_POOL_MIN: '0',
      DATABASE_POOL_MAX: '0',
      DATABASE_POOL_TIMEOUT_MS: '2501',
    }),
    {
      poolMin: database.DATABASE_POOL_LIMIT_BOUNDS.min,
      poolMax: database.DATABASE_POOL_LIMIT_BOUNDS.min,
      poolTimeoutMs: 2501,
      poolTimeoutSeconds: 3,
    },
  );

  assert.deepEqual(
    database.resolveDatabasePoolConfig({
      DATABASE_POOL_MIN: '2oops',
      DATABASE_POOL_MAX: '12oops',
      DATABASE_POOL_TIMEOUT_MS: 'none',
    }),
    {
      poolMin: 2,
      poolMax: 10,
      poolTimeoutMs: 10_000,
      poolTimeoutSeconds: 10,
    },
  );
});

test('datasource builder preserves unrelated parameters and replaces pool controls', () => {
  const source =
    'postgresql://db-user:p%40ssword@db.internal:5432/sira'
    + '?schema=tenant_a&sslmode=require&pgbouncer=true'
    + '&connection_limit=77&pool_timeout=91';
  const result = database.buildPrismaDatasourceUrl(source, {
    poolMax: 12,
    poolTimeoutSeconds: 3,
  });
  const parsed = new URL(result);

  assert.equal(parsed.username, 'db-user');
  assert.equal(parsed.password, 'p%40ssword');
  assert.equal(parsed.hostname, 'db.internal');
  assert.equal(parsed.searchParams.get('schema'), 'tenant_a');
  assert.equal(parsed.searchParams.get('sslmode'), 'require');
  assert.equal(parsed.searchParams.get('pgbouncer'), 'true');
  assert.equal(parsed.searchParams.get('connection_limit'), '12');
  assert.equal(parsed.searchParams.get('pool_timeout'), '3');
  assert.equal(parsed.searchParams.getAll('connection_limit').length, 1);
  assert.equal(parsed.searchParams.getAll('pool_timeout').length, 1);
});

test('client options use canonical PRISMA_DATABASE_URL, fall back to DATABASE_URL, and pass datasources', () => {
  const canonical = database.buildPrismaClientOptions({
    NODE_ENV: 'production',
    PRISMA_DATABASE_URL: '  postgres://canonical:secret@primary.internal/app?schema=main  ',
    DATABASE_POOL_MAX: '9',
    DATABASE_POOL_TIMEOUT_MS: '1500',
  });

  assert.deepEqual(canonical.log, ['error']);
  assert.equal(new URL(canonical.datasources.db.url).hostname, 'primary.internal');
  assert.equal(new URL(canonical.datasources.db.url).searchParams.get('connection_limit'), '9');
  assert.equal(new URL(canonical.datasources.db.url).searchParams.get('pool_timeout'), '2');

  const fallback = database.buildPrismaClientOptions({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://fallback:secret@legacy.internal/app?sslmode=require',
  });
  assert.deepEqual(fallback.log, ['warn', 'error']);
  assert.equal(new URL(fallback.datasources.db.url).hostname, 'legacy.internal');
  assert.equal(new URL(fallback.datasources.db.url).searchParams.get('sslmode'), 'require');

  assert.equal(
    Object.hasOwn(database.buildPrismaClientOptions({}), 'datasources'),
    false,
    'an unconfigured test process must retain Prisma schema fallback behavior',
  );
});

test('canonical database URL resolver accepts equal aliases and fails closed on conflicts', () => {
  assert.equal(typeof database.resolveCanonicalDatabaseUrl, 'function');
  assert.equal(
    database.resolveCanonicalDatabaseUrl({
      PRISMA_DATABASE_URL: '  postgres://canonical.internal/app  ',
      DATABASE_URL: 'postgres://canonical.internal/app',
    }),
    'postgres://canonical.internal/app',
  );
  assert.equal(
    database.resolveCanonicalDatabaseUrl({
      DATABASE_URL: '  postgres://fallback.internal/app  ',
    }),
    'postgres://fallback.internal/app',
  );

  assert.throws(
    () => database.resolveCanonicalDatabaseUrl({
      PRISMA_DATABASE_URL: 'postgres://canonical-user:canonical-secret@canonical.internal/app',
      DATABASE_URL: 'postgres://legacy-user:legacy-secret@legacy.internal/app',
    }),
    (error) => {
      assert.equal(error.code, 'DATABASE_RUNTIME_URL_CONFLICT');
      assert.match(error.message, /conflicting runtime database URL aliases/i);
      assert.doesNotMatch(
        `${error.message}\n${error.stack}`,
        /canonical-user|canonical-secret|canonical\.internal|legacy-user|legacy-secret|legacy\.internal/,
      );
      return true;
    },
  );
});

test('database URL roles allow an Accelerate runtime with a separate direct migration URL', () => {
  const env = {
    PRISMA_DATABASE_URL: '  prisma+postgres://accelerate.prisma-data.net/?api_key=runtime-secret  ',
    DIRECT_DATABASE_URL: '  postgresql://migration-user:migration-secret@db.internal/sira  ',
  };

  assert.deepEqual(databaseUrls.resolveDatabaseUrls(env), {
    runtimeUrl: 'prisma+postgres://accelerate.prisma-data.net/?api_key=runtime-secret',
    directMigrationUrl: 'postgresql://migration-user:migration-secret@db.internal/sira',
  });
  assert.equal(
    databaseUrls.resolveRuntimeDatabaseUrl(env),
    'prisma+postgres://accelerate.prisma-data.net/?api_key=runtime-secret',
  );
  assert.equal(
    databaseUrls.resolveDirectMigrationDatabaseUrl(env),
    'postgresql://migration-user:migration-secret@db.internal/sira',
  );

  const options = database.buildPrismaClientOptions(env);
  assert.equal(options.datasources.db.url, env.PRISMA_DATABASE_URL.trim());
});

test('database URL roles allow DATABASE_URL to supply direct migrations beside Accelerate', () => {
  const env = {
    PRISMA_DATABASE_URL: 'prisma+postgres://accelerate.prisma-data.net/?api_key=runtime-secret',
    DATABASE_URL: 'postgres://migration-user:migration-secret@db.internal/sira',
  };

  assert.deepEqual(databaseUrls.resolveDatabaseUrls(env), {
    runtimeUrl: env.PRISMA_DATABASE_URL,
    directMigrationUrl: env.DATABASE_URL,
  });
});

test('POSTGRES-only environments synthesize matching runtime and direct URLs', () => {
  const env = {
    POSTGRES_HOST: 'postgres.internal',
    POSTGRES_PORT: '5544',
    POSTGRES_USER: 'compose-user',
    POSTGRES_PASSWORD: 'p@ss:word',
    POSTGRES_DB: 'sira gpt',
  };
  const expected = 'postgresql://compose-user:p%40ss%3Aword@postgres.internal:5544/sira%20gpt';

  assert.deepEqual(databaseUrls.resolveDatabaseUrls(env), {
    runtimeUrl: expected,
    directMigrationUrl: expected,
  });
});

test('an explicit direct PRISMA runtime suppresses POSTGRES synthesis and remains the migration fallback', () => {
  const explicit = 'postgres://explicit-user:explicit-secret@external.invalid/app';
  const env = {
    PRISMA_DATABASE_URL: explicit,
    POSTGRES_HOST: 'db',
    POSTGRES_PORT: '5432',
    POSTGRES_USER: 'local-user',
    POSTGRES_PASSWORD: 'local-secret',
    POSTGRES_DB: 'local-db',
  };

  assert.deepEqual(databaseUrls.resolveDatabaseUrls(env), {
    runtimeUrl: explicit,
    directMigrationUrl: explicit,
  });
});

test('a remote PRISMA runtime suppresses POSTGRES synthesis and still requires an explicit direct URL', () => {
  const remote = 'prisma+postgres://accelerate.invalid/?api_key=remote-secret';
  const env = {
    PRISMA_DATABASE_URL: remote,
    POSTGRES_HOST: 'db',
    POSTGRES_PORT: '5432',
    POSTGRES_USER: 'local-user',
    POSTGRES_PASSWORD: 'local-secret',
    POSTGRES_DB: 'local-db',
  };

  assert.deepEqual(databaseUrls.resolveDatabaseUrls(env), {
    runtimeUrl: remote,
    directMigrationUrl: null,
  });
  assert.throws(
    () => databaseUrls.requireDirectMigrationDatabaseUrl(env),
    (error) => error.code === 'DIRECT_DATABASE_URL_REQUIRED',
  );
});

test('database URL roles reject opaque protocol strings that are not connection URLs', () => {
  assert.equal(databaseUrls.isDirectPostgresUrl('postgres:opaque-secret'), false);
  assert.equal(databaseUrls.isRemotePrismaUrl('prisma+postgres:opaque-secret'), false);
  assert.throws(
    () => databaseUrls.resolveDirectMigrationDatabaseUrl({
      DIRECT_DATABASE_URL: 'postgres:opaque-secret',
    }),
    (error) => error.code === 'DIRECT_DATABASE_URL_INVALID',
  );
});

test('database URL role conflicts fail closed with role-specific value-free errors', () => {
  assert.equal(
    databaseUrls.DATABASE_URL_CONFLICT_CODE,
    'DATABASE_URL_CONFLICT',
    'the original exported conflict code must remain byte-compatible',
  );
  assert.equal(
    databaseUrls.LEGACY_DATABASE_URL_CONFLICT_CODE,
    databaseUrls.DATABASE_URL_CONFLICT_CODE,
    'the pre-role conflict code remains available as an explicit compatibility alias',
  );

  assert.throws(
    () => databaseUrls.resolveRuntimeDatabaseUrl({
      PRISMA_DATABASE_URL: 'prisma+postgres://runtime-a.invalid/?api_key=secret-a',
      DATABASE_URL: 'prisma+postgres://runtime-b.invalid/?api_key=secret-b',
    }),
    (error) => {
      assert.equal(error.code, 'DATABASE_RUNTIME_URL_CONFLICT');
      assert.equal(error.legacyCode, 'DATABASE_URL_CONFLICT');
      assert.equal(error.role, 'runtime');
      assert.doesNotMatch(
        `${error.message}\n${error.stack}`,
        /runtime-a|runtime-b|secret-a|secret-b/,
      );
      return true;
    },
  );

  assert.throws(
    () => databaseUrls.resolveDirectMigrationDatabaseUrl({
      PRISMA_DATABASE_URL: 'postgres://direct-a:secret-a@db-a.invalid/app',
      DATABASE_URL: 'postgres://direct-b:secret-b@db-b.invalid/app',
    }),
    (error) => {
      assert.equal(error.code, 'DATABASE_DIRECT_URL_CONFLICT');
      assert.equal(error.role, 'direct_migration');
      assert.doesNotMatch(
        `${error.message}\n${error.stack}`,
        /direct-a|direct-b|secret-a|secret-b|db-a|db-b/,
      );
      return true;
    },
  );
});

test('database URL redaction removes direct and remote values without logging aliases', () => {
  const text = [
    'runtime prisma+postgres://accelerate.invalid/?api_key=runtime-secret',
    'migration postgresql://migration-user:migration-secret@db.internal/sira?sslmode=require',
  ].join(' ');
  const redacted = databaseUrls.redactDatabaseUrls(text);

  assert.match(redacted, /\[REDACTED_DATABASE_URL\]/);
  assert.doesNotMatch(
    redacted,
    /accelerate\.invalid|runtime-secret|migration-user|migration-secret|db\.internal/,
  );
});

test('runtime and health callers share the central database error sanitizer', () => {
  assert.equal(typeof databaseUrls.sanitizeDatabaseErrorMessage, 'function');
  assert.equal(
    database.sanitizeDatabaseErrorMessage,
    databaseUrls.sanitizeDatabaseErrorMessage,
  );
  assert.equal(
    databaseUrls.sanitizeDatabaseErrorMessage(
      'connect postgresql://db-user:db-pass@db.private/sira',
    ),
    'connect [REDACTED_DATABASE_URL]',
  );
});

test('client options fail closed without disclosing divergent database URLs', () => {
  assert.throws(
    () => database.buildPrismaClientOptions({
      PRISMA_DATABASE_URL: 'postgres://canonical:top-secret@primary.internal/app',
      DATABASE_URL: 'postgres://legacy:other-secret@legacy.internal/app',
    }),
    (error) => {
      assert.equal(error.code, 'DATABASE_RUNTIME_URL_CONFLICT');
      assert.doesNotMatch(
        error.message,
        /canonical|top-secret|primary\.internal|legacy|other-secret|legacy\.internal/,
      );
      return true;
    },
  );
});

test('remote Prisma datasource URLs are never rewritten with local pool controls', () => {
  const source = 'prisma+postgres://accelerate.prisma-data.net/?api_key=secret&region=us-east-1';
  const result = database.buildPrismaDatasourceUrl(source, {
    poolMax: 99,
    poolTimeoutSeconds: 42,
  });
  const options = database.buildPrismaClientOptions({
    PRISMA_DATABASE_URL: source,
    DATABASE_POOL_MAX: '99',
    DATABASE_POOL_TIMEOUT_MS: '42000',
  });

  assert.equal(result, source);
  assert.equal(options.datasources.db.url, source);
  assert.equal(new URL(result).searchParams.has('connection_limit'), false);
  assert.equal(new URL(result).searchParams.has('pool_timeout'), false);
  assert.deepEqual(database.classifyDatabasePoolCapacity(source), {
    observable: false,
    reason: 'remote_prisma_datasource',
    protocol: 'prisma+postgres:',
  });
});

test('invalid datasource errors and startup logs never disclose database credentials', () => {
  assert.throws(
    () => database.buildPrismaDatasourceUrl(
      'not a URL containing db-user:ultra-secret',
      { poolMax: 10, poolTimeoutSeconds: 10 },
    ),
    (error) => {
      assert.equal(error instanceof TypeError, true);
      assert.doesNotMatch(error.message, /db-user|ultra-secret/);
      return true;
    },
  );

  const sanitized = database.sanitizeDatabaseErrorMessage(
    "connect failed for postgresql://db-user:ultra'secret@db.internal/sira?token=sensitive",
  );
  assert.match(sanitized, /\[REDACTED_DATABASE_URL\]/);
  assert.doesNotMatch(sanitized, /db-user|ultra|secret|db\.internal|sensitive/);

  const child = spawnSync(
    process.execPath,
    ['-e', "require('./src/config/database')"],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://db-user:ultra-secret@db.internal/sira?schema=main',
        PRISMA_DATABASE_URL: '',
      },
      timeout: 10_000,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(`${child.stdout}\n${child.stderr}`, /db-user|ultra-secret/);
});

test('shared Prisma exports the attached pool instrumentation handle', () => {
  assert.ok(database.poolMetrics);
  assert.equal(typeof database.poolMetrics.snapshot, 'function');
  assert.equal(database.poolMetrics.client, database);
  const snapshot = database.poolMetrics.snapshot();
  assert.equal(snapshot.installed, true);
  assert.equal(snapshot.instrumentation, 'query_extension');
});

test('shared extended Prisma client preserves the supported operational surface', () => {
  for (const method of [
    '$connect',
    '$disconnect',
    '$extends',
    '$on',
    '$queryRawUnsafe',
    '$executeRawUnsafe',
    '$transaction',
  ]) {
    assert.equal(typeof database[method], 'function', `${method} must be available`);
  }
  assert.equal(typeof database.user, 'object');
});

test('runtime source permits PrismaClient construction only in the shared factory and generated templates', () => {
  const srcRoot = path.resolve(__dirname, '../src');
  const allowed = new Set([
    'config/database.js',
    'services/builder/codegen.js',
  ]);
  const violations = [];

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile() || !/\.(?:js|ts)$/.test(entry.name)) continue;
      const relative = path.relative(srcRoot, absolute).replaceAll(path.sep, '/');
      if (allowed.has(relative)) continue;
      const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (/^\s*\/\//.test(line)) return;
        if (/\bnew\s+PrismaClient\s*\(/.test(line)) {
          violations.push(`${relative}:${index + 1}`);
        }
      });
    }
  }

  visit(srcRoot);
  assert.deepEqual(violations, []);
});

test('TypeScript memory services keep database injection and delegate fallback lifecycle to the shared client', () => {
  const userMemoryVector = fs.readFileSync(
    path.resolve(__dirname, '../src/services/user-memory-vector.ts'),
    'utf8',
  );
  const consolidationJob = fs.readFileSync(
    path.resolve(__dirname, '../src/services/memory-consolidation-job.ts'),
    'utf8',
  );

  for (const source of [userMemoryVector, consolidationJob]) {
    assert.match(source, /require\(["']\.\.\/config\/database["']\)/);
    assert.doesNotMatch(source, /require\(["']@prisma\/client["']\)/);
  }
  assert.match(userMemoryVector, /\bdb\?:/);
  assert.match(consolidationJob, /\bdb\?:/);
  assert.doesNotMatch(consolidationJob, /\.\$disconnect\s*\(/);
});

test('runtime validators and migration startup import the canonical resolver module', () => {
  for (const file of [
    path.resolve(__dirname, '../src/config/database.js'),
    path.resolve(__dirname, '../src/utils/config-validator.js'),
    path.resolve(__dirname, '../src/utils/startup-validator.js'),
    path.resolve(__dirname, '../scripts/start-with-migrations.js'),
    path.resolve(__dirname, '../../scripts/start-all.cjs'),
    path.resolve(__dirname, '../../scripts/start-all.js'),
  ]) {
    assert.match(
      fs.readFileSync(file, 'utf8'),
      /(?:config\/)?database-url/,
      `${path.relative(path.resolve(__dirname, '../..'), file)} bypasses the canonical resolver`,
    );
  }
});

test('single-container start wrappers preserve runtime and direct migration roles', () => {
  for (const file of [
    path.resolve(__dirname, '../../scripts/start-all.cjs'),
    path.resolve(__dirname, '../../scripts/start-all.js'),
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /resolveDatabaseUrls|resolveRuntimeDatabaseUrl/);
    assert.match(source, /DIRECT_DATABASE_URL/);
    assert.doesNotMatch(
      source,
      /PRISMA_DATABASE_URL:\s*([A-Za-z_$][\w$]*),\s*DATABASE_URL:\s*\1/,
      `${path.basename(file)} collapses distinct database roles`,
    );
  }
});

test('both Compose backends pass through database roles and boot timeout controls', () => {
  for (const file of [
    path.resolve(__dirname, '../../docker-compose.yml'),
    path.resolve(__dirname, '../../docker-compose.prod.yml'),
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    for (const variable of [
      'PRISMA_DATABASE_URL',
      'DIRECT_DATABASE_URL',
      'DATABASE_URL',
      'DATABASE_SSL_REJECT_UNAUTHORIZED',
      'DATABASE_SSL_CA',
      'DATABASE_SSL_CERT',
      'DATABASE_SSL_KEY',
      'MIGRATION_COMMAND_TIMEOUT_MS',
      'BOOT_COMMAND_TIMEOUT_MS',
      'MIGRATION_DB_CONNECT_TIMEOUT_MS',
      'MIGRATION_DB_QUERY_TIMEOUT_MS',
      'MIGRATION_DB_STATEMENT_TIMEOUT_MS',
      'MIGRATION_LOCK_TIMEOUT_MS',
      'MIGRATION_NONFATAL',
    ]) {
      assert.match(
        source,
        new RegExp(`\\b${variable}:\\s*["']?\\$\\{${variable}(?::-|\\})`),
        `${path.basename(file)} does not pass through ${variable}`,
      );
    }
  }
});

test('standard and production Compose defer POSTGRES-only URL synthesis to the pure resolver', () => {
  for (const file of [
    path.resolve(__dirname, '../../docker-compose.yml'),
    path.resolve(__dirname, '../../docker-compose.prod.yml'),
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    for (const role of ['PRISMA_DATABASE_URL', 'DIRECT_DATABASE_URL']) {
      const assignment = source.match(new RegExp(`\\b${role}:\\s*["']([^"'\\n]+)["']`));
      assert.ok(assignment, `${path.basename(file)} is missing ${role}`);
      assert.equal(assignment[1], `\${${role}:-}`);
      assert.doesNotMatch(
        assignment[1],
        /POSTGRES_/,
        `${path.basename(file)} must not turn an explicit remote runtime into a local direct URL`,
      );
    }
    for (const variable of [
      'POSTGRES_HOST',
      'POSTGRES_PORT',
      'POSTGRES_USER',
      'POSTGRES_PASSWORD',
      'POSTGRES_DB',
    ]) {
      assert.match(
        source,
        new RegExp(`\\b${variable}:\\s*["']?\\$\\{${variable}(?::-|:\\?)`),
        `${path.basename(file)} does not pass ${variable} to the resolver`,
      );
    }
    assert.match(source, /\bPOSTGRES_HOST:\s*["']?\$\{POSTGRES_HOST:-db\}/);
    assert.match(source, /\bPOSTGRES_PORT:\s*["']?\$\{POSTGRES_PORT:-5432\}/);
  }
});

test('development Compose override keeps direct migrations distinct and bounded', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../docker-compose.override.yml'),
    'utf8',
  );

  assert.match(source, /\bDIRECT_DATABASE_URL:/);
  assert.match(source, /\bMIGRATION_COMMAND_TIMEOUT_MS:/);
  assert.match(source, /\brunPrisma\b[\s\S]*?\bmigrate deploy\b/);
  assert.match(source, /\brunPrisma\b[\s\S]*?\bgenerate\b/);
});

test('canonical backend suite registers every focused database pool test', () => {
  for (const file of [
    'tests/database-pool-config.test.js',
    'tests/db-pool-instrumentation.test.js',
    'tests/db-pool-autoscaler.test.js',
    'tests/config-validator.test.js',
    'tests/startup-validator.test.js',
    'tests/migration-process-tree.test.js',
  ]) {
    assert.match(
      backendPackage.scripts.test,
      new RegExp(`(?:^|\\s)${file.replaceAll('.', '\\.')}(?:\\s|$)`),
    );
  }
});

test('database pool controls are documented in both environment examples and ops docs', () => {
  const files = [
    path.resolve(__dirname, '../../.env.example'),
    path.resolve(__dirname, '../.env.example'),
    path.resolve(__dirname, '../../docs/operations/ENVIRONMENT.md'),
  ].map((file) => fs.readFileSync(file, 'utf8'));
  const variables = [
    'DATABASE_POOL_MIN',
    'DATABASE_POOL_MAX',
    'DATABASE_POOL_TIMEOUT_MS',
    'DATABASE_POOL_AUTOSCALE_ENABLED',
    'DATABASE_POOL_AUTOSCALE_INTERVAL_MS',
    'DATABASE_POOL_AUTOSCALE_MIN',
    'DATABASE_POOL_AUTOSCALE_MAX',
    'DATABASE_POOL_AUTOSCALE_COLD_SAMPLES',
  ];

  for (const contents of files) {
    for (const variable of variables) assert.match(contents, new RegExp(`\\b${variable}\\b`));
  }
});

test('database role and boot timeout variables are documented in examples and env references', () => {
  const files = [
    path.resolve(__dirname, '../../.env.example'),
    path.resolve(__dirname, '../.env.example'),
    path.resolve(__dirname, '../../docs/operations/ENVIRONMENT.md'),
    path.resolve(__dirname, '../../docs/ENV_VARIABLES.md'),
  ].map((file) => fs.readFileSync(file, 'utf8'));
  const variables = [
    'PRISMA_DATABASE_URL',
    'DIRECT_DATABASE_URL',
    'DATABASE_URL',
    'DATABASE_SSL_REJECT_UNAUTHORIZED',
    'DATABASE_SSL_CA',
    'DATABASE_SSL_CERT',
    'DATABASE_SSL_KEY',
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'MIGRATION_COMMAND_TIMEOUT_MS',
    'BOOT_COMMAND_TIMEOUT_MS',
    'MIGRATION_DB_CONNECT_TIMEOUT_MS',
    'MIGRATION_DB_QUERY_TIMEOUT_MS',
    'MIGRATION_DB_STATEMENT_TIMEOUT_MS',
    'MIGRATION_LOCK_TIMEOUT_MS',
    'SKIP_MIGRATIONS',
    'MIGRATION_NONFATAL',
  ];

  for (const contents of files) {
    for (const variable of variables) assert.match(contents, new RegExp(`\\b${variable}\\b`));
    assert.doesNotMatch(contents, /PRISMA_BASELINE_(?:ON_P3005|MIGRATION)/);
    assert.doesNotMatch(contents, /MIGRATION_ALLOW_EQUIVALENT_UNBASELINED/);
  }
  assert.match(files[2], /baseline-migration-history\.js/);
  assert.match(files[2], /I_REVIEWED_PRODUCTION_SCHEMA/);
  assert.match(files[3], /baseline-migration-history\.js/);
});
