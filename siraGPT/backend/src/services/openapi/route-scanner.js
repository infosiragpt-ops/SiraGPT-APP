'use strict';

/**
 * route-scanner — static analysis of Express routes to produce an
 * OpenAPI 3.1 document.
 *
 * The scanner is purely AST-based (acorn) so it does not need to load
 * the application — useful for codegen in CI where the runtime
 * dependencies (Postgres, Redis, OpenAI) are unavailable.
 *
 * Supported patterns:
 *   - `app.use('/api/x', xRoutes)` mount declarations in index.js
 *   - `router.METHOD('/path', ...handlers)` inside a Router file
 *   - `app.METHOD('/path', ...handlers)` at the top level
 *   - JSDoc-style block comment immediately preceding a route handler
 *     (used for the operation summary/description).
 *
 * Out of scope (treated as opaque):
 *   - Dynamic mount paths assembled from variables.
 *   - Routes registered via `router.route('/x').get(...).post(...)`.
 *   - Sub-routers mounted via `router.use(...)` inside route files
 *     (these are emitted as nested mounts but only one level deep).
 */

const acorn = require('acorn');

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];

function parse(source) {
  return acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    locations: true,
    onComment: (block, text, _start, _end, locStart) => {
      if (!block) return;
      // attached later by collector
      collectedComments.push({ text, line: locStart.line });
    },
  });
}

let collectedComments = [];

function parseWithComments(source) {
  collectedComments = [];
  const ast = parse(source);
  const comments = collectedComments.slice();
  collectedComments = [];
  return { ast, comments };
}

function findStringLiteral(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked).join('');
  }
  return null;
}

function findIdentifierName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property?.type === 'Identifier') {
    return node.property.name;
  }
  return null;
}

function walk(node, visitor) {
  if (!node || typeof node.type !== 'string') return;
  visitor(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walk(c, visitor);
    } else if (child && typeof child.type === 'string') {
      walk(child, visitor);
    }
  }
}

function leadingCommentFor(line, comments) {
  // Pick the closest block comment whose final line is at most 3 lines
  // above the route call. Empirically that matches both inline JSDoc
  // and multi-line section banners.
  let best = null;
  for (const c of comments) {
    const commentLines = c.text.split('\n').length;
    const endLine = c.line + commentLines - 1;
    if (endLine < line && line - endLine <= 3) {
      if (!best || c.line > best.line) best = c;
    }
  }
  return best ? cleanComment(best.text) : null;
}

function cleanComment(text) {
  // Strip leading "*" decoration that JSDoc-style block comments use.
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * Scan a single Express Router source string. Returns an array of
 * `{ method, path, line, summary, hasAuth }` records.
 */
function scanRouteSource(source) {
  const { ast, comments } = parseWithComments(source);
  const routes = [];
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee?.type !== 'MemberExpression' || callee.computed) return;
    const receiver = findIdentifierName(callee.object);
    const method = callee.property?.name;
    if (!HTTP_METHODS.includes(method)) return;
    if (!receiver || !['router', 'app', 'api'].includes(receiver) && !receiver.endsWith('Router')) {
      // Allow common variable names but skip unlikely ones (e.g. `array.get`).
      if (!['router', 'app', 'api'].includes(receiver)) return;
    }
    const pathArg = node.arguments[0];
    const pathValue = findStringLiteral(pathArg);
    if (pathValue == null) return;
    const handlerNames = node.arguments
      .slice(1)
      .map((a) => findIdentifierName(a))
      .filter(Boolean);
    const hasAuth = handlerNames.some((n) => /auth|requireUser|requireAdmin|authenticate/i.test(n));
    routes.push({
      method: method.toUpperCase(),
      path: pathValue,
      line: node.loc.start.line,
      summary: leadingCommentFor(node.loc.start.line, comments),
      hasAuth,
      handlers: handlerNames,
    });
  });
  return routes;
}

/**
 * Scan an `index.js`-style source for `app.use('/api/x', xRoutes)`
 * mount declarations and `const xRoutes = require('./src/routes/x')`
 * imports. Returns `{ mounts, imports }`.
 */
function scanMounts(source) {
  const { ast } = parseWithComments(source);
  const imports = new Map(); // local name → require path
  const mounts = []; // { mountPath, identifier, line }

  walk(ast, (node) => {
    // require('./src/routes/x')
    if (node.type === 'VariableDeclarator' && node.init?.type === 'CallExpression') {
      const init = node.init;
      if (init.callee?.name === 'require' && init.arguments.length === 1) {
        const requirePath = findStringLiteral(init.arguments[0]);
        if (!requirePath) return;
        if (node.id.type === 'Identifier') {
          imports.set(node.id.name, requirePath);
        } else if (node.id.type === 'ObjectPattern') {
          // const { router: x } = require(...)
          for (const prop of node.id.properties) {
            if (prop.type === 'Property' && prop.value.type === 'Identifier') {
              imports.set(prop.value.name, requirePath);
            }
          }
        }
      }
    }
    // app.use('/api/x', xRoutes)
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      if (
        callee?.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property?.name === 'use' &&
        findIdentifierName(callee.object) === 'app' &&
        node.arguments.length >= 2
      ) {
        const mountPath = findStringLiteral(node.arguments[0]);
        if (!mountPath || !mountPath.startsWith('/')) return;
        // Last argument is conventionally the router. Skip middleware
        // mounts where the second arg is a function-call (e.g.
        // `app.use('/api', apiLimiter)`).
        const last = node.arguments[node.arguments.length - 1];
        const ident = findIdentifierName(last);
        if (!ident) return;
        mounts.push({
          mountPath,
          identifier: ident,
          line: node.loc.start.line,
        });
      }
    }
  });

  return { mounts, imports };
}

