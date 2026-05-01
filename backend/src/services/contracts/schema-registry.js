'use strict';

const { z } = require('zod');
const { zodToJsonSchema } = require('zod-to-json-schema');

const CONTRACT_REGISTRY_VERSION = 'sira-contracts-2026-05';

const strictEmptyObject = z.object({}).strict();
const looseObject = z.object({}).passthrough();
const errorResponseSchema = z.object({
  error: z.union([z.string(), z.array(z.any())]).optional(),
  errors: z.array(z.any()).optional(),
  code: z.string().optional(),
}).passthrough();

const healthCheckResponseSchema = z.object({
  status: z.string(),
  checks: z.array(z.any()),
}).passthrough();

const githubRepositoryQuerySchema = z.object({
  repo: z.string().trim().min(1).max(240),
  branch: z.string().trim().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
}).strict();

const githubRepositoryFilesQuerySchema = z.object({
  repo: z.string().trim().min(1).max(240),
  branch: z.string().trim().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(120).optional(),
  maxBytes: z.coerce.number().int().min(1000).max(120000).optional(),
}).strict();

const githubRepositoryIngestBodySchema = z.object({
  repo: z.string().trim().min(1).max(240),
  branch: z.string().trim().min(1).max(160).optional(),
  collection: z.string().trim().min(1).max(180).optional(),
  limit: z.number().int().min(1).max(120).optional(),
  maxBytes: z.number().int().min(1000).max(120000).optional(),
}).strict();

const githubRepositoryRetrieveBodySchema = z.object({
  query: z.string().trim().min(1).max(2000),
  repo: z.string().trim().min(1).max(240).optional(),
  branch: z.string().trim().min(1).max(160).optional(),
  collection: z.string().trim().min(1).max(180).optional(),
  k: z.number().int().min(1).max(12).optional(),
}).strict();

const ragDocSchema = z.object({
  text: z.string().min(1),
  title: z.string().min(1).max(500).optional(),
  source: z.string().min(1).max(1000).optional(),
}).passthrough();

const ragIngestBodySchema = z.object({
  docs: z.array(ragDocSchema).min(1),
  collection: z.string().min(1).max(64).optional(),
}).strict();

const ragRetrieveBodySchema = z.object({
  query: z.string().min(2),
  collection: z.string().optional(),
  k: z.number().int().min(1).max(20).optional(),
  useExpansion: z.boolean().optional(),
  useMMR: z.boolean().optional(),
  mmrLambda: z.number().min(0).max(1).optional(),
  rerank: z.boolean().optional(),
  useHybrid: z.boolean().optional(),
  rrfK: z.number().int().min(1).max(200).optional(),
  useGraph: z.boolean().optional(),
  graphBeamSize: z.number().int().min(1).max(16).optional(),
  graphLength: z.number().int().min(1).max(8).optional(),
  graphGamma: z.number().int().min(1).max(10).optional(),
  graphProximalN: z.number().int().min(1).max(20).optional(),
  sessionId: z.string().max(128).optional(),
  includeDiagnostics: z.boolean().optional(),
  includeTrace: z.boolean().optional(),
}).strict();

const ragCodeFileSchema = z.object({
  filename: z.string().min(1).max(1000),
  content: z.string().min(1),
  language: z.string().min(1).max(80).optional(),
}).passthrough();

const ragIngestCodeBodySchema = z.object({
  files: z.array(ragCodeFileSchema).min(1),
  collection: z.string().min(1).max(64).optional(),
}).strict();

const ragStatsQuerySchema = z.object({
  collection: z.string().optional(),
}).strict();

const agentTaskBodySchema = z.object({
  goal: z.string().trim().min(3).max(4000),
  displayGoal: z.string().trim().min(3).max(4000).optional(),
  systemContract: z.string().trim().max(4000).optional(),
  files: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  chatId: z.string().optional(),
  model: z.string().optional(),
  maxSteps: z.number().int().min(2).max(120).optional(),
  maxRuntimeMs: z.number().int().min(60000).max(7200000).optional(),
}).strict();

const agentTaskParamsSchema = z.object({
  taskId: z.string().trim().min(1).max(120),
}).strict();

const fileUploadBodySchema = z.object({
  files: z.array(z.string().describe('multipart/form-data binary file part')).min(1).max(10),
}).strict();

