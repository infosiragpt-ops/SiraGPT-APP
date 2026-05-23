const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTRACT_REGISTRY_VERSION,
  buildJsonSchemaRegistry,
  buildOpenApiSpec,
} = require('../src/services/contracts/schema-registry');

function operation(spec, path, method) {
  const op = spec.paths[path]?.[method];
  assert.ok(op, `missing ${method.toUpperCase()} ${path}`);
  return op;
}

describe('OpenAPI contract export', () => {
  test('builds an authenticated OpenAPI 3.1 spec for selected high-value routes', () => {
    const spec = buildOpenApiSpec();
    assert.equal(spec.openapi, '3.1.0');
    assert.equal(spec.info.version, CONTRACT_REGISTRY_VERSION);
    assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');

    const requiredRoutes = [
      ['/api/codex/github/status', 'get'],
      ['/api/codex/github/repo', 'get'],
      ['/api/codex/github/files', 'get'],
      ['/api/codex/github/ingest', 'post'],
      ['/api/codex/github/retrieve', 'post'],
      ['/api/agent/task', 'post'],
      ['/api/files/upload', 'post'],
      ['/api/rag/ingest', 'post'],
      ['/api/rag/retrieve', 'post'],
      ['/api/rag/ingest-code', 'post'],
      ['/api/rag/stats', 'get'],
    ];

    for (const [path, method] of requiredRoutes) {
      const op = operation(spec, path, method);
      assert.deepEqual(op.security, [{ bearerAuth: [] }]);
      assert.ok(op.operationId);
      assert.ok(op.responses['200']);
    }
  });

  test('exports request bounds for GitHub Codex, RAG, agent tasks and file upload', () => {
    const spec = buildOpenApiSpec();

    const githubRepo = operation(spec, '/api/codex/github/repo', 'get');
    const repoParam = githubRepo.parameters.find((param) => param.name === 'repo');
    const limitParam = githubRepo.parameters.find((param) => param.name === 'limit');
    assert.equal(repoParam.required, true);
    assert.equal(repoParam.schema.maxLength, 240);
    assert.equal(limitParam.schema.maximum, 20);

    const ragRetrieveSchema = operation(spec, '/api/rag/retrieve', 'post')
      .requestBody.content['application/json'].schema;
    assert.equal(ragRetrieveSchema.properties.query.minLength, 2);
    assert.equal(ragRetrieveSchema.properties.k.maximum, 20);
    assert.equal(ragRetrieveSchema.properties.rrfK.maximum, 200);

    const agentTaskSchema = operation(spec, '/api/agent/task', 'post')
      .requestBody.content['application/json'].schema;
    assert.equal(agentTaskSchema.properties.goal.maxLength, 4000);
    assert.equal(agentTaskSchema.properties.maxRuntimeMs.maximum, 7200000);
    assert.equal(agentTaskSchema.properties.files.maxItems, 20);

    const uploadSchema = operation(spec, '/api/files/upload', 'post')
      .requestBody.content['multipart/form-data'].schema;
    assert.equal(uploadSchema.properties.files.maxItems, 10);
    assert.equal(uploadSchema.properties.files.items.format, 'binary');
  });

  test('keeps JSON Schema registry and OpenAPI route inventory in sync', () => {
    const schemaRegistry = buildJsonSchemaRegistry();
    const spec = buildOpenApiSpec();
    const openApiIds = new Set();

    for (const pathItem of Object.values(spec.paths)) {
      for (const operation of Object.values(pathItem)) {
        openApiIds.add(operation.operationId);
      }
    }

    for (const route of Object.values(schemaRegistry.routes)) {
      assert.equal(openApiIds.has(route.id), true, `missing OpenAPI operation for ${route.id}`);
      if (route.schemas.body) {
        const op = operation(spec, route.path, route.method.toLowerCase());
        assert.ok(op.requestBody, `${route.id} should expose a requestBody`);
      }
    }
  });
});