/**
 * Combine scanned mounts and route files into a sorted list of
 * fully-qualified routes `{ method, fullPath, source, summary, hasAuth }`.
 *
 * Mounts whose router identifier does not resolve to a known import
 * are dropped (these are typically third-party middlewares like
 * Bull-Board's `serverAdapter.getRouter()`).
 */
function resolveRoutes({ mounts, imports }, routesByPath) {
  const out = [];
  const seen = new Set();
  for (const mount of mounts) {
    const requirePath = imports.get(mount.identifier);
    if (!requirePath) continue;
    const routeKey = normalizeRequirePath(requirePath);
    const routes = routesByPath.get(routeKey);
    if (!routes) continue;
    for (const r of routes) {
      const fullPath = joinPaths(mount.mountPath, r.path);
      const dedupe = `${r.method} ${fullPath}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({
        method: r.method,
        fullPath,
        mountPath: mount.mountPath,
        source: routeKey,
        summary: r.summary,
        hasAuth: r.hasAuth,
      });
    }
  }
  out.sort((a, b) => a.fullPath.localeCompare(b.fullPath) || a.method.localeCompare(b.method));
  return out;
}

function normalizeRequirePath(p) {
  // './src/routes/x' → 'x'
  const m = p.match(/routes\/([^']+?)$/);
  return m ? m[1].replace(/\.js$/, '') : p;
}

function joinPaths(a, b) {
  const left = a.replace(/\/+$/, '');
  const right = b.startsWith('/') ? b : `/${b}`;
  const joined = `${left}${right}`;
  return joined.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

/**
 * Convert Express `:param` syntax to OpenAPI `{param}` and return the
 * list of declared parameters.
 */
function expressPathToOpenApi(path) {
  const params = [];
  const converted = path.replace(/:([A-Za-z_][A-Za-z0-9_]*)(\??)/g, (_m, name, optional) => {
    params.push({ name, required: !optional });
    return `{${name}}`;
  });
  return { path: converted, params };
}

/**
 * Build a complete OpenAPI 3.1 document from a list of resolved
 * routes. The output is intentionally minimal — operations carry the
 * scanned summary and a generic 200/4xx response. Schema details are
 * out of scope for static scanning; downstream tooling can enrich
 * specific operations by id.
 */
function buildOpenApiDocument(routes, options = {}) {
  const {
    title = 'siraGPT Backend API',
    version = '1.0.0',
    description = 'Auto-generated OpenAPI 3.1 specification scanned from Express routes.',
    servers = [{ url: '/' }],
  } = options;

  const paths = {};
  for (const r of routes) {
    const { path: oasPath, params } = expressPathToOpenApi(r.fullPath);
    if (!paths[oasPath]) paths[oasPath] = {};
    const operation = {
      operationId: makeOperationId(r.method, r.fullPath),
      summary: r.summary || `${r.method} ${r.fullPath}`,
      tags: [tagFor(r.fullPath)],
      responses: {
        '200': { description: 'Successful response' },
        '400': { description: 'Bad request' },
        '500': { description: 'Server error' },
      },
    };
    if (r.hasAuth) {
      operation.security = [{ bearerAuth: [] }];
      operation.responses['401'] = { description: 'Unauthorized' };
    }
    if (params.length > 0) {
      operation.parameters = params.map((p) => ({
        name: p.name,
        in: 'path',
        required: p.required,
        schema: { type: 'string' },
      }));
    }
    paths[oasPath][r.method.toLowerCase()] = operation;
  }

  const document = {
    openapi: '3.1.0',
    info: {
      title,
      version,
      description,
    },
    servers,
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
  };

  return document;
}

function makeOperationId(method, path) {
  const slug = path
    .replace(/[{}]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${method.toLowerCase()}_${slug || 'root'}`;
}

function tagFor(fullPath) {
  // /api/agent/batch → "agent"; /api/projects/:id/documents → "projects"
  const segments = fullPath.split('/').filter(Boolean);
  if (segments.length === 0) return 'root';
  if (segments[0] === 'api' && segments[1]) return segments[1];
  return segments[0];
}

/**
 * Lightweight structural validation against the OpenAPI 3.1 shape we
 * care about. Returns `{ valid, errors }`. Intentionally minimal so we
 * don't ship a full validator — `swagger-cli validate` is the
 * authoritative external check.
 */
function validateOpenApiDocument(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') {
    return { valid: false, errors: ['document must be an object'] };
  }
  if (doc.openapi !== '3.1.0') errors.push('openapi must be "3.1.0"');
  if (!doc.info || typeof doc.info !== 'object') errors.push('info is required');
  else {
    if (typeof doc.info.title !== 'string') errors.push('info.title must be string');
    if (typeof doc.info.version !== 'string') errors.push('info.version must be string');
  }
  if (!doc.paths || typeof doc.paths !== 'object') errors.push('paths is required');
  else {
    for (const [p, item] of Object.entries(doc.paths)) {
      if (!p.startsWith('/')) errors.push(`path "${p}" must start with /`);
      if (!item || typeof item !== 'object') {
        errors.push(`paths["${p}"] must be an object`);
        continue;
      }
      for (const [method, op] of Object.entries(item)) {
        if (!HTTP_METHODS.includes(method)) {
          errors.push(`paths["${p}"].${method} is not a valid http method`);
          continue;
        }
        if (!op.responses || typeof op.responses !== 'object') {
          errors.push(`paths["${p}"].${method} must declare responses`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  scanRouteSource,
  scanMounts,
  resolveRoutes,
  buildOpenApiDocument,
  validateOpenApiDocument,
  expressPathToOpenApi,
  joinPaths,
  normalizeRequirePath,
  HTTP_METHODS,
};
