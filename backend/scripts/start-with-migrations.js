#!/usr/bin/env node
/**
 * Backend boot wrapper: runs `prisma migrate deploy` against the
 * production database, then execs the backend entrypoint. On migration
 * failure exits non-zero so the container is replaced. If
 * SKIP_MIGRATIONS=1 skips only normal local boot. The release-oriented
 * `--migrate-only` path rejects that setting with configuration exit 78.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { loadEnvFiles } = require("../src/config/load-env");
const { runBoundedProcessTree } = require("../src/utils/bounded-process-tree");
const {
  DIRECT_DATABASE_URL_REQUIRED_CODE,
  isDirectPostgresUrl: isDirectPostgresDatabaseUrl,
  redactDatabaseUrls,
  requireDirectMigrationDatabaseUrl,
  resolveDatabaseUrls,
} = require("../src/config/database-url");

const BACKEND_DIR = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(BACKEND_DIR, "prisma", "migrations");
const SHUTDOWN_MESSAGE_TYPE = "siragpt:shutdown";
const MIGRATION_COMMAND_TIMEOUT_CODE = "MIGRATION_COMMAND_TIMEOUT";
const MIGRATION_COMMAND_ABORTED_CODE = "MIGRATION_COMMAND_ABORTED";
const MIGRATION_COMMAND_OUTPUT_LIMIT_CODE = "MIGRATION_COMMAND_OUTPUT_LIMIT";
const MIGRATION_PROCESS_TREE_NOT_TERMINATED_CODE = "MIGRATION_PROCESS_TREE_NOT_TERMINATED";
const MIGRATION_DB_OPERATION_TIMEOUT_CODE = "MIGRATION_DB_OPERATION_TIMEOUT";
const DEFAULT_MIGRATION_COMMAND_TIMEOUT_MS = 300_000;
const DEFAULT_BOOT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_MIGRATION_KILL_GRACE_MS = 250;
const DEFAULT_MIGRATION_DB_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MIGRATION_DB_QUERY_TIMEOUT_MS = 15_000;
const DEFAULT_MIGRATION_DB_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_MIGRATION_DB_CLOSE_TIMEOUT_MS = 5_000;
const MAX_BOOT_OPERATION_TIMEOUT_MS = 3_600_000;
const MIGRATION_COMMAND_TIMEOUT_EXIT_STATUS = 124;
const MIGRATION_COMMAND_ABORTED_EXIT_STATUS = 143;
const MIGRATION_COMMAND_OUTPUT_LIMIT_EXIT_STATUS = 125;
const MIGRATION_PROCESS_TREE_NOT_TERMINATED_EXIT_STATUS = 126;
const MIGRATION_CONFIGURATION_EXIT_STATUS = 78;
const MIGRATION_LIFECYCLE_EXIT_STATUS = 75;
const MIGRATION_EQUIVALENT_UNBASELINED_ENV = "MIGRATION_ALLOW_EQUIVALENT_UNBASELINED";
const DATABASE_SSL_URL_KEYS = new Set([
  "ssl",
  "sslcert",
  "sslkey",
  "sslmode",
  "sslpassword",
  "sslrootcert",
  "uselibpqcompat",
]);
const DATABASE_SSL_MODES = new Set([
  "allow",
  "disable",
  "no-verify",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);
const INSECURE_DATABASE_SSL_MODES = new Set([
  "allow",
  "disable",
  "no-verify",
  "prefer",
]);
const DATABASE_SSL_MATERIAL_MAX_BYTES = 1024 * 1024;
const DATABASE_SSL_PATH_MAX_CHARS = 4096;
const DATABASE_SSL_MATERIALS = Object.freeze([
  Object.freeze({
    kind: "ca",
    property: "ca",
    urlKey: "sslrootcert",
    envKey: "DATABASE_SSL_CA",
  }),
  Object.freeze({
    kind: "cert",
    property: "cert",
    urlKey: "sslcert",
    envKey: "DATABASE_SSL_CERT",
  }),
  Object.freeze({
    kind: "key",
    property: "key",
    urlKey: "sslkey",
    envKey: "DATABASE_SSL_KEY",
  }),
]);
const SAFE_AUTO_ROLLBACK_MIGRATIONS = [
  {
    pattern: /^\d{14}_reset_admin_password$/,
    reason: "data-only admin credential repair",
  },
  {
    pattern: /^20260520160000_add_org_pending_transfer$/,
    reason: "idempotent org pending-transfer schema migration",
  },
  {
    pattern: /^20250919203030_add_model_sync_fields$/,
    reason:
      "idempotent additive AiModel sync columns (ADD COLUMN IF NOT EXISTS); a merge renamed this migration and re-running ADD COLUMN re-failed with 42701 -> P3009 -> boot abort. Safe to roll back and retry.",
  },
  {
    pattern: /^20260611120000_add_user_memory_confidence$/,
    reason: "idempotent ADD COLUMN IF NOT EXISTS confidence to user_memories; safe to re-run.",
  },
  {
    pattern: /^20260612120000_fix_user_memories_embedding_column$/,
    reason: "idempotent CREATE EXTENSION IF NOT EXISTS vector + ADD COLUMN IF NOT EXISTS embedding; safe to re-run.",
  },
];

function log(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), scope: "boot", msg, ...extra }) + "\n");
}

// Wall-clock anchor so every structured phase event carries an elapsed_ms since
// the wrapper started — turns a wall of free-text logs into a queryable boot
// timeline (env-load -> db-preflight -> migrate-lock -> migrate -> backend-start).
const BOOT_STARTED_AT = Date.now();

function phase(name, extra = {}) {
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(),
    scope: "boot",
    event: "boot_phase",
    phase: name,
    elapsed_ms: Date.now() - BOOT_STARTED_AT,
    ...extra,
  }) + "\n");
}

function parseBoundedTimeout(value, fallback, max = MAX_BOOT_OPERATION_TIMEOUT_MS) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(1, parsed));
}

function resolveMigrationCommandTimeoutMs(env = process.env) {
  return parseBoundedTimeout(
    env.MIGRATION_COMMAND_TIMEOUT_MS,
    DEFAULT_MIGRATION_COMMAND_TIMEOUT_MS,
  );
}

function resolveBootCommandTimeoutMs(env = process.env) {
  return parseBoundedTimeout(
    env.BOOT_COMMAND_TIMEOUT_MS,
    DEFAULT_BOOT_COMMAND_TIMEOUT_MS,
    60_000,
  );
}

function resolveMigrationPgTimeoutConfig(env = process.env) {
  return Object.freeze({
    connectionTimeoutMs: parseBoundedTimeout(
      env.MIGRATION_DB_CONNECT_TIMEOUT_MS,
      DEFAULT_MIGRATION_DB_CONNECT_TIMEOUT_MS,
    ),
    queryTimeoutMs: parseBoundedTimeout(
      env.MIGRATION_DB_QUERY_TIMEOUT_MS,
      DEFAULT_MIGRATION_DB_QUERY_TIMEOUT_MS,
    ),
    statementTimeoutMs: parseBoundedTimeout(
      env.MIGRATION_DB_STATEMENT_TIMEOUT_MS,
      DEFAULT_MIGRATION_DB_STATEMENT_TIMEOUT_MS,
    ),
  });
}

function migrationErrorMessage(error, env = process.env) {
  return redactDatabaseUrls(error?.message || error || "unknown migration error", env);
}

const PG_FAILURE_CODES = Object.freeze({
  ENOTFOUND: "MIGRATION_DB_DNS_FAILED",
  EAI_AGAIN: "MIGRATION_DB_DNS_FAILED",
  ECONNREFUSED: "MIGRATION_DB_UNAVAILABLE",
  ECONNRESET: "MIGRATION_DB_CONNECTION_RESET",
  ETIMEDOUT: "MIGRATION_DB_TIMEOUT",
  "28P01": "MIGRATION_DB_AUTH_FAILED",
  "3D000": "MIGRATION_DB_NOT_FOUND",
  "57P03": "MIGRATION_DB_STARTING",
});

function sanitizePgFailure(error, fallbackCode = "MIGRATION_DB_OPERATION_FAILED") {
  const rawCode = String(error?.code || "").toUpperCase();
  const code = [MIGRATION_DB_OPERATION_TIMEOUT_CODE, MIGRATION_COMMAND_ABORTED_CODE]
    .includes(rawCode)
    ? rawCode
    : PG_FAILURE_CODES[rawCode] || fallbackCode;
  return { code };
}

function safePgError(error, fallbackCode) {
  const { code } = sanitizePgFailure(error, fallbackCode);
  const safe = new Error(code);
  safe.name = "MigrationDatabaseError";
  safe.code = code;
  return safe;
}

function migrationLifecycleError(code, exitStatus = MIGRATION_LIFECYCLE_EXIT_STATUS) {
  const error = new Error(code);
  error.name = "MigrationLifecycleError";
  error.code = code;
  error.exitStatus = exitStatus;
  return error;
}

function pipeResult(result, options = {}) {
  const {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
  } = options;
  if (result.stdout) stdout.write(redactDatabaseUrls(result.stdout, env));
  if (result.stderr) stderr.write(redactDatabaseUrls(result.stderr, env));
}

function prismaCommandExitStatus(result) {
  if (result?.migrationCode === MIGRATION_COMMAND_TIMEOUT_CODE) {
    return MIGRATION_COMMAND_TIMEOUT_EXIT_STATUS;
  }
  if (result?.migrationCode === MIGRATION_COMMAND_ABORTED_CODE) {
    return MIGRATION_COMMAND_ABORTED_EXIT_STATUS;
  }
  if (result?.migrationCode === MIGRATION_COMMAND_OUTPUT_LIMIT_CODE) {
    return MIGRATION_COMMAND_OUTPUT_LIMIT_EXIT_STATUS;
  }
  if (result?.migrationCode === MIGRATION_PROCESS_TREE_NOT_TERMINATED_CODE) {
    return MIGRATION_PROCESS_TREE_NOT_TERMINATED_EXIT_STATUS;
  }
  if (Number.isInteger(result?.status) && result.status >= 0) return result.status;
  return 1;
}

function isTerminalMigrationCommandResult(result) {
  const status = prismaCommandExitStatus(result);
  return (
    result?.timedOut === true
    || result?.aborted === true
    || result?.outputLimitExceeded === true
    || result?.treeTerminated === false
    || [
      MIGRATION_COMMAND_TIMEOUT_CODE,
      MIGRATION_COMMAND_ABORTED_CODE,
      MIGRATION_COMMAND_OUTPUT_LIMIT_CODE,
      MIGRATION_PROCESS_TREE_NOT_TERMINATED_CODE,
    ].includes(result?.migrationCode)
    || [
      MIGRATION_COMMAND_TIMEOUT_EXIT_STATUS,
      MIGRATION_COMMAND_ABORTED_EXIT_STATUS,
      MIGRATION_COMMAND_OUTPUT_LIMIT_EXIT_STATUS,
      MIGRATION_PROCESS_TREE_NOT_TERMINATED_EXIT_STATUS,
    ].includes(status)
  );
}

async function runPrisma(args, options = {}) {
  const env = options.env || process.env;
  if (env === process.env) loadDotenv();
  const command = options.command || "npx";
  const commandPrefix = options.commandPrefix || ["prisma"];
  const cwd = options.cwd || BACKEND_DIR;
  const pipe = options.pipe !== false;
  const timeoutMs = options.timeoutMs ?? resolveMigrationCommandTimeoutMs(env);
  const signal = options.signal || activeMigrationAbortController?.signal;
  const childEnv = { ...env };
  synchronizePrismaDatabaseUrl(childEnv);
  const result = await (options.runProcessImpl || runBoundedProcessTree)(
    command,
    [...commandPrefix, ...args],
    {
      cwd,
      env: childEnv,
      signal,
      timeoutMs: parseBoundedTimeout(timeoutMs, DEFAULT_MIGRATION_COMMAND_TIMEOUT_MS),
      killGraceMs: parseBoundedTimeout(
        options.killGraceMs,
        DEFAULT_MIGRATION_KILL_GRACE_MS,
        10_000,
      ),
      input: options.input,
      maxOutputBytes: options.maxOutputBytes,
      spawnImpl: options.spawnImpl,
    },
  );
  let migrationCode;
  if (result.timedOut) migrationCode = MIGRATION_COMMAND_TIMEOUT_CODE;
  else if (result.aborted) migrationCode = MIGRATION_COMMAND_ABORTED_CODE;
  else if (result.outputLimitExceeded) migrationCode = MIGRATION_COMMAND_OUTPUT_LIMIT_CODE;
  else if (result.treeTerminated === false) {
    migrationCode = MIGRATION_PROCESS_TREE_NOT_TERMINATED_CODE;
  }
  const outcome = migrationCode ? { ...result, migrationCode } : result;
  if (pipe) pipeResult(outcome, { env: childEnv });
  return outcome;
}

async function runBoundedBootCommand(command, args, options = {}) {
  const env = options.env || process.env;
  return (options.runProcessImpl || runBoundedProcessTree)(command, args, {
    cwd: options.cwd || BACKEND_DIR,
    env,
    signal: options.signal || activeMigrationAbortController?.signal,
    timeoutMs: options.timeoutMs ?? resolveBootCommandTimeoutMs(env),
    killGraceMs: options.killGraceMs ?? DEFAULT_MIGRATION_KILL_GRACE_MS,
    maxOutputBytes: options.maxOutputBytes,
    spawnImpl: options.spawnImpl,
  });
}

function loadDotenv() {
  try {
    loadEnvFiles();
  } catch (err) {
    log("dotenv load skipped", { error: migrationErrorMessage(err) });
  }
}

function resolvePrismaDatabaseUrl(env = process.env) {
  return requireDirectMigrationDatabaseUrl(env);
}

function synchronizePrismaDatabaseUrl(env = process.env) {
  const { runtimeUrl, directMigrationUrl } = resolveDatabaseUrls(env);
  if (!directMigrationUrl) {
    return requireDirectMigrationDatabaseUrl(env);
  }
  // Prisma CLI reads DATABASE_URL from schema.prisma. Preserve the runtime URL
  // in its own role and point only the CLI child environment at the direct URL.
  if (runtimeUrl) env.PRISMA_DATABASE_URL = runtimeUrl;
  env.DIRECT_DATABASE_URL = directMigrationUrl;
  env.DATABASE_URL = directMigrationUrl;
  return directMigrationUrl;
}

function databaseSslConfigurationError(code) {
  const error = new Error("PostgreSQL TLS configuration was rejected.");
  error.name = "DatabaseSslConfigurationError";
  error.code = code;
  error.exitStatus = MIGRATION_CONFIGURATION_EXIT_STATUS;
  return error;
}

function databaseSslMaterialError(source, kind) {
  const label = String(kind).toUpperCase();
  const code = source === "url"
    ? `DATABASE_SSL_URL_${label}_UNUSABLE`
    : `DATABASE_SSL_${label}_READ_FAILED`;
  return databaseSslConfigurationError(code);
}

function isDatabaseSslPem(value, kind) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > DATABASE_SSL_MATERIAL_MAX_BYTES
  ) {
    return false;
  }
  const labels = Array.from(
    value.matchAll(/-----BEGIN ([A-Z0-9][A-Z0-9 ]*)-----[\s\S]*?-----END \1-----/g),
    (match) => match[1],
  );
  if (kind === "key") {
    return labels.some((label) => /(?:^| )PRIVATE KEY$/.test(label));
  }
  return labels.some((label) => [
    "CERTIFICATE",
    "TRUSTED CERTIFICATE",
    "X509 CERTIFICATE",
  ].includes(label));
}

function readBoundedDatabaseSslFile(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile()
      || stat.size <= 0
      || stat.size > DATABASE_SSL_MATERIAL_MAX_BYTES
    ) {
      return undefined;
    }

    const buffer = Buffer.allocUnsafe(DATABASE_SSL_MATERIAL_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead === 0 || bytesRead > DATABASE_SSL_MATERIAL_MAX_BYTES) {
      return undefined;
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // A close failure cannot add safe diagnostics and the TLS config fails.
      }
    }
  }
}

function resolveDatabaseSslMaterial(configured, { source, kind }) {
  const value = String(configured ?? "").trim();
  if (!value) throw databaseSslMaterialError(source, kind);

  const expanded = value.includes("\\n")
    ? value.replaceAll("\\n", "\n")
    : value;
  if (expanded.includes("-----BEGIN ")) {
    if (!isDatabaseSslPem(expanded, kind)) {
      throw databaseSslMaterialError(source, kind);
    }
    return expanded;
  }

  if (
    value.length > DATABASE_SSL_PATH_MAX_CHARS
    || value.includes("\0")
    || value.includes("\n")
    || value.includes("\r")
  ) {
    throw databaseSslMaterialError(source, kind);
  }
  const candidates = path.isAbsolute(value)
    ? [value]
    : [path.resolve(BACKEND_DIR, value), path.resolve(value)];
  const materialPath = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
  const contents = readBoundedDatabaseSslFile(materialPath);
  if (!isDatabaseSslPem(contents, kind)) {
    // Never attach the configured value, path, filesystem error, or material
    // to this exception: boot and deploy logging may serialize it.
    throw databaseSslMaterialError(source, kind);
  }
  return contents;
}

function resolveDatabaseSslCa(env = process.env) {
  const configured = String(env.DATABASE_SSL_CA || "").trim();
  if (!configured) return undefined;
  return resolveDatabaseSslMaterial(configured, { source: "env", kind: "ca" });
}

function resolveDatabaseSslMaterials(urlTlsEntries, env = process.env) {
  const materials = {};
  const sources = {};

  for (const definition of DATABASE_SSL_MATERIALS) {
    const envValue = String(env[definition.envKey] || "").trim();
    const urlValues = urlTlsEntries
      .filter(({ key }) => key === definition.urlKey)
      .map(({ value }) => value);
    let source;
    let configured;
    if (envValue) {
      source = "env";
      configured = envValue;
    } else if (urlValues.length === 1) {
      source = "url";
      [configured] = urlValues;
    } else if (urlValues.length > 1) {
      throw databaseSslMaterialError("url", definition.kind);
    } else {
      continue;
    }

    materials[definition.property] = resolveDatabaseSslMaterial(configured, {
      source,
      kind: definition.kind,
    });
    sources[definition.property] = source;
  }

  if (Boolean(materials.cert) !== Boolean(materials.key)) {
    const missingPairProperty = materials.cert ? "cert" : "key";
    throw databaseSslMaterialError(
      sources[missingPairProperty] || "env",
      missingPairProperty,
    );
  }

  const sslPasswords = urlTlsEntries
    .filter(({ key }) => key === "sslpassword")
    .map(({ value }) => value);
  if (sslPasswords.length > 0) {
    // Node pg does not map libpq sslpassword to a TLS passphrase. Reject it
    // explicitly instead of deleting a client-key credential that will not work.
    throw databaseSslConfigurationError("DATABASE_SSL_URL_PASSPHRASE_UNSUPPORTED");
  }

  return materials;
}

function sanitizeDatabaseSslUrl(url, env = process.env) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw databaseSslConfigurationError("DATABASE_SSL_URL_INVALID");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw databaseSslConfigurationError("DATABASE_SSL_URL_INVALID");
  }

  const urlTlsEntries = Array.from(parsed.searchParams.entries())
    .filter(([key]) => DATABASE_SSL_URL_KEYS.has(String(key).toLowerCase()))
    .map(([key, value]) => ({
      key: String(key).toLowerCase(),
      value: String(value),
      normalizedValue: String(value).trim().toLowerCase(),
    }));
  const sslModes = urlTlsEntries
    .filter(({ key }) => key === "sslmode")
    .map(({ normalizedValue }) => normalizedValue);
  const sslValues = urlTlsEntries
    .filter(({ key }) => key === "ssl")
    .map(({ normalizedValue }) => normalizedValue);
  const explicitVerificationOptOut = (
    String(env.DATABASE_SSL_REJECT_UNAUTHORIZED || "").trim().toLowerCase() === "false"
  );

  if (sslModes.some((mode) => !DATABASE_SSL_MODES.has(mode))) {
    throw databaseSslConfigurationError("DATABASE_SSL_MODE_INVALID");
  }
  const distinctModes = new Set(sslModes);
  const sslValueKinds = new Set(sslValues.map((value) => {
    if (["1", "true"].includes(value)) return "verified";
    if (["0", "disable", "false", "no-verify"].includes(value)) return "insecure";
    return "invalid";
  }));
  if (sslValueKinds.has("invalid")) {
    throw databaseSslConfigurationError("DATABASE_SSL_MODE_INVALID");
  }
  const insecureOrConflicting = (
    sslModes.some((mode) => INSECURE_DATABASE_SSL_MODES.has(mode))
    || distinctModes.size > 1
    || sslValueKinds.has("insecure")
    || sslValueKinds.size > 1
  );
  if (insecureOrConflicting && !explicitVerificationOptOut) {
    throw databaseSslConfigurationError("DATABASE_SSL_MODE_INSECURE");
  }

  const materials = resolveDatabaseSslMaterials(urlTlsEntries, env);
  const needsSsl = (
    urlTlsEntries.length > 0
    || Object.keys(materials).length > 0
    || /(?:^|\.)neon\.tech$/i.test(parsed.hostname)
  );
  const ssl = needsSsl
    ? {
      rejectUnauthorized: !explicitVerificationOptOut,
      ...materials,
    }
    : false;

  // pg parses connectionString after top-level options and lets URL SSL
  // settings override them. Delete only after every effective TLS value has
  // been validated and copied into the explicit object above.
  const keysToDelete = new Set(
    Array.from(parsed.searchParams.keys())
      .filter((key) => DATABASE_SSL_URL_KEYS.has(String(key).toLowerCase())),
  );
  for (const key of keysToDelete) parsed.searchParams.delete(key);

  return {
    connectionString: parsed.toString(),
    needsSsl,
    rejectUnauthorized: !explicitVerificationOptOut,
    ssl,
  };
}

function makePgClientOptions(url, env = process.env) {
  const sanitized = sanitizeDatabaseSslUrl(url, env);
  const timeouts = resolveMigrationPgTimeoutConfig(env);
  return {
    connectionString: sanitized.connectionString,
    ssl: sanitized.ssl,
    connectionTimeoutMillis: timeouts.connectionTimeoutMs,
    query_timeout: timeouts.queryTimeoutMs,
    statement_timeout: timeouts.statementTimeoutMs,
  };
}

// Only a direct postgres URL can be dialed by `pg` (and by `migrate deploy`).
// A Prisma Accelerate `prisma+postgres://` URL cannot, so preflight and the
// advisory lock must skip — fast — rather than retry a connection that can
// never succeed.
function isDirectPostgresUrl(url) {
  return isDirectPostgresDatabaseUrl(url);
}

function createPgClient(url = resolvePrismaDatabaseUrl(), env = process.env) {
  const { Client } = require("pg");
  return new Client(makePgClientOptions(url, env));
}

function isSafeAutoRollbackMigration(migrationName) {
  return SAFE_AUTO_ROLLBACK_MIGRATIONS.some(({ pattern }) => pattern.test(migrationName));
}

// Statements that are provably idempotent AND purely additive: re-running them
// against a database that already has the object is a no-op, never destructive.
const IDEMPOTENT_ADDITIVE_STATEMENT = [
  /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/i,
  /^CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\b/i,
  /^CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\b/i,
];

// Any of these tokens makes a statement ineligible for auto-rollback because a
// retry could lose data or fail outside a transaction (e.g. ALTER TYPE ADD
// VALUE, CREATE INDEX CONCURRENTLY). Conservative on purpose.
const FORBIDDEN_STATEMENT_TOKEN =
  /\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME|ALTER\s+COLUMN|ADD\s+CONSTRAINT|ADD\s+PRIMARY|ADD\s+FOREIGN|ADD\s+UNIQUE|SET\s+NOT\s+NULL|CONCURRENTLY|ALTER\s+TYPE|CREATE\s+TYPE)\b/i;

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function splitSqlStatements(sql) {
  return stripSqlComments(sql)
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

// `ALTER TABLE … ADD COLUMN IF NOT EXISTS …[, ADD COLUMN IF NOT EXISTS …]` is the
// most common additive migration. Treat it as safe only when EVERY `ADD COLUMN`
// is guarded and no other (potentially destructive) operation is present.
function isIdempotentAdditiveAlterTable(statement) {
  if (!/^ALTER\s+TABLE\b/i.test(statement)) return false;
  if (FORBIDDEN_STATEMENT_TOKEN.test(statement)) return false;
  const addColumns = (statement.match(/\bADD\s+COLUMN\b/gi) || []).length;
  if (addColumns === 0) return false;
  const guardedAddColumns = (statement.match(/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi) || []).length;
  return addColumns === guardedAddColumns;
}

function isIdempotentAdditiveStatement(statement) {
  if (FORBIDDEN_STATEMENT_TOKEN.test(statement)) return false;
  if (IDEMPOTENT_ADDITIVE_STATEMENT.some((pattern) => pattern.test(statement))) return true;
  return isIdempotentAdditiveAlterTable(statement);
}

// Static analysis of a migration's SQL. Returns true only when the file can be
// fully parsed into statements that are ALL idempotent-additive. Dollar-quoted
// blocks (DO $$ … $$) and any unrecognised statement make it ineligible, so the
// explicit allowlist remains the only path for anything non-trivial.
function migrationSqlIsIdempotentAdditive(migrationName, migrationsDir = MIGRATIONS_DIR) {
  if (typeof migrationName !== "string" || !/^[A-Za-z0-9_]+$/.test(migrationName)) {
    return false;
  }
  let sql;
  try {
    sql = fs.readFileSync(path.join(migrationsDir, migrationName, "migration.sql"), "utf8");
  } catch {
    return false;
  }
  if (/\$\w*\$/.test(sql)) return false; // dollar-quoted body — too complex to prove safe
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) return false;
  return statements.every(isIdempotentAdditiveStatement);
}

// A migration may be auto-rolled-back after a P3009 when it is either on the
// explicit allowlist or its SQL is provably idempotent-additive.
function isMigrationAutoRollbackSafe(migrationName, migrationsDir = MIGRATIONS_DIR) {
  return (
    isSafeAutoRollbackMigration(migrationName) ||
    migrationSqlIsIdempotentAdditive(migrationName, migrationsDir)
  );
}

function extractP3009MigrationNames(output) {
  const names = new Set();
  for (const match of output.matchAll(/The `([^`]+)` migration started at/g)) {
    names.add(match[1]);
  }
  for (const match of output.matchAll(/\b(\d{14}_[A-Za-z0-9_]+)\b/g)) {
    names.add(match[1]);
  }
  return Array.from(names);
}

function shouldContinueAfterSafeP3009(output) {
  if (!output.includes("P3009")) return false;
  const names = extractP3009MigrationNames(output);
  return names.length > 0 && names.every((name) => isMigrationAutoRollbackSafe(name));
}

async function getActiveFailedMigrations() {
  loadDotenv();
  const url = resolvePrismaDatabaseUrl();
  if (!url) {
    throw new Error("PRISMA_DATABASE_URL is not configured");
  }

  const { Client } = require("pg");
  const client = new Client(makePgClientOptions(url));
  const timeouts = resolveMigrationPgTimeoutConfig(process.env);
  try {
    await withOperationTimeout(
      () => client.connect(),
      timeouts.connectionTimeoutMs,
      "connection",
    );
    const { rows } = await withOperationTimeout(() => client.query(`
      SELECT migration_name
      FROM "_prisma_migrations"
      WHERE finished_at IS NULL
        AND rolled_back_at IS NULL
      ORDER BY started_at ASC
    `), timeouts.queryTimeoutMs, "failed migration query");
    return rows.map((row) => row.migration_name);
  } finally {
    await closePgClient(client);
  }
}

async function markSafeMigrationsRolledBack(migrationNames) {
  loadDotenv();
  const url = resolvePrismaDatabaseUrl();
  if (!url) {
    throw new Error("PRISMA_DATABASE_URL is not configured");
  }

  const { Client } = require("pg");
  const client = new Client(makePgClientOptions(url));
  const timeouts = resolveMigrationPgTimeoutConfig(process.env);
  try {
    await withOperationTimeout(
      () => client.connect(),
      timeouts.connectionTimeoutMs,
      "connection",
    );
    await withOperationTimeout(() => client.query(`
      UPDATE "_prisma_migrations"
      SET rolled_back_at = COALESCE(rolled_back_at, NOW()),
          logs = CONCAT(
            COALESCE(logs, ''),
            CASE WHEN COALESCE(logs, '') = '' THEN '' ELSE E'\\n' END,
            '[boot] auto-marked rolled back: safe migration blocked backend startup with P3009'
          )
      WHERE migration_name = ANY($1::text[])
        AND finished_at IS NULL
        AND rolled_back_at IS NULL
    `, [migrationNames]), timeouts.queryTimeoutMs, "migration rollback query");
  } finally {
    await closePgClient(client);
  }
}

async function rollbackSafeFailedMigrations() {
  let failedMigrations;
  try {
    failedMigrations = await getActiveFailedMigrations();
  } catch (err) {
    const failure = sanitizePgFailure(err, "MIGRATION_INSPECTION_FAILED");
    log("could not inspect failed prisma migrations", {
      code: failure.code,
    });
    return false;
  }

  if (failedMigrations.length === 0) {
    log("P3009 reported but no active failed migrations were found");
    return false;
  }

  const unsafe = failedMigrations.filter((name) => !isMigrationAutoRollbackSafe(name));
  if (unsafe.length > 0) {
    log("refusing to auto-rollback unknown migration failures", { failedMigrations, unsafe });
    return false;
  }

  try {
    await markSafeMigrationsRolledBack(failedMigrations);
    log("auto-rolled back safe failed migrations", { failedMigrations });
    return true;
  } catch (err) {
    const failure = sanitizePgFailure(err, "MIGRATION_ROLLBACK_FAILED");
    log("failed to auto-rollback safe migrations", {
      code: failure.code,
      failedMigrations,
    });
    return false;
  }
}

async function verifyEquivalentUnbaselinedSchema(options = {}) {
  const env = options.env || process.env;
  const runPrismaImpl = options.runPrismaImpl || ((args, prismaOptions = {}) => runPrisma(
    args,
    { ...prismaOptions, env },
  ));
  const logFn = options.logFn || log;

  // The schema datasource reads DATABASE_URL. runPrisma synchronizes that
  // child-only variable to the resolved direct migration datasource. The
  // compatibility path proves equivalence only; it never edits migration
  // history and is therefore safe only for this no-schema rollout.
  const diffArgs = [
    "migrate",
    "diff",
    "--from-schema-datasource",
    "prisma/schema.prisma",
    "--to-schema-datamodel",
    "prisma/schema.prisma",
    "--exit-code",
  ];
  logFn("verifying_equivalent_unbaselined_schema");
  const diff = await runPrismaImpl(diffArgs, {
    signal: options.signal,
    timeoutMs: resolveMigrationCommandTimeoutMs(env),
  });
  const diffStatus = diff.error
    ? Math.max(1, prismaCommandExitStatus(diff))
    : prismaCommandExitStatus(diff);
  if (diff.error || diffStatus !== 0) {
    logFn("schema_drift_or_diff_failure", {
      code: diff.migrationCode || diff.error?.code || "MIGRATION_SCHEMA_NOT_EQUIVALENT",
      status: diffStatus,
    });
    return diffStatus;
  }

  logFn("schema_equivalent_unbaselined", {
    migrationHistoryChanged: false,
  });
  return 0;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function migrationOperationTimeoutError(operation) {
  const error = new Error(`Timed out while waiting for migration database ${operation}.`);
  error.name = "MigrationDatabaseTimeoutError";
  error.code = MIGRATION_DB_OPERATION_TIMEOUT_CODE;
  return error;
}

function migrationOperationAbortedError(operation) {
  const error = new Error(`Migration database ${operation} was aborted.`);
  error.name = "MigrationDatabaseAbortError";
  error.code = MIGRATION_COMMAND_ABORTED_CODE;
  return error;
}

async function withOperationTimeout(operation, timeoutMs, label = "operation", signal) {
  const boundedTimeoutMs = parseBoundedTimeout(
    timeoutMs,
    DEFAULT_MIGRATION_DB_QUERY_TIMEOUT_MS,
  );
  let timer;
  let onAbort;
  try {
    if (signal?.aborted) throw migrationOperationAbortedError(label);
    const racers = [
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(migrationOperationTimeoutError(label)),
          boundedTimeoutMs,
        );
      }),
    ];
    if (signal) {
      racers.push(new Promise((_, reject) => {
        onAbort = () => reject(migrationOperationAbortedError(label));
        signal.addEventListener("abort", onAbort, { once: true });
      }));
    }
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function withDeadline(
  operation,
  deadline,
  now,
  label,
  operationTimeoutMs = MAX_BOOT_OPERATION_TIMEOUT_MS,
  signal,
) {
  const remainingMs = Math.max(
    1,
    Math.min(deadline - now(), parseBoundedTimeout(operationTimeoutMs, MAX_BOOT_OPERATION_TIMEOUT_MS)),
  );
  return withOperationTimeout(operation, remainingMs, label, signal);
}

async function closePgClient(client, timeoutMs = DEFAULT_MIGRATION_DB_CLOSE_TIMEOUT_MS) {
  if (!client || typeof client.end !== "function") return;
  try {
    await withOperationTimeout(() => client.end(), timeoutMs, "client cleanup");
  } catch {
    // node-postgres may be stuck before its normal end path can settle. Destroy
    // the underlying socket best-effort; never let cleanup extend boot forever.
    try { client.connection?.stream?.destroy(); } catch { /* already closed */ }
  }
}

