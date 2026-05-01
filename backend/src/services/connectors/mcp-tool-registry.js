'use strict';

const {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { createGitHubCodexConnector } = require('../github-codex-connector');
const ragService = require('../rag-service');
const projectMemory = require('../project-memory');

const MCP_HUB_VERSION = 'sira-mcp-hub-2026-05';
const DEFAULT_MAX_PREVIEW_CHARS = 4000;
const MAX_PREVIEW_CHARS = 12000;
const DEFAULT_MCP_TOOLS = Object.freeze([
  'github.codex.status',
  'github.codex.repository_context',
  'rag.retrieve',
  'project.memory.list',
  'document.preview',
]);

class McpToolRegistryError extends Error {
  constructor(code, status, message, details = {}) {
    super(message);
    this.name = 'McpToolRegistryError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function resolveMcpToolAllowlist(env = process.env) {
  const raw = trimString(env.MCP_CONNECTOR_ALLOWLIST || env.SIRAGPT_MCP_TOOL_ALLOWLIST);
  if (!raw) return DEFAULT_MCP_TOOLS.slice();
  const allowed = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => DEFAULT_MCP_TOOLS.includes(item));
  return Array.from(new Set(allowed));
}

function normalizeMcpToolList(tools = []) {
  if (!Array.isArray(tools)) return [];
  return Array.from(new Set(tools.filter((item) => DEFAULT_MCP_TOOLS.includes(item))));
}

function resolveEffectiveMcpToolAllowlist(context = {}, env = process.env) {
  const configured = resolveMcpToolAllowlist(env);
  if (!Array.isArray(context.allowlist)) return configured;
  const requested = normalizeMcpToolList(context.allowlist);
  return configured.filter((name) => requested.includes(name));
}

function createMcpTenantScope(user = {}) {
  const userId = trimString(user.id || user.userId);
  const tenantId = trimString(user.tenantId || user.organizationId || user.orgId || userId);
  return {
    userId,
    tenantId,
  };
}

function createMcpRequestContext(reqOrContext = {}, env = process.env) {
  const user = reqOrContext.user || reqOrContext;
  const scope = reqOrContext.tenantScope || createMcpTenantScope(user);
  return {
    user,
    tenantScope: scope,
    allowlist: Array.isArray(reqOrContext.allowlist)
      ? reqOrContext.allowlist
      : resolveMcpToolAllowlist(env),
  };
}

function sanitizeJson(value) {
  return JSON.parse(JSON.stringify(value ?? null, (_key, nested) => {
    if (typeof nested === 'bigint') return nested.toString();
    if (nested instanceof Date) return nested.toISOString();
    return nested;
  }));
}

function textResult(payload, { isError = false } = {}) {
  const structuredContent = sanitizeJson(payload);
  const result = {
    content: [
      {
        type: 'text',
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
  return assertMcpSchema(CallToolResultSchema, result, 'invalid_mcp_call_result');
}

function assertMcpSchema(schema, value, code) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new McpToolRegistryError(
      code,
      500,
      'Internal MCP registry produced an invalid protocol payload',
      { issues: parsed.error?.issues || [] },
    );
  }
  return parsed.data;
}

function assertNoBrowserSecrets(input, path = 'arguments') {
  if (!input || typeof input !== 'object') return;
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (
      lower.includes('token')
      || lower.includes('secret')
      || lower === 'apikey'
      || lower === 'api_key'
      || lower === 'authorization'
      || lower === 'password'
    ) {
      throw new McpToolRegistryError(
        'browser_secret_rejected',
        400,
        'MCP tool calls must not include browser-provided tokens or secrets',
        { field: `${path}.${key}` },
      );
    }
    if (value && typeof value === 'object') {
      assertNoBrowserSecrets(value, `${path}.${key}`);
    }
  }
}

function assertAuthorized(toolName, context = {}) {
  const userId = trimString(context.tenantScope?.userId || context.user?.id || context.user?.userId);
  const tenantId = trimString(context.tenantScope?.tenantId);
  if (!userId) {
    throw new McpToolRegistryError('mcp_auth_required', 401, 'Authenticated user context is required');
  }
  if (!tenantId) {
    throw new McpToolRegistryError('mcp_tenant_scope_required', 403, 'Tenant scope is required for MCP tool access');
  }
  const allowlist = Array.isArray(context.allowlist) ? context.allowlist : [];
  if (!allowlist.includes(toolName)) {
    throw new McpToolRegistryError('mcp_tool_not_allowed', 403, 'MCP tool is not in the configured allowlist', {
      tool: toolName,
    });
  }
  return { userId, tenantId };
}

function assertObjectArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  return args;
}

