'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const { publicProject } = require('../src/services/codex/project-service');
const {
  PUBLIC_DATABASE_FIELDS,
  publicProjectDatabase,
} = require('../src/services/codex/project-database-serializer');
const {
  DATABASE_URL_KEYS,
  redactString,
} = require('../src/utils/secret-redactor');
const {
  isSensitiveKey,
  redactPayloadDeep,
} = require('../src/utils/log-redaction');

const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'prisma/migrations/20260722190000_add_codex_project_database_foundation/migration.sql'),
  'utf8',
);

describe('Codex project database additive migration', () => {
  test('schema has 1:1 metadata, authenticated secret and secret-free lease models', () => {
    assert.match(schema, /model CodexProjectDatabase \{/);
    assert.match(schema, /projectId\s+String\?\s+@unique/);
    assert.match(
      schema,
      /project\s+CodexProject\?\s+@relation\(fields: \[projectId\], references: \[id\], onDelete: SetNull\)/,
    );
    assert.match(schema, /model CodexProjectDatabaseSecret \{/);
    assert.match(schema, /envelope\s+String\s+@db\.Text/);
    assert.match(schema, /model CodexDatabaseLease \{/);

    const leaseModel = schema.match(/model CodexDatabaseLease \{([\s\S]*?)\n\}/)?.[1] || '';
    assert.doesNotMatch(leaseModel, /password|databaseUrl|directDatabaseUrl|ciphertext/i);
  });

  test('migration is additive and preserves a tombstone with ON DELETE SET NULL', () => {
    assert.match(migration, /CREATE TABLE "codex_project_databases"/);
    assert.match(migration, /CREATE TABLE "codex_project_database_secrets"/);
    assert.match(migration, /CREATE TABLE "codex_database_leases"/);
    assert.match(migration, /ON DELETE SET NULL ON UPDATE CASCADE/);
    assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN|INDEX|CONSTRAINT|TYPE|DATABASE)\b/i);
    assert.doesNotMatch(migration, /\bTRUNCATE\b|\bDELETE\s+FROM\b|\bCREATE\s+(?:DATABASE|ROLE|USER)\b|\bGRANT\b/i);
  });

  test('migration stores only envelope metadata, never a plaintext DSN/password', () => {
    const secretTable = migration.match(
      /CREATE TABLE "codex_project_database_secrets" \(([\s\S]*?)\n\);/,
    )?.[1] || '';
    assert.match(secretTable, /"keyId" TEXT NOT NULL/);
    assert.match(secretTable, /"envelope" TEXT NOT NULL/);
    assert.doesNotMatch(secretTable, /databaseUrl|directDatabaseUrl|password|plaintext/i);
  });
});

describe('Codex project database public serializers', () => {
  const sensitiveRow = {
    id: 'db-1',
    projectId: 'project-1',
    provider: 'sira_postgres',
    clusterRef: 'cluster-secret-ref',
    resourceRef: 'provider-secret-ref',
    databaseName: 'private_database_name',
    ownerRole: 'private_owner_role',
    migratorRole: 'private_migrator_role',
    runtimeRole: 'private_runtime_role',
    status: 'pending',
    desiredState: 'ready',
    operationId: 'private-operation',
    operationLeaseUntil: new Date('2026-07-22T00:00:00Z'),
    credentialGeneration: 4,
    quotaMb: 512,
    maxConnections: 10,
    backupPolicy: { bucket: 'private-bucket' },
    lastError: 'postgres://user:plaintext-password@private-host/db',
    secret: { keyId: 'key-1', envelope: 'ciphertext-envelope' },
    leases: [{ roleName: 'ephemeral-private-role', sandboxRef: 'private-sandbox' }],
    createdAt: new Date('2026-07-22T00:00:00Z'),
    updatedAt: new Date('2026-07-22T00:00:01Z'),
  };

  test('database metadata is an allowlist with no infrastructure or secret fields', () => {
    const serialized = publicProjectDatabase(sensitiveRow);
    assert.deepEqual(Object.keys(serialized).sort(), [
      'createdAt',
      'desiredState',
      'id',
      'maxConnections',
      'provider',
      'quotaMb',
      'status',
      'updatedAt',
    ]);
    const json = JSON.stringify(serialized);
    for (const leaked of [
      'cluster-secret-ref',
      'provider-secret-ref',
      'private_database_name',
      'private_owner_role',
      'private-operation',
      'plaintext-password',
      'ciphertext-envelope',
      'private-sandbox',
      'private-bucket',
    ]) {
      assert.doesNotMatch(json, new RegExp(leaked));
    }
    assert.equal(Object.isFrozen(PUBLIC_DATABASE_FIELDS), true);
  });

  test('project projection sanitizes an accidentally included database relation', () => {
    const project = publicProject({
      id: 'project-1',
      name: 'Real app',
      status: 'ready',
      workspacePath: 'projects/project-1',
      previewUrl: null,
      error: null,
      createdAt: new Date('2026-07-22T00:00:00Z'),
      updatedAt: new Date('2026-07-22T00:00:01Z'),
      database: sensitiveRow,
    });
    assert.equal(project.database.id, 'db-1');
    assert.equal(project.database.secret, undefined);
    assert.doesNotMatch(JSON.stringify(project), /plaintext-password|ciphertext-envelope|cluster-secret-ref/);
  });
});

describe('database URL redaction', () => {
  test('structured redaction recognizes all three explicit DSN names', () => {
    assert.deepEqual(DATABASE_URL_KEYS, [
      'DATABASE_URL',
      'DIRECT_DATABASE_URL',
      'PRISMA_DATABASE_URL',
    ]);
    for (const key of DATABASE_URL_KEYS) {
      assert.equal(isSensitiveKey(key), true, key);
    }
    assert.equal(isSensitiveKey('CODEX_DATABASE_VAULT_KEYS'), true);

    const redacted = redactPayloadDeep({
      DATABASE_URL: 'postgres://runtime-secret',
      nested: {
        DIRECT_DATABASE_URL: 'postgres://direct-secret',
        PRISMA_DATABASE_URL: 'prisma+postgres://signed-secret',
      },
      CODEX_DATABASE_VAULT_KEYS: '{"key":"vault-secret"}',
    });
    assert.deepEqual(redacted, {
      DATABASE_URL: '[REDACTED]',
      nested: {
        DIRECT_DATABASE_URL: '[REDACTED]',
        PRISMA_DATABASE_URL: '[REDACTED]',
      },
      CODEX_DATABASE_VAULT_KEYS: '[REDACTED]',
    });
  });

  test('string redaction removes entire named DSNs from env and JSON-like logs', () => {
    const input = [
      'DATABASE_URL=postgres://runtime:runtime-secret@runtime.internal/app',
      'DIRECT_DATABASE_URL: postgresql://migrator:direct-secret@direct.internal/app',
      '"PRISMA_DATABASE_URL":"prisma+postgres://accelerate.invalid/?api_key=signed-secret"',
    ].join(' ');
    const redacted = redactString(input);
    assert.equal((redacted.match(/\[REDACTED_DATABASE_URL\]/g) || []).length, 3);
    assert.doesNotMatch(
      redacted,
      /runtime-secret|runtime\.internal|direct-secret|direct\.internal|accelerate\.invalid|signed-secret/,
    );
  });

  test('string redaction removes an unlabeled project DSN including host and database', () => {
    const redacted = redactString(
      'driver failed for postgresql://project-user:secret@project-db.internal/tenant_123',
    );
    assert.equal(redacted, 'driver failed for [REDACTED_DATABASE_URL]');
    assert.doesNotMatch(redacted, /project-user|secret|project-db|tenant_123/);
  });
});