function isTransientMigrationError(result) {
  if (isTerminalMigrationCommandResult(result)) return false;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return (
    output.includes("P1011") ||
    output.includes("P1000") ||
    output.includes("unexpected EOF") ||
    output.includes("Connection reset") ||
    output.includes("ECONNRESET") ||
    output.includes("ETIMEDOUT") ||
    output.includes("TLS connection")
  );
}

const DEFAULT_MIGRATION_TRANSIENT_RETRIES = 6;
const DEFAULT_MIGRATION_RETRY_DELAY_MS = 8_000;
const DEFAULT_MIGRATION_PREFLIGHT_ATTEMPTS = 10;
const DEFAULT_MIGRATION_PREFLIGHT_DELAY_MS = 3_000;
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 120_000;
const DEFAULT_MIGRATION_LOCK_POLL_MS = 1_500;

function resolveMigrationRetryConfig(env = process.env) {
  return Object.freeze({
    attempts: parseBoundedTimeout(
      env.MIGRATION_TRANSIENT_RETRIES,
      DEFAULT_MIGRATION_TRANSIENT_RETRIES,
      20,
    ),
    delayMs: parseBoundedTimeout(
      env.MIGRATION_RETRY_DELAY_MS,
      DEFAULT_MIGRATION_RETRY_DELAY_MS,
      300_000,
    ),
  });
}