async function assertProjectOwner(prisma, userId, projectId) {
  const id = trimString(projectId);
  if (!id) {
    throw new McpToolRegistryError('invalid_mcp_arguments', 400, 'projectId is required');
  }
  if (!prisma?.project?.findFirst) {
    throw new McpToolRegistryError('mcp_dependency_unavailable', 503, 'Project storage is unavailable');
  }
  const project = await prisma.project.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!project) {
    throw new McpToolRegistryError('mcp_project_not_found', 404, 'Project was not found for this tenant scope');
  }
  return project;
}

function buildTool(name, description, inputSchema, outputSchema = { type: 'object', additionalProperties: true }) {
  return assertMcpSchema(ToolSchema, {
    name,
    description,
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: name.startsWith('github.'),
    },
    _meta: {
      'siragpt.io/mcpHubVersion': MCP_HUB_VERSION,
      'siragpt.io/approvedInternalTool': true,
    },
  }, 'invalid_mcp_tool_manifest');
}

function buildApprovedTools() {
  return {
    'github.codex.status': {
      tool: buildTool(
        'github.codex.status',
        'Read sanitized GitHub Codex connector status and resilience capabilities.',
        { type: 'object', additionalProperties: false },
      ),
      handler: async (_args, context, deps) => {
        const connector = deps.createGitHubConnector();
        return textResult({ github: connector.getStatus(), tenant: { id: context.tenantScope.tenantId } });
      },
    },
    'github.codex.repository_context': {
      tool: buildTool(
        'github.codex.repository_context',
        'Read repository metadata, pull requests, issues, Actions summaries and README context through the backend GitHub Codex connector.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['repository'],
          properties: {
            repository: { type: 'string', minLength: 1, maxLength: 240 },
            branch: { type: 'string', minLength: 1, maxLength: 160 },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
          },
        },
      ),
      handler: async (args, _context, deps) => {
        const repository = trimString(args.repository);
        if (!repository) {
          throw new McpToolRegistryError('invalid_mcp_arguments', 400, 'repository is required');
        }
        const connector = deps.createGitHubConnector();
        const context = await connector.getRepositoryContext({
          repository,
          branch: trimString(args.branch) || undefined,
          limit: clampInt(args.limit, 10, 1, 20),
        });
        return textResult({ context });
      },
    },
    'rag.retrieve': {
      tool: buildTool(
        'rag.retrieve',
        'Retrieve read-only snippets from the authenticated user private RAG collection.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['collection', 'query'],
          properties: {
            collection: { type: 'string', minLength: 1, maxLength: 180 },
            query: { type: 'string', minLength: 1, maxLength: 2000 },
            k: { type: 'integer', minimum: 1, maximum: 12 },
          },
        },
      ),
      handler: async (args, context, deps) => {
        const collection = trimString(args.collection);
        const query = trimString(args.query);
        if (!collection || !query) {
          throw new McpToolRegistryError('invalid_mcp_arguments', 400, 'collection and query are required');
        }
        const hits = await deps.rag.retrieve(
          context.tenantScope.userId,
          collection,
          query,
          clampInt(args.k, 5, 1, 12),
          { useHybrid: true, useMMR: true, mmrLambda: 0.72 },
        );
        return textResult({ hits });
      },
    },
    'project.memory.list': {
      tool: buildTool(
        'project.memory.list',
        'List durable project memory facts for a project owned by the authenticated user.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['projectId'],
          properties: {
            projectId: { type: 'string', minLength: 1, maxLength: 120 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      ),
      handler: async (args, context, deps) => {
        const project = await assertProjectOwner(deps.prisma, context.tenantScope.userId, args.projectId);
        const memory = await deps.projectMemory.listMemory(project.id, {
          limit: clampInt(args.limit, 30, 1, 100),
        });
        return textResult({ memory });
      },
    },
    'document.preview': {
      tool: buildTool(
        'document.preview',
        'Read a bounded Markdown preview of a project document owned by the authenticated user.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['projectId', 'docId'],
          properties: {
            projectId: { type: 'string', minLength: 1, maxLength: 120 },
            docId: { type: 'string', minLength: 1, maxLength: 120 },
            maxChars: { type: 'integer', minimum: 100, maximum: MAX_PREVIEW_CHARS },
          },
        },
      ),
      handler: async (args, context, deps) => {
        const project = await assertProjectOwner(deps.prisma, context.tenantScope.userId, args.projectId);
        if (!deps.prisma?.projectDocument?.findFirst) {
          throw new McpToolRegistryError('mcp_dependency_unavailable', 503, 'Project document storage is unavailable');
        }
        const docId = trimString(args.docId);
        if (!docId) {
          throw new McpToolRegistryError('invalid_mcp_arguments', 400, 'docId is required');
        }
        const doc = await deps.prisma.projectDocument.findFirst({
          where: {
            id: docId,
            projectId: project.id,
            project: { userId: context.tenantScope.userId },
          },
          select: { id: true, title: true, content: true, updatedAt: true, meta: true },
        });
        if (!doc) {
          throw new McpToolRegistryError('mcp_document_not_found', 404, 'Document was not found for this tenant scope');
        }
        const maxChars = clampInt(args.maxChars, DEFAULT_MAX_PREVIEW_CHARS, 100, MAX_PREVIEW_CHARS);
        const content = typeof doc.content === 'string' ? doc.content : '';
        return textResult({
          document: {
            id: doc.id,
            title: doc.title,
            updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
            meta: doc.meta || null,
            preview: content.slice(0, maxChars),
            truncated: content.length > maxChars,
          },
        });
      },
    },
  };
}