const queueBoardStatusResponseSchema = z.object({
  ok: z.boolean(),
  queueBoard: z.object({
    enabled: z.boolean(),
    redisUrlConfigured: z.boolean(),
    queue: z.string(),
    basePath: z.string(),
    status: z.enum(['disabled', 'ready', 'degraded']),
    reason: z.string().optional(),
    counts: z.union([z.record(z.any()), z.null()]).optional(),
  }).passthrough(),
}).passthrough();

const agentTaskStatusResponseSchema = z.object({
  ok: z.boolean(),
  taskId: z.string(),
  status: z.string(),
}).passthrough();

const mcpToolContracts = Object.freeze([
  {
    name: 'github.codex.status',
    description: 'Read sanitized GitHub Codex connector status and resilience capabilities.',
    input: strictEmptyObject,
    output: z.object({
      github: looseObject,
      tenant: z.object({ id: z.string() }).passthrough(),
    }).passthrough(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'github.codex.repository_context',
    description: 'Read repository metadata, pull requests, issues, Actions summaries and README context through the backend GitHub Codex connector.',
    input: z.object({
      repository: z.string().min(1).max(240),
      branch: z.string().min(1).max(160).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }).strict(),
    output: z.object({ context: looseObject }).passthrough(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'rag.retrieve',
    description: 'Retrieve read-only snippets from the authenticated user private RAG collection.',
    input: z.object({
      collection: z.string().min(1).max(180),
      query: z.string().min(1).max(2000),
      k: z.number().int().min(1).max(12).optional(),
    }).strict(),
    output: z.object({ hits: z.array(z.any()) }).passthrough(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'project.memory.list',
    description: 'List durable project memory facts for a project owned by the authenticated user.',
    input: z.object({
      projectId: z.string().min(1).max(120),
      limit: z.number().int().min(1).max(100).optional(),
    }).strict(),
    output: z.object({ memory: z.array(z.any()) }).passthrough(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'document.preview',
    description: 'Read a bounded Markdown preview of a project document owned by the authenticated user.',
    input: z.object({
      projectId: z.string().min(1).max(120),
      docId: z.string().min(1).max(120),
      maxChars: z.number().int().min(100).max(12000).optional(),
    }).strict(),
    output: z.object({
      document: z.object({
        id: z.string(),
        title: z.string().nullable().optional(),
        updatedAt: z.string().nullable().optional(),
        meta: z.any().nullable().optional(),
        preview: z.string(),
        truncated: z.boolean(),
      }).passthrough(),
    }).passthrough(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]);

const routeContracts = Object.freeze([
  {
    id: 'health.live',
    method: 'get',
    path: '/health/live',
    tags: ['Health'],
    summary: 'Read process liveness without external dependencies.',
    authRequired: false,
    responses: { 200: healthCheckResponseSchema },
  },
  {
    id: 'github.codex.status',
    method: 'get',
    path: '/api/codex/github/status',
    tags: ['GitHub Codex'],
    summary: 'Read sanitized GitHub Codex connector status.',
    authRequired: true,
    responses: { 200: z.object({ github: looseObject }).passthrough() },
  },
  {
    id: 'github.codex.repo',
    method: 'get',
    path: '/api/codex/github/repo',
    tags: ['GitHub Codex'],
    summary: 'Read GitHub repository context.',
    authRequired: true,
    query: githubRepositoryQuerySchema,
    responses: { 200: z.object({ context: looseObject }).passthrough(), 400: errorResponseSchema, 429: errorResponseSchema, 500: errorResponseSchema },
  },
  {
    id: 'github.codex.files',
    method: 'get',
    path: '/api/codex/github/files',
    tags: ['GitHub Codex'],
    summary: 'List bounded safe files from a GitHub repository.',
    authRequired: true,
    query: githubRepositoryFilesQuerySchema,
    responses: { 200: z.object({ fileSet: looseObject }).passthrough(), 400: errorResponseSchema, 429: errorResponseSchema, 500: errorResponseSchema },
  },
  {
    id: 'github.codex.ingest',
    method: 'post',
    path: '/api/codex/github/ingest',
    tags: ['GitHub Codex'],
    summary: 'Index selected GitHub repository files into private RAG.',
    authRequired: true,
    body: githubRepositoryIngestBodySchema,
    responses: { 200: looseObject, 400: errorResponseSchema, 500: errorResponseSchema },
  },
  {
    id: 'github.codex.retrieve',
    method: 'post',
    path: '/api/codex/github/retrieve',
    tags: ['GitHub Codex'],
    summary: 'Retrieve snippets from a GitHub repository RAG collection.',
    authRequired: true,
    body: githubRepositoryRetrieveBodySchema,
    responses: { 200: z.object({ ok: z.boolean(), collection: z.string(), query: z.string(), hits: z.array(z.any()) }).passthrough(), 400: errorResponseSchema },
  },
  {
    id: 'agent.task.create',
    method: 'post',
    path: '/api/agent/task',
    tags: ['Agent Tasks'],
    summary: 'Create or queue an agent task.',
    authRequired: true,
    body: agentTaskBodySchema,
    responses: { 200: looseObject, 400: errorResponseSchema, 500: errorResponseSchema, 503: errorResponseSchema },
  },
  {
    id: 'agent.task.status',
    method: 'get',
    path: '/api/agent/task/{taskId}',
    tags: ['Agent Tasks'],
    summary: 'Read a durable agent task snapshot for the authenticated owner.',
    authRequired: true,
    params: agentTaskParamsSchema,
    responses: { 200: agentTaskStatusResponseSchema, 404: errorResponseSchema },
  },
  {
    id: 'files.upload',
    method: 'post',
    path: '/api/files/upload',
    tags: ['Files'],
    summary: 'Upload up to ten files for extraction, document intelligence and RAG indexing.',
    authRequired: true,
    body: fileUploadBodySchema,
    requestContentType: 'multipart/form-data',
    responses: { 200: looseObject, 400: errorResponseSchema },
  },
  {
    id: 'admin.queues.status',
    method: 'get',
    path: '/api/admin/queues/status',
    tags: ['Admin Queues'],
    summary: 'Read BullMQ admin queue dashboard readiness.',
    authRequired: true,
    responses: { 200: queueBoardStatusResponseSchema, 403: errorResponseSchema, 503: queueBoardStatusResponseSchema },
  },
  {
    id: 'rag.ingest',
    method: 'post',
    path: '/api/rag/ingest',
    tags: ['RAG'],
    summary: 'Ingest text documents into a private RAG collection.',
    authRequired: true,
    body: ragIngestBodySchema,
    responses: { 200: looseObject, 400: errorResponseSchema },
  },
  {
    id: 'rag.retrieve',
    method: 'post',
    path: '/api/rag/retrieve',
    tags: ['RAG'],
    summary: 'Retrieve top-K chunks from a private RAG collection.',
    authRequired: true,
    body: ragRetrieveBodySchema,
    responses: { 200: looseObject, 400: errorResponseSchema },
  },
  {
    id: 'rag.ingest_code',
    method: 'post',
    path: '/api/rag/ingest-code',
    tags: ['RAG'],
    summary: 'Ingest code files into a private RAG collection.',
    authRequired: true,
    body: ragIngestCodeBodySchema,
    responses: { 200: looseObject, 400: errorResponseSchema },
  },
  {
    id: 'rag.stats',
    method: 'get',
    path: '/api/rag/stats',
    tags: ['RAG'],
    summary: 'Read RAG collection statistics.',
    authRequired: true,
    query: ragStatsQuerySchema,
    responses: { 200: looseObject },
  },
]);

function stripJsonSchemaMeta(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const copy = JSON.parse(JSON.stringify(schema));
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    delete node.$schema;
    if (node.nullable === true) {
      if (Array.isArray(node.enum) && node.enum.length === 1 && node.enum[0] === 'null') {
        delete node.enum;
        node.type = 'null';
      } else if (typeof node.type === 'string') {
        node.type = [node.type, 'null'];
      }
      delete node.nullable;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else {
        visit(value);
      }
    }
  }
  visit(copy);
  return copy;
}

function toJsonSchema(schema) {
  return stripJsonSchemaMeta(zodToJsonSchema(schema, { $refStrategy: 'none', target: 'openApi3' }));
}

function getMcpToolContract(name) {
  return mcpToolContracts.find((contract) => contract.name === name) || null;
}

function listMcpToolContractNames() {
  return mcpToolContracts.map((contract) => contract.name);
}

function getMcpToolJsonSchema(name, direction = 'input') {
  const contract = getMcpToolContract(name);
  if (!contract) return null;
  return toJsonSchema(direction === 'output' ? contract.output : contract.input);
}

function serializeToolContract(contract) {
  return {
    name: contract.name,
    description: contract.description,
    inputSchema: toJsonSchema(contract.input),
    outputSchema: toJsonSchema(contract.output),
    annotations: { ...contract.annotations },
  };
}

function serializeRouteContract(contract) {
  return {
    id: contract.id,
    method: contract.method.toUpperCase(),
    path: contract.path,
    tags: contract.tags.slice(),
    summary: contract.summary,
    authRequired: Boolean(contract.authRequired),
    requestContentType: contract.requestContentType || (contract.body ? 'application/json' : null),
    schemas: {
      ...(contract.params ? { params: toJsonSchema(contract.params) } : {}),
      ...(contract.query ? { query: toJsonSchema(contract.query) } : {}),
      ...(contract.body ? { body: toJsonSchema(contract.body) } : {}),
      responses: Object.fromEntries(
        Object.entries(contract.responses || {}).map(([status, schema]) => [status, toJsonSchema(schema)]),
      ),
    },
  };
}

function schemaPropertiesAsParameters(schema, location) {
  if (!schema) return [];
  const json = toJsonSchema(schema);
  const required = new Set(json.required || []);
  return Object.entries(json.properties || {}).map(([name, property]) => ({
    name,
    in: location,
    required: required.has(name),
    schema: property,
  }));
}

function buildRequestBody(contract) {
  if (!contract.body) return undefined;
  const contentType = contract.requestContentType || 'application/json';
  const schema = toJsonSchema(contract.body);
  if (contentType === 'multipart/form-data' && schema.properties?.files) {
    schema.properties.files = {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: { type: 'string', format: 'binary' },
    };
  }
  return {
    required: true,
    content: {
      [contentType]: { schema },
    },
  };
}

function buildOpenApiSpec({ title = 'SiraGPT API Contracts', version = CONTRACT_REGISTRY_VERSION } = {}) {
  const paths = {};
  for (const contract of routeContracts) {
    paths[contract.path] = paths[contract.path] || {};
    const operation = {
      operationId: contract.id,
      tags: contract.tags,
      summary: contract.summary,
      security: contract.authRequired ? [{ bearerAuth: [] }] : [],
      parameters: [
        ...schemaPropertiesAsParameters(contract.params, 'path'),
        ...schemaPropertiesAsParameters(contract.query, 'query'),
      ],
      responses: Object.fromEntries(
        Object.entries(contract.responses || { 200: looseObject }).map(([status, schema]) => [
          String(status),
          {
            description: status === '200' ? 'OK' : 'Error response',
            content: {
              'application/json': {
                schema: toJsonSchema(schema),
              },
            },
          },
        ]),
      ),
    };
    const requestBody = buildRequestBody(contract);
    if (requestBody) operation.requestBody = requestBody;
    paths[contract.path][contract.method] = operation;
  }
  return {
    openapi: '3.1.0',
    info: {
      title,
      version,
    },
    servers: [{ url: '/' }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    'x-siragpt-contract-registry-version': CONTRACT_REGISTRY_VERSION,
  };
}

function buildJsonSchemaRegistry() {
  return {
    version: CONTRACT_REGISTRY_VERSION,
    protocol: {
      jsonSchemaGenerator: 'zod-to-json-schema',
      zodMajor: 3,
      openApiGeneratedInternally: true,
      zodToOpenApiSkipped: '@asteasolutions/zod-to-openapi@8.5.0 requires zod@^4; backend remains on zod@3 for compatibility',
    },
    tools: Object.fromEntries(mcpToolContracts.map((contract) => [contract.name, serializeToolContract(contract)])),
    routes: Object.fromEntries(routeContracts.map((contract) => [contract.id, serializeRouteContract(contract)])),
  };
}

function listRouteContracts() {
  return routeContracts.map(serializeRouteContract);
}

function listToolContracts() {
  return mcpToolContracts.map(serializeToolContract);
}

module.exports = {
  CONTRACT_REGISTRY_VERSION,
  ROUTE_CONTRACTS: routeContracts,
  MCP_TOOL_CONTRACTS: mcpToolContracts,
  buildJsonSchemaRegistry,
  buildOpenApiSpec,
  getMcpToolContract,
  getMcpToolJsonSchema,
  listMcpToolContractNames,
  listRouteContracts,
  listToolContracts,
  toJsonSchema,
};