function resolveMigrationLifecycleConfig(env = process.env) {
  return Object.freeze({
    preflightAttempts: parseBoundedTimeout(
      env.MIGRATION_PREFLIGHT_ATTEMPTS,
      DEFAULT_MIGRATION_PREFLIGHT_ATTEMPTS,
      100,
    ),
    preflightDelayMs: parseBoundedTimeout(
      env.MIGRATION_PREFLIGHT_DELAY_MS,
      DEFAULT_MIGRATION_PREFLIGHT_DELAY_MS,
      300_000,
    ),
    lockTimeoutMs: parseBoundedTimeout(
      env.MIGRATION_LOCK_TIMEOUT_MS,
      DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
    ),
    lockPollMs: parseBoundedTimeout(
      env.MIGRATION_LOCK_POLL_MS,
      DEFAULT_MIGRATION_LOCK_POLL_MS,
      60_000,
    ),
  });
}

// ── Boot v2: DB preflight + cross-instance migration advisory lock ──────────
// All of this is best-effort and fail-safe: any error degrades to the prior
// behaviour (proceed straight to `migrate deploy`). Nothing here can block boot
// indefinitely or turn a healthy boot into a failed one.
const MIGRATION_LOCK_NAME = "siragpt:prisma-migrate-deploy";

// Deterministic [int4, int4] key pair for pg_advisory_lock(int4, int4) derived
// from a stable name via two differently-seeded FNV-1a passes. Same name ->
// same pair on every instance, so all replicas contend for the same lock.
function computeAdvisoryLockKeys(name) {
  const str = String(name);
  const fnv = (seed, reverse) => {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      const idx = reverse ? str.length - 1 - i : i;
      h ^= str.charCodeAt(idx);
      h = Math.imul(h, 0x01000193);
    }
    return h | 0; // signed 32-bit, valid Postgres int4
  };
  return [fnv(0x811c9dc5, false), fnv(0x811c9dc5 ^ 0x5a5a5a5a, true)];
}