function createMcpToolRegistry(options = {}) {
  const env = options.env || process.env;
  const tools = buildApprovedTools();
  const deps = {
    createGitHubConnector: options.createGitHubConnector || (() => createGitHubCodexConnector({ env })),
    rag: options.rag || ragService,
    projectMemory: options.projectMemory || projectMemory,
    prisma: options.prisma || null,
  };

  function visibleToolEntries(context = {}) {
    const allowlist = resolveEffectiveMcpToolAllowlist(context, env);
    return Object.entries(tools).filter(([name]) => allowlist.includes(name));
  }

  return {
    version: MCP_HUB_VERSION,
    approvedTools: DEFAULT_MCP_TOOLS.slice(),

    listTools(context = {}) {
      const result = {
        tools: visibleToolEntries(context).map(([, entry]) => entry.tool),
      };
      return assertMcpSchema(ListToolsResultSchema, result, 'invalid_mcp_list_tools_result');
    },

    async callTool(name, args = {}, context = {}) {
      const toolName = trimString(name);
      const entry = tools[toolName];
      if (!entry) {
        throw new McpToolRegistryError('mcp_tool_not_found', 404, 'MCP tool is not registered', { tool: toolName });
      }
      const safeArgs = assertObjectArgs(args);
      assertNoBrowserSecrets(safeArgs);
      const runtimeContext = {
        ...context,
        tenantScope: context.tenantScope || createMcpTenantScope(context.user || {}),
        allowlist: resolveEffectiveMcpToolAllowlist(context, env),
      };
      assertAuthorized(toolName, runtimeContext);
      return entry.handler(safeArgs, runtimeContext, deps);
    },

    status(context = {}) {
      const list = this.listTools(context);
      return {
        version: MCP_HUB_VERSION,
        protocol: {
          package: '@modelcontextprotocol/sdk',
          mode: 'internal_read_only_registry',
          arbitraryServersAllowed: false,
          browserTokensAllowed: false,
        },
        approvedTools: DEFAULT_MCP_TOOLS.slice(),
        visibleTools: list.tools.map((tool) => tool.name),
      };
    },
  };
}

function normalizeMcpToolRegistryError(error) {
  if (error instanceof McpToolRegistryError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
        ...(Object.keys(error.details || {}).length ? { details: error.details } : {}),
      },
    };
  }
  return {
    status: 500,
    body: {
      error: 'MCP connector hub request failed',
      code: 'mcp_internal_error',
    },
  };
}

module.exports = {
  DEFAULT_MCP_TOOLS,
  MCP_HUB_VERSION,
  McpToolRegistryError,
  createMcpRequestContext,
  createMcpTenantScope,
  createMcpToolRegistry,
  normalizeMcpToolRegistryError,
  resolveMcpToolAllowlist,
};
