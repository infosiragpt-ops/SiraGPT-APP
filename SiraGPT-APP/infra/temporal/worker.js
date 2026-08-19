'use strict';

/**
 * Standalone Temporal worker entry point.
 *
 * Deployed to a *separate* Replit Autoscale Repl ("Sira Temporal
 * Worker"), NOT inside the main backend. This process:
 *   1. Connects to Temporal Cloud using the same env contract as
 *      `backend/src/services/agents/temporal/temporal-client.js`.
 *   2. Registers the workflow + activity bundle.
 *   3. Polls the `sira-agent-tasks` task queue forever.
 *
 * Required env (all served from Replit Secrets):
 *   TEMPORAL_ADDRESS         → e.g. sira-prod.tmprl.cloud:7233
 *   TEMPORAL_NAMESPACE       → e.g. sira-prod
 *   TEMPORAL_TASK_QUEUE      → e.g. sira-agent-tasks
 *   TEMPORAL_CLIENT_CERT     → PEM (or base64-encoded PEM)
 *   TEMPORAL_CLIENT_KEY      → PEM (or base64-encoded PEM)
 *   …or TEMPORAL_API_KEY     → if using API-key auth instead of mTLS
 *
 * Plus everything the agent runner itself needs (DATABASE_URL,
 * OPENAI_API_KEY, etc.) because the activity calls into
 * `agent-task-runner.js` which spins up real provider clients.
 *
 * Boot smoke test (without a real Temporal Cloud account):
 *   TEMPORAL_ADDRESS= node infra/temporal/worker.js
 *   → prints "[temporal-worker] disabled: no_address" and exits 0.
 */

async function main() {
  const {
    getTemporalConfig,
  } = require('../../backend/src/services/agents/temporal/temporal-client');
  const cfg = getTemporalConfig();
  if (!cfg.enabled) {
    console.warn(`[temporal-worker] disabled: ${cfg.reason}`);
    process.exit(0);
  }

  // Lazy-require the SDK only when the config is healthy so the smoke
  // test above doesn't need the package installed.
  // eslint-disable-next-line global-require
  const { Worker, NativeConnection } = require('@temporalio/worker');

  const connection = await NativeConnection.connect({
    address: cfg.address,
    // Temporal Cloud always requires TLS. With mTLS we send the client
    // cert pair; with API-key auth we still need TLS on (just without
    // a client cert), so `true` is the correct fallback — `undefined`
    // disables TLS entirely and the cloud endpoint rejects the
    // connection.
    tls: cfg.clientCert
      ? { clientCertPair: { crt: Buffer.from(cfg.clientCert), key: Buffer.from(cfg.clientKey) } }
      : true,
    apiKey: cfg.apiKey || undefined,
  });

  const worker = await Worker.create({
    connection,
    namespace: cfg.namespace,
    taskQueue: cfg.taskQueue,
    workflowsPath: require.resolve(
      '../../backend/src/services/agents/temporal/workflows/agent-task.workflow'
    ),
    activities: require(
      '../../backend/src/services/agents/temporal/activities/agent-task.activity'
    ),
  });

  console.log(
    `[temporal-worker] ready namespace=${cfg.namespace} taskQueue=${cfg.taskQueue} address=${cfg.address}`
  );

  // Graceful shutdown — flush in-flight workflow tasks before exit so we
  // don't lose progress on SIGTERM during an Autoscale redeploy.
  const shutdown = async (signal) => {
    console.log(`[temporal-worker] received ${signal}, shutting down…`);
    worker.shutdown();
    try { await connection.close(); } catch (_err) { /* noop */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await worker.run();
}

main().catch((err) => {
  console.error('[temporal-worker] fatal:', err && err.stack || err);
  process.exit(1);
});