// Wait (with retries) until the database accepts connections, so `migrate
// deploy` doesn't fail immediately against a database that is still starting up
// in an orchestrated deploy. Connection logic is injectable for tests.
async function preflightDatabase(opts = {}) {
  const env = opts.env || process.env;
  const pgTimeouts = resolveMigrationPgTimeoutConfig(env);
  const lifecycle = resolveMigrationLifecycleConfig(env);
  const {
    attempts = lifecycle.preflightAttempts,
    delayMs = lifecycle.preflightDelayMs,
    operationTimeoutMs = pgTimeouts.connectionTimeoutMs
      + pgTimeouts.queryTimeoutMs
      + DEFAULT_MIGRATION_DB_CLOSE_TIMEOUT_MS,
    sleepFn = sleep,
    logFn = phase,
    signal,
  } = opts;
  const connect = opts.connect || (() => defaultPreflightConnect({ env, signal }));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await withOperationTimeout(
        () => connect(),
        operationTimeoutMs,
        "preflight operation",
        signal,
      );
      logFn("db_preflight_ok", { attempt });
      return true;
    } catch (err) {
      const failure = sanitizePgFailure(err, "MIGRATION_DB_PREFLIGHT_FAILED");
      logFn("db_preflight_retry", {
        attempt,
        maxAttempts: attempts,
        code: failure.code,
      });
      if (signal?.aborted) break;
      if (attempt < attempts) {
        await withOperationTimeout(
          () => sleepFn(delayMs),
          parseBoundedTimeout(delayMs, DEFAULT_MIGRATION_PREFLIGHT_DELAY_MS) + 1_000,
          "preflight retry delay",
          signal,
        );
      }
    }
  }
  logFn("db_preflight_exhausted", { attempts });
  return false;
}

async function defaultPreflightConnect(opts = {}) {
  const {
    env = process.env,
    url = resolvePrismaDatabaseUrl(env),
    clientFactory = (databaseUrl) => createPgClient(databaseUrl, env),
    operationTimeoutMs,
    closeTimeoutMs = DEFAULT_MIGRATION_DB_CLOSE_TIMEOUT_MS,
    signal,
  } = opts;
  const timeouts = resolveMigrationPgTimeoutConfig(env);
  if (!url) throw new Error("no database url configured");
  const client = clientFactory(url);
  try {
    try {
      await withOperationTimeout(
        () => client.connect(),
        operationTimeoutMs || timeouts.connectionTimeoutMs,
        "connection",
        signal,
      );
      await withOperationTimeout(
        () => client.query("SELECT 1"),
        operationTimeoutMs || timeouts.queryTimeoutMs,
        "preflight query",
        signal,
      );
    } catch (error) {
      throw safePgError(error, "MIGRATION_DB_PREFLIGHT_FAILED");
    }
  } finally {
    await closePgClient(client, closeTimeoutMs);
  }
}

// Acquire a Postgres session advisory lock so only one booting instance runs
// `migrate deploy` at a time — two replicas applying the same migration
// concurrently is a classic source of failed/half-applied migrations (P3009).
// Returns an async release() function. Best-effort: on any failure it returns a
// no-op release and lets boot proceed (an un-serialised migrate is still better
// than a hung boot).
async function acquireMigrationLock(opts = {}) {
  const env = opts.env || process.env;
  const strict = opts.strict === true;
  const pgTimeouts = resolveMigrationPgTimeoutConfig(env);
  const lifecycle = resolveMigrationLifecycleConfig(env);
  const {
    keys = computeAdvisoryLockKeys(MIGRATION_LOCK_NAME),
    timeoutMs = lifecycle.lockTimeoutMs,
    pollMs = lifecycle.lockPollMs,
    clientFactory = () => createPgClient(resolvePrismaDatabaseUrl(env), env),
    operationTimeoutMs = pgTimeouts.queryTimeoutMs,
    connectionTimeoutMs = pgTimeouts.connectionTimeoutMs,
    closeTimeoutMs = DEFAULT_MIGRATION_DB_CLOSE_TIMEOUT_MS,
    sleepFn = sleep,
    logFn = phase,
    now = Date.now,
    signal,
  } = opts;

  const noop = async () => {};
  const boundedTimeoutMs = parseBoundedTimeout(
    timeoutMs,
    DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  );
  const deadline = now() + boundedTimeoutMs;
  let client;
  try {
    client = clientFactory();
    await withDeadline(
      () => client.connect(),
      deadline,
      now,
      "advisory lock connection",
      connectionTimeoutMs,
      signal,
    );
  } catch (err) {
    const failure = sanitizePgFailure(err, "MIGRATION_LOCK_CONNECT_FAILED");
    logFn("migration_lock_skipped", {
      reason: err?.code === MIGRATION_DB_OPERATION_TIMEOUT_CODE
        ? "connect_timeout"
        : "connect_failed",
      code: failure.code,
    });
    await closePgClient(client, closeTimeoutMs);
    if (strict) throw migrationLifecycleError(failure.code);
    return noop;
  }

  let acquired = false;
  while (now() < deadline) {
    let res;
    try {
      res = await withDeadline(
        () => client.query("SELECT pg_try_advisory_lock($1::int4, $2::int4) AS locked", keys),
        deadline,
        now,
        "advisory lock query",
        operationTimeoutMs,
        signal,
      );
    } catch (err) {
      const failure = sanitizePgFailure(err, "MIGRATION_LOCK_QUERY_FAILED");
      logFn("migration_lock_skipped", {
        reason: err?.code === MIGRATION_DB_OPERATION_TIMEOUT_CODE
          ? "query_timeout"
          : "query_failed",
        code: failure.code,
      });
      await closePgClient(client, closeTimeoutMs);
      if (strict) throw migrationLifecycleError(failure.code);
      return noop;
    }
    const locked = res && res.rows && (res.rows[0]?.locked === true || res.rows[0]?.locked === "t");
    if (locked) { acquired = true; break; }
    logFn("migration_lock_waiting", { pollMs });
    try {
      await withDeadline(
        () => sleepFn(Math.min(pollMs, Math.max(1, deadline - now()))),
        deadline,
        now,
        "advisory lock poll",
        MAX_BOOT_OPERATION_TIMEOUT_MS,
        signal,
      );
    } catch {
      break;
    }
  }

  if (!acquired) {
    logFn("migration_lock_timeout", { timeoutMs: boundedTimeoutMs });
    await closePgClient(client, closeTimeoutMs);
    if (strict) throw migrationLifecycleError("MIGRATION_LOCK_TIMEOUT");
    return noop;
  }

  logFn("migration_lock_acquired", {});
  return async () => {
    let releaseError = null;
    try {
      await withOperationTimeout(
        () => client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", keys),
        operationTimeoutMs,
        "advisory unlock query",
      );
      logFn("migration_lock_released", {});
    } catch (err) {
      const failure = sanitizePgFailure(err, "MIGRATION_LOCK_RELEASE_FAILED");
      logFn("migration_lock_release_failed", {
        code: failure.code,
      });
      if (strict) releaseError = migrationLifecycleError(failure.code);
    } finally {
      await closePgClient(client, closeTimeoutMs);
    }
    if (releaseError) throw releaseError;
  };
}

async function runMigrations(options = {}) {
  const env = options.env || process.env;
  if (env === process.env) loadDotenv();
  const retryConfig = resolveMigrationRetryConfig(env);
  const signal = options.signal || activeMigrationAbortController?.signal;
  const strict = options.strict === true;
  const sleepFn = options.sleepFn || sleep;
  const logFn = options.logFn || log;
  const runPrismaImpl = options.runPrismaImpl || runPrisma;
  const invokePrisma = (args, prismaOptions = {}) => runPrismaImpl(
    args,
    { ...prismaOptions, env },
  );
  if (env.SKIP_MIGRATIONS === "1") {
    log("skipping prisma migrate deploy (SKIP_MIGRATIONS=1)");
    return 0;
  }
  try {
    requireDirectMigrationDatabaseUrl(env);
  } catch (error) {
    log("migration database configuration rejected", {
      code: error?.code || DIRECT_DATABASE_URL_REQUIRED_CODE,
    });
    return Number.isInteger(error?.exitStatus)
      ? error.exitStatus
      : MIGRATION_CONFIGURATION_EXIT_STATUS;
  }

  let result;
  for (let attempt = 1; attempt <= retryConfig.attempts; attempt++) {
    log("running prisma migrate deploy", { attempt, maxAttempts: retryConfig.attempts });
    result = await invokePrisma(["migrate", "deploy"], { signal });
    if (result.error) {
      log("prisma migrate deploy spawn error", {
        code: result.migrationCode || result.error.code || "MIGRATION_COMMAND_FAILED",
        error: migrationErrorMessage(result.error),
      });
      return prismaCommandExitStatus(result);
    }
    if (result.migrationCode === MIGRATION_COMMAND_ABORTED_CODE) {
      return prismaCommandExitStatus(result);
    }
    if (prismaCommandExitStatus(result) === 0) break;
    if (!isTransientMigrationError(result)) break;
    if (attempt < retryConfig.attempts) {
      log("transient migration error — retrying", { attempt, retryInMs: retryConfig.delayMs });
      await sleepFn(retryConfig.delayMs, signal);
      if (signal?.aborted) return MIGRATION_COMMAND_ABORTED_EXIT_STATUS;
    }
  }

  if (isTerminalMigrationCommandResult(result)) {
    return prismaCommandExitStatus(result);
  }

  if (prismaCommandExitStatus(result) !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (output.includes("P3005")) {
      if (env[MIGRATION_EQUIVALENT_UNBASELINED_ENV] !== "1") {
        logFn("P3005_unbaselined_migration_history", {
          code: "MIGRATION_HISTORY_BASELINE_REQUIRED",
          compatibilityMode: false,
        });
        return prismaCommandExitStatus(result);
      }
      return verifyEquivalentUnbaselinedSchema({
        env,
        signal,
        runPrismaImpl: invokePrisma,
        logFn,
      });
    }
  }
  if (prismaCommandExitStatus(result) !== 0 && env.PRISMA_AUTO_ROLLBACK_SAFE_MIGRATIONS !== "0") {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (output.includes("P3009") && await rollbackSafeFailedMigrations()) {
      log("retrying prisma migrate deploy after safe failed migration rollback");
      const retry = await invokePrisma(["migrate", "deploy"], { signal });
      if (retry.error) {
        log("prisma migrate deploy retry spawn error", {
          code: retry.migrationCode || retry.error.code || "MIGRATION_COMMAND_FAILED",
          error: migrationErrorMessage(retry.error),
        });
        return prismaCommandExitStatus(retry);
      }
      return prismaCommandExitStatus(retry);
    }
    if (!strict && shouldContinueAfterSafeP3009(output)) {
      log("continuing boot despite safe P3009 migration block", {
        failedMigrations: extractP3009MigrationNames(output),
      });
      return 0;
    }
  }

  if (prismaCommandExitStatus(result) !== 0 && isTransientMigrationError(result)) {
    log("migration failed after all retries due to a transient database error", {
      strict,
      degradedBootAvailable: env.MIGRATION_NONFATAL === "1",
    });
  }

  return prismaCommandExitStatus(result);
}

function normalizeShutdownRequest(message, fallbackSignal = "SIGTERM") {
  if (!message || message.type !== SHUTDOWN_MESSAGE_TYPE) return null;
  const requestedCode = Number(message.desiredExitCode);
  return {
    type: SHUTDOWN_MESSAGE_TYPE,
    reason: String(message.reason || `host:${fallbackSignal}`),
    signal: message.signal === "SIGINT" ? "SIGINT" : "SIGTERM",
    desiredExitCode: Number.isInteger(requestedCode) && requestedCode >= 0
      ? Math.min(requestedCode, 255)
      : 1,
  };
}

function forwardShutdownToBackend(child, message) {
  const request = normalizeShutdownRequest(message);
  if (!child || !request) return false;
  let sentIpc = false;
  if (child.connected && typeof child.send === "function") {
    try {
      child.send(request, () => {});
      sentIpc = true;
    } catch {
      sentIpc = false;
    }
  }
  if (!sentIpc) {
    try { child.kill(request.signal); } catch { /* already gone */ }
  }
  return sentIpc;
}

let backendChild = null;
let pendingShutdownRequest = null;
let shutdownHandlersInstalled = false;
let activeMigrationAbortController = null;

function requestBackendShutdown(message) {
  const request = normalizeShutdownRequest(message);
  if (!request) return false;
  pendingShutdownRequest = request;
  if (activeMigrationAbortController && !activeMigrationAbortController.signal.aborted) {
    activeMigrationAbortController.abort(request.signal);
  }
  if (backendChild) forwardShutdownToBackend(backendChild, request);
  return true;
}

function installParentShutdownHandlers() {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  const fromSignal = (signal) => () => {
    requestBackendShutdown({
      type: SHUTDOWN_MESSAGE_TYPE,
      reason: `host:${signal}`,
      signal,
      desiredExitCode: 0,
    });
  };
  process.on("SIGTERM", fromSignal("SIGTERM"));
  process.on("SIGINT", fromSignal("SIGINT"));
  process.on("message", (message) => {
    requestBackendShutdown(message);
  });
}

function finishPendingShutdownBeforeBackend() {
  if (!pendingShutdownRequest || backendChild) return false;
  log("shutdown requested before backend start", {
    reason: pendingShutdownRequest.reason,
    signal: pendingShutdownRequest.signal,
  });
  process.exitCode = pendingShutdownRequest.desiredExitCode;
  if (process.connected && typeof process.disconnect === "function") {
    try { process.disconnect(); } catch { /* parent already disconnected */ }
  }
  return true;
}

function startBackend() {
  log("starting backend (node index.js)");
  const child = spawn(process.execPath, ["index.js"], {
    cwd: BACKEND_DIR,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: process.env,
  });
  backendChild = child;
  if (pendingShutdownRequest) forwardShutdownToBackend(child, pendingShutdownRequest);
  child.on("exit", (code, signal) => {
    backendChild = null;
    log("backend exited", { code, signal });
    process.exit(code ?? (signal ? 1 : 0));
  });
}

// Run DB preflight + acquire the migration advisory lock when applicable.
// Returns an async release() (a no-op when nothing was locked). Normal boot is
// fail-soft here; migration-only mode passes strict=true so a failed preflight
// or lock operation aborts the release command instead of becoming success.
async function maybePreflightAndLock(options = {}) {
  const noop = async () => {};
  const env = options.env || process.env;
  const strict = options.strict === true;
  const phaseFn = options.phaseFn || phase;
  const preflightDatabaseImpl = options.preflightDatabaseImpl || preflightDatabase;
  const acquireMigrationLockImpl = options.acquireMigrationLockImpl || acquireMigrationLock;
  if (env.SKIP_MIGRATIONS === "1") return noop;

  if (env === process.env) loadDotenv();
  const lifecycle = resolveMigrationLifecycleConfig(env);
  let url;
  try {
    url = resolvePrismaDatabaseUrl(env);
  } catch (error) {
    phaseFn("migration_preflight_skipped", {
      reason: "direct_database_url_unavailable",
      code: error?.code || DIRECT_DATABASE_URL_REQUIRED_CODE,
    });
    if (strict) throw error;
    return noop;
  }
  if (!isDirectPostgresUrl(url)) {
    // Accelerate/Data Proxy (prisma://) or no URL: pg can't dial it, so skip
    // fast instead of burning preflight retries that can never succeed.
    phaseFn("migration_preflight_skipped", { reason: url ? "non_direct_postgres_url" : "no_database_url" });
    if (strict) throw migrationLifecycleError("MIGRATION_DIRECT_DATASOURCE_UNAVAILABLE");
    return noop;
  }

  try {
    makePgClientOptions(url, env);
  } catch (error) {
    const code = /^DATABASE_SSL_[A-Z0-9_]+$/.test(String(error?.code || ""))
      ? error.code
      : "DATABASE_SSL_CONFIGURATION_INVALID";
    phaseFn("migration_tls_configuration_rejected", { code });
    if (code !== error?.code) throw databaseSslConfigurationError(code);
    throw error;
  }

  if (env.MIGRATION_PREFLIGHT_DISABLED !== "1") {
    phaseFn("db_preflight_start", { attempts: lifecycle.preflightAttempts });
    const ok = await preflightDatabaseImpl({
      env,
      strict,
      signal: options.signal,
      attempts: lifecycle.preflightAttempts,
      delayMs: lifecycle.preflightDelayMs,
    }).catch((err) => {
      const failure = sanitizePgFailure(err, "MIGRATION_DB_PREFLIGHT_FAILED");
      phaseFn("db_preflight_error", {
        code: failure.code,
      });
      if (strict) throw migrationLifecycleError(failure.code);
      return true; // never block boot on a preflight bug
    });
    if (!ok) {
      phaseFn("db_preflight_giving_up", {
        note: strict ? "migration-only aborting" : "continuing to migrate anyway",
      });
      if (strict) throw migrationLifecycleError("MIGRATION_DB_PREFLIGHT_EXHAUSTED");
    }
  }

  if (env.MIGRATION_ADVISORY_LOCK_DISABLED === "1") return noop;
  phaseFn("migration_lock_start", {});
  return acquireMigrationLockImpl({
    env,
    strict,
    signal: options.signal,
    timeoutMs: lifecycle.lockTimeoutMs,
    pollMs: lifecycle.lockPollMs,
  }).catch((err) => {
    const failure = sanitizePgFailure(err, "MIGRATION_LOCK_FAILED");
    phaseFn("migration_lock_error", {
      code: failure.code,
    });
    if (strict) {
      if (Number.isInteger(err?.exitStatus)) throw err;
      throw migrationLifecycleError(failure.code);
    }
    return noop;
  });
}

/**
 * Ensure Python document sandbox libraries are installed.
 * Runs pip install --user silently in background — never blocks boot.
 * Idempotent: pip skips packages already installed.
 */
function ensureSandboxPythonDeps() {
  const PACKAGES = ['python-docx', 'openpyxl', 'pypdf', 'reportlab', 'pandas'];
  const python = process.env.PYTHON_BIN || 'python3';
  try {
    const child = spawn(
      python,
      ['-m', 'pip', 'install', '--user', '--quiet', '--exists-action=i', ...PACKAGES],
      { stdio: 'ignore', detached: false }
    );
    child.on('error', () => { /* non-critical */ });
  } catch { /* non-critical */ }
}

/**
 * Kill any stale process holding BACKEND_PORT (default 5050) so a workflow
 * restart triggered by adding secrets never hits EADDRINUSE.
 * Uses `fuser -k` which is always available on Linux/Nix. Non-fatal.
 */
async function clearStalePortProcess(options = {}) {
  const env = options.env || process.env;
  const port = env.BACKEND_PORT || env.PORT || '5050';
  try {
    return await runBoundedBootCommand('fuser', ['-k', `${port}/tcp`], {
      env,
      runProcessImpl: options.runProcessImpl,
      timeoutMs: options.timeoutMs ?? resolveBootCommandTimeoutMs(env),
      signal: options.signal,
    });
  } catch {
    return { status: null, error: { code: "BOOT_COMMAND_FAILED" } };
  }
}

/**
 * Seed an admin user if SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD are set.
 * Runs after migrations, before the backend boots. Never throws — a seed
 * failure is logged but never blocks boot.
 */
async function seedAdminIfNeeded() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const rawPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !rawPassword) return;

  phase("seed_admin_check", { email });
  try {
    const { PrismaClient } = require("../node_modules/@prisma/client");
    const bcrypt = require("../node_modules/bcryptjs");
    const directMigrationUrl = resolvePrismaDatabaseUrl();
    const prisma = new PrismaClient({
      datasources: { db: { url: directMigrationUrl } },
    });
    const queryTimeoutMs = resolveMigrationPgTimeoutConfig(process.env).queryTimeoutMs;
    try {
      const existing = await withOperationTimeout(
        () => prisma.user.findUnique({ where: { email } }),
        queryTimeoutMs,
        "admin lookup",
      );
      if (existing) {
        // Update password so the seed password stays in sync on every deploy.
        const hash = await bcrypt.hash(rawPassword, 12);
        await withOperationTimeout(() => prisma.user.update({
          where: { email },
          data: {
            password: hash,
            isAdmin: true,
            isSuperAdmin: true,
          },
        }), queryTimeoutMs, "admin update");
        phase("seed_admin_updated", { email });
      } else {
        const hash = await bcrypt.hash(rawPassword, 12);
        await withOperationTimeout(() => prisma.user.create({
          data: {
            email,
            name: "Admin",
            password: hash,
            isAdmin: true,
            isSuperAdmin: true,
          },
        }), queryTimeoutMs, "admin creation");
        phase("seed_admin_created", { email });
      }
    } finally {
      await withOperationTimeout(
        () => prisma.$disconnect(),
        DEFAULT_MIGRATION_DB_CLOSE_TIMEOUT_MS,
        "Prisma cleanup",
      ).catch(() => {});
    }
  } catch (err) {
    // Never block boot on seed failure.
    phase("seed_admin_error", {
      email,
      code: err?.code || "SEED_ADMIN_FAILED",
      error: migrationErrorMessage(err),
    });
  }
}

/**
 * Log value-free database configuration state and count existing users so we
 * can detect if production points to a wrong or empty database. Logged BEFORE
 * migrations so mismatches remain visible without exposing URL-derived values.
 */
async function logDbSnapshot(label) {
  let url = "";
  try {
    url = resolvePrismaDatabaseUrl();
  } catch (error) {
    phase("db_snapshot_skipped", {
      label,
      code: error?.code || DIRECT_DATABASE_URL_REQUIRED_CODE,
    });
    return { userCount: null, chatCount: null, dbFingerprint: "(unavailable)" };
  }
  // Configuration state only. Host, database name, credentials, query
  // parameters, and every other URL-derived value stay out of boot logs.
  const dbFingerprint = isDirectPostgresUrl(url) ? "direct_postgres_configured" : "unavailable";

  let userCount = null;
  let chatCount = null;
  let client;
  try {
    const { Client } = require("pg");
    client = new Client(makePgClientOptions(url));
    const timeouts = resolveMigrationPgTimeoutConfig(process.env);
    await withOperationTimeout(
      () => client.connect(),
      timeouts.connectionTimeoutMs,
      "snapshot connection",
    );
    try {
      const r = await withOperationTimeout(
        () => client.query('SELECT COUNT(*) FROM "users"'),
        timeouts.queryTimeoutMs,
        "user count query",
      );
      userCount = parseInt(r.rows[0].count, 10);
      const r2 = await withOperationTimeout(
        () => client.query('SELECT COUNT(*) FROM "chats"'),
        timeouts.queryTimeoutMs,
        "chat count query",
      );
      chatCount = parseInt(r2.rows[0].count, 10);
    } catch { /* table may not exist yet on first boot */ }
  } catch { /* pg unavailable */ }
  finally {
    await closePgClient(client);
  }

  phase("db_snapshot", { label, db: dbFingerprint, users: userCount, chats: chatCount });

  // Safety: if we already have users and this is a re-deploy, emit a prominent
  // WARNING so data-loss incidents are immediately visible in logs.
  if (label === "pre_migrate" && userCount !== null && userCount === 0) {
    phase("db_snapshot_warn", {
      label,
      warning: "ZERO users found before migrations — database may be empty or wrong DATABASE_URL in production",
      db: dbFingerprint,
    });
  }
  return { userCount, chatCount, dbFingerprint };
}

function shouldAllowNonfatalMigrationFailure(status, env = process.env) {
  return (
    env.MIGRATION_NONFATAL === "1"
    && status !== MIGRATION_CONFIGURATION_EXIT_STATUS
    && ![
      MIGRATION_COMMAND_TIMEOUT_EXIT_STATUS,
      MIGRATION_COMMAND_ABORTED_EXIT_STATUS,
      MIGRATION_COMMAND_OUTPUT_LIMIT_EXIT_STATUS,
      MIGRATION_PROCESS_TREE_NOT_TERMINATED_EXIT_STATUS,
    ].includes(status)
  );
}

async function runMigrationOnly(options = {}) {
  const env = options.env || process.env;
  const {
    installSignalHandlers = true,
    loadEnvFn = loadDotenv,
    runGenerateImpl = ({ signal: generateSignal, env: generateEnv }) => runPrisma(
      ["generate", "--schema=prisma/schema.prisma"],
      { signal: generateSignal, env: generateEnv },
    ),
    maybePreflightAndLockImpl = maybePreflightAndLock,
    runMigrationsImpl = runMigrations,
    phaseFn = phase,
    signal,
  } = options;
  if (installSignalHandlers) installParentShutdownHandlers();
  loadEnvFn();
  if (env.SKIP_MIGRATIONS === "1") {
    phaseFn("migration_only_rejected", {
      status: MIGRATION_CONFIGURATION_EXIT_STATUS,
      code: "MIGRATION_ONLY_SKIP_FORBIDDEN",
    });
    return MIGRATION_CONFIGURATION_EXIT_STATUS;
  }

  const previousController = activeMigrationAbortController;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason || "external_abort");
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  activeMigrationAbortController = controller;
  if (pendingShutdownRequest && !controller.signal.aborted) {
    controller.abort(pendingShutdownRequest.signal);
  }

  let release = async () => {};
  let status = 1;
  try {
    phaseFn("migration_only_start", {});
    phaseFn("generate_start", { mode: "migration_only" });
    try {
      const generateResult = await runGenerateImpl({ signal: controller.signal, env });
      status = Number.isInteger(generateResult)
        ? generateResult
        : prismaCommandExitStatus(generateResult);
    } catch (error) {
      status = Number.isInteger(error?.exitStatus)
        ? error.exitStatus
        : MIGRATION_CONFIGURATION_EXIT_STATUS;
      phaseFn("generate_failed", {
        mode: "migration_only",
        status,
        code: error?.code || "PRISMA_GENERATE_FAILED",
      });
    }
    phaseFn("generate_done", { mode: "migration_only", status });
    if (status === 0) {
      release = await maybePreflightAndLockImpl({
        env,
        signal: controller.signal,
        strict: true,
      });
      phaseFn("migrate_start", { mode: "migration_only" });
      status = await runMigrationsImpl({
        env,
        signal: controller.signal,
        strict: true,
      });
      phaseFn("migrate_done", { mode: "migration_only", status });
    }
  } catch (error) {
    status = Number.isInteger(error?.exitStatus)
      ? error.exitStatus
      : MIGRATION_LIFECYCLE_EXIT_STATUS;
    phaseFn("migration_only_failed", {
      status,
      code: error?.code || "MIGRATION_ONLY_FAILED",
    });
  } finally {
    try {
      await Promise.resolve(release());
    } catch (error) {
      if (status === 0) {
        status = Number.isInteger(error?.exitStatus)
          ? error.exitStatus
          : MIGRATION_LIFECYCLE_EXIT_STATUS;
      }
      phaseFn("migration_lock_release_failed", {
        mode: "migration_only",
        status,
        code: error?.code || "MIGRATION_LOCK_RELEASE_FAILED",
      });
    }
    signal?.removeEventListener("abort", forwardAbort);
    activeMigrationAbortController = previousController;
    phaseFn("migration_only_done", { status });
  }
  return status;
}

async function main() {
  installParentShutdownHandlers();
  loadDotenv();
  phase("boot_start", { skipMigrations: process.env.SKIP_MIGRATIONS === "1" });
  const previousController = activeMigrationAbortController;
  const controller = new AbortController();
  activeMigrationAbortController = controller;
  if (pendingShutdownRequest) controller.abort(pendingShutdownRequest.signal);
  await clearStalePortProcess({ signal: controller.signal });
  ensureSandboxPythonDeps();

  // Log DB fingerprint + user count BEFORE migrations to detect wrong-DB issues.
  const pre = await logDbSnapshot("pre_migrate");
  let migrationStatus;
  let release = async () => {};
  try {
    if (finishPendingShutdownBeforeBackend()) return;
    release = await maybePreflightAndLock({ signal: controller.signal });
    if (finishPendingShutdownBeforeBackend()) return;
    phase("migrate_start", {});
    migrationStatus = await runMigrations();
    phase("migrate_done", { status: migrationStatus });
  } finally {
    await release().catch(() => {});
    activeMigrationAbortController = previousController;
  }
  if (finishPendingShutdownBeforeBackend()) return;

  if (migrationStatus !== 0) {
    // Opt-in safety valve (default OFF — byte-identical to before when unset):
    // when MIGRATION_NONFATAL=1, boot the backend anyway so it can still bind
    // its port and serve traffic in a degraded state instead of leaving the
    // whole instance down (which surfaces as ECONNREFUSED on every /api call).
    // The operator must still fix the underlying DB/migration condition.
    // Configuration failures remain fatal so a remote runtime URL is never
    // treated as a direct migration datasource.
    if (shouldAllowNonfatalMigrationFailure(migrationStatus, process.env)) {
      log("migrations failed but MIGRATION_NONFATAL=1 — booting anyway (degraded)", { status: migrationStatus });
      phase("backend_start", { degraded: true });
      if (finishPendingShutdownBeforeBackend()) return;
      startBackend();
      return;
    }
    log("migrations failed — aborting boot", { status: migrationStatus });
    phase("boot_aborted", { status: migrationStatus });
    process.exit(migrationStatus);
  }

  // Log user count AFTER migrations — a drop vs pre-count means data was lost.
  const post = await logDbSnapshot("post_migrate");
  if (pre.userCount !== null && post.userCount !== null && post.userCount < pre.userCount) {
    phase("db_snapshot_data_loss", {
      warning: "USER COUNT DROPPED after migrations!",
      before: pre.userCount,
      after: post.userCount,
      lost: pre.userCount - post.userCount,
      db: post.dbFingerprint,
    });
  }

  // Seed the admin user into the production DB if env vars are configured.
  await seedAdminIfNeeded();
  if (finishPendingShutdownBeforeBackend()) return;

  phase("backend_start", { degraded: false });
  startBackend();
}

function isMigrationOnlyMode(argv = process.argv.slice(2)) {
  return argv.includes("--migrate-only");
}

async function cli(argv = process.argv.slice(2)) {
  if (isMigrationOnlyMode(argv)) {
    const status = await runMigrationOnly();
    if (!finishPendingShutdownBeforeBackend()) process.exitCode = status;
    return;
  }
  await main();
}

if (require.main === module) {
  cli().catch((err) => {
    log("fatal boot wrapper error", {
      code: err?.code || "BOOT_WRAPPER_FAILED",
      error: migrationErrorMessage(err),
      stack: redactDatabaseUrls(err?.stack || "", process.env),
    });
    process.exit(1);
  });
}

module.exports = {
  extractP3009MigrationNames,
  isSafeAutoRollbackMigration,
  isMigrationAutoRollbackSafe,
  migrationSqlIsIdempotentAdditive,
  makePgClientOptions,
  resolveDatabaseSslCa,
  resolvePrismaDatabaseUrl,
  synchronizePrismaDatabaseUrl,
  shouldContinueAfterSafeP3009,
  isDirectPostgresUrl,
  computeAdvisoryLockKeys,
  preflightDatabase,
  defaultPreflightConnect,
  acquireMigrationLock,
  maybePreflightAndLock,
  forwardShutdownToBackend,
  runPrisma,
  isTerminalMigrationCommandResult,
  isTransientMigrationError,
  runBoundedBootCommand,
  pipeResult,
  prismaCommandExitStatus,
  resolveMigrationCommandTimeoutMs,
  resolveBootCommandTimeoutMs,
  resolveMigrationPgTimeoutConfig,
  resolveMigrationRetryConfig,
  resolveMigrationLifecycleConfig,
  closePgClient,
  runMigrations,
  runMigrationOnly,
  verifyEquivalentUnbaselinedSchema,
  isMigrationOnlyMode,
  clearStalePortProcess,
  sanitizePgFailure,
  shouldAllowNonfatalMigrationFailure,
  DIRECT_DATABASE_URL_REQUIRED_CODE,
  MIGRATION_COMMAND_TIMEOUT_CODE,
  MIGRATION_COMMAND_ABORTED_CODE,
  MIGRATION_COMMAND_OUTPUT_LIMIT_CODE,
  MIGRATION_PROCESS_TREE_NOT_TERMINATED_CODE,
  MIGRATION_DB_OPERATION_TIMEOUT_CODE,
};
