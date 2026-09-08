'use strict';

// ensureAppsVitePreviewable — a broken Next+Vite hybrid may be normalized, but
// an executable imported Next application is immutable framework-wise. A
// destructive framework migration needs a separate confirmed workflow; prompt
// interpretation alone must never authorize route/config deletion.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSystemPrompt,
  ensureAppsVitePreviewable,
} = require('../src/services/codex/agent-loop');

const APPS_PROMPT = 'MODO APPS TIPO CODEX:\n- ...\nSOLICITUD DEL USUARIO:\ncrea una landing de un gimnasio';
const APPS_FOLLOW_UP_PROMPT = 'MODO APPS TIPO CODEX:\n- ...\nSOLICITUD DEL USUARIO:\ncambia el texto del encabezado';

function fakeRunner(files) {
  const calls = { writeFiles: [], exec: [] };
  return {
    calls,
    readFile: async (_project, path) => ({ content: files[path] || '' }),
    writeFiles: async (_project, written) => { calls.writeFiles.push(written); },
    exec: async (_project, cmd) => {
      calls.exec.push(cmd);
      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: Object.keys(files).join('\n'), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

const eventStore = { appendEvent: async () => {} };
const prisma = {};

test('Next hybrid → repairs: writes Vite fallback AND purges the Next scaffold', async () => {
  const runner = fakeRunner({
    'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15.0.0', react: '18' } }),
    'index.html': '',
    'src/main.js': '',
  });
  const res = await ensureAppsVitePreviewable({
    run: { id: 'r1', projectId: 'p1', prompt: APPS_PROMPT },
    project: { id: 'p1', name: 'Gimnasio' },
    runner, eventStore, prisma,
  });
  assert.equal(res.repaired, true);
  assert.equal(runner.calls.writeFiles.length, 1, 'should write the Vite fallback');
  const purgeCalls = runner.calls.exec.filter((cmd) => cmd[0] === 'node' && cmd[1] === '-e');
  assert.equal(purgeCalls.length, 1, 'should purge the Next scaffold exactly once');
  const rm = purgeCalls[0];
  // The purge must be an argv array of an allowlisted binary (the runner
  // rejects shell strings) — node -e with fs.rmSync over the Next leftovers.
  assert.ok(Array.isArray(rm), 'purge must be an argv array, not a shell string');
  assert.equal(rm[0], 'node');
  assert.equal(rm[1], '-e');
  assert.match(rm[2], /rmSync/);
  assert.match(rm[2], /"app"/);
  assert.match(rm[2], /next\.config\.mjs/);
});

for (const fixture of [
  {
    name: 'root App Router',
    route: 'app/page.tsx',
    routeContent: 'export default function Page() { return <main>App Router importado</main> }\n',
    supportingFiles: {
      'app/layout.tsx': 'export default function Layout({ children }) { return <html><body>{children}</body></html> }\n',
      'next.config.mjs': 'export default { poweredByHeader: false }\n',
      'next-env.d.ts': '/// <reference types="next" />\n',
    },
  },
  {
    name: 'Pages Router',
    route: 'pages/index.jsx',
    routeContent: 'export default function Home() { return <main>Pages importado</main> }\n',
    supportingFiles: {
      'pages/_app.jsx': 'export default function App({ Component, pageProps }) { return <Component {...pageProps} /> }\n',
      'next.config.js': 'module.exports = { reactStrictMode: true }\n',
      'next-env.d.ts': '/// <reference types="next" />\n',
    },
  },
  {
    name: 'src App Router',
    route: 'src/app/page.tsx',
    routeContent: 'export default function Page() { return <main>src/app importado</main> }\n',
    supportingFiles: {
      'src/app/layout.tsx': 'export default function Layout({ children }) { return <html><body>{children}</body></html> }\n',
      'next.config.ts': 'const config = { reactStrictMode: true }; export default config\n',
      'next-env.d.ts': '/// <reference types="next" />\n',
    },
  },
  {
    name: 'nested App Router',
    route: 'app/(marketing)/page.tsx',
    routeContent: 'export default function Page() { return <main>Ruta anidada importada</main> }\n',
    supportingFiles: {
      'app/layout.tsx': 'export default function Layout({ children }) { return <html><body>{children}</body></html> }\n',
      'next.config.mjs': 'export default { reactStrictMode: true }\n',
      'next-env.d.ts': '/// <reference types="next" />\n',
    },
  },
  {
    name: 'API-only App Router',
    route: 'app/api/health/route.ts',
    routeContent: 'export async function GET() { return Response.json({ ok: true }) }\n',
    supportingFiles: {
      'next.config.mjs': 'export default { poweredByHeader: false }\n',
      'next-env.d.ts': '/// <reference types="next" />\n',
    },
  },
  {
    name: 'MDX Pages Router',
    route: 'pages/index.mdx',
    routeContent: '# Portal MDX importado\n',
    dependencies: { '@next/mdx': '^15.4.0' },
    supportingFiles: {
      'next.config.mjs': "import createMDX from '@next/mdx'; export default createMDX()({ pageExtensions: ['js', 'jsx', 'mdx'] })\n",
      'next-env.d.ts': '/// <reference types="next" />\n',
    },
  },
]) {
  test(`imported executable Next ${fixture.name} → preserves routes and configs without Vite repair or purge`, async () => {
    const files = {
      'package.json': JSON.stringify({
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: {
          next: '^15.4.0',
          react: '^19.0.0',
          'react-dom': '^19.0.0',
          ...(fixture.dependencies || {}),
        },
      }),
      [fixture.route]: fixture.routeContent,
      ...fixture.supportingFiles,
    };
    const originalFiles = { ...files };
    const runner = fakeRunner(files);

    const res = await ensureAppsVitePreviewable({
      run: { id: `next-${fixture.name}`, projectId: 'next-imported', prompt: APPS_FOLLOW_UP_PROMPT },
      project: { id: 'next-imported', name: fixture.name },
      runner,
      eventStore,
      prisma,
    });

    assert.equal(res.repaired, false);
    assert.equal(res.preservedFramework, 'next');
    assert.equal(runner.calls.writeFiles.length, 0, 'must not write a Vite fallback');
    assert.equal(
      runner.calls.exec.some((cmd) => cmd[0] === 'node' && cmd[1] === '-e'),
      false,
      'must not invoke node -e/fs.rmSync purge',
    );
    assert.deepEqual(files, originalFiles, 'Next routes and configuration must remain byte-for-byte unchanged');
  });
}

test('Next inventory failure fails safe instead of authorizing Vite conversion or fs.rmSync', async () => {
  const files = {
    'package.json': JSON.stringify({
      scripts: { dev: 'next dev' },
      dependencies: { next: '^15.4.0', react: '^19.0.0' },
    }),
    'next.config.mjs': 'export default {}\n',
  };
  const runner = fakeRunner(files);
  runner.exec = async (_project, cmd) => {
    runner.calls.exec.push(cmd);
    if (cmd[0] === 'git' && cmd[1] === 'ls-files') throw new Error('runner inventory unavailable');
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const res = await ensureAppsVitePreviewable({
    run: { id: 'next-inventory-failure', projectId: 'next-imported', prompt: APPS_FOLLOW_UP_PROMPT },
    project: { id: 'next-imported', name: 'Next inventory failure' },
    runner,
    eventStore,
    prisma,
  });

  assert.equal(res.repaired, false);
  assert.equal(res.preservedFramework, 'next');
  assert.equal(runner.calls.writeFiles.length, 0);
  assert.equal(runner.calls.exec.some((cmd) => cmd[0] === 'node' && cmd[1] === '-e'), false);
});

test('imported Next evidence keeps the agent prompt on Next for a follow-up that does not name the framework', () => {
  const base = {
    project: { id: 'next-imported', name: 'Portal Next' },
    plan: { architecture: 'React + Vite', tasks: [{ id: 'header', title: 'Editar encabezado' }] },
    sourcePrompt: APPS_FOLLOW_UP_PROMPT,
    projectNotes: '',
  };
  const prompts = [
    buildSystemPrompt({
      ...base,
      fileTree: 'package.json\nnext.config.mjs\nsrc/app/layout.tsx\nsrc/app/page.tsx\n',
      preserveExistingNext: true,
    }),
    buildSystemPrompt({
      ...base,
      // A large ranked repo map may omit the route; runBuildLoop supplies this
      // independently detected flag from package.json + the runner inventory.
      fileTree: 'package.json\nnext.config.mjs\n',
      preserveExistingNext: true,
    }),
  ];

  for (const prompt of prompts) {
    assert.match(prompt, /workspace APPS usa Next\.js/i);
    assert.match(prompt, /Conserva app\/, pages\/, src\/app\/, src\/pages\/, next\.config\.\*/i);
    assert.match(prompt, /NO conviertas el proyecto a Vite/i);
    assert.match(prompt, /suposición obsoleta del planificador: conserva Next\.js/i);
    assert.doesNotMatch(prompt, /Stack OBLIGATORIO: React 18 \+ Vite 7/i);
    assert.doesNotMatch(prompt, /PROHIBIDO Next\.js/i);
  }
});

test('a verified Vite workspace with src/pages is not misclassified as Next', () => {
  const prompt = buildSystemPrompt({
    project: { id: 'vite-pages', name: 'Vite pages' },
    plan: null,
    fileTree: 'package.json\nindex.html\nsrc/main.tsx\nsrc/pages/index.tsx\n',
    sourcePrompt: APPS_FOLLOW_UP_PROMPT,
    projectNotes: '',
    preserveExistingNext: false,
  });

  assert.match(prompt, /Stack OBLIGATORIO: React 18 \+ Vite 7/i);
  assert.doesNotMatch(prompt, /workspace APPS usa Next\.js/i);
  assert.doesNotMatch(prompt, /NO conviertas el proyecto a Vite/i);
});

test('already-clean React+Vite+TS → no repair, no purge', async () => {
  const runner = fakeRunner({
    'package.json': JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { react: '^18' }, devDependencies: { vite: '^7.0.0', '@vitejs/plugin-react': '^4' } }),
    'index.html': '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>',
    'src/App.tsx': 'export default function App(){ return <main>Cafetería real generada</main> }',
  });
  const res = await ensureAppsVitePreviewable({
    run: { id: 'r2', projectId: 'p2', prompt: APPS_PROMPT },
    project: { id: 'p2', name: 'Clean' },
    runner, eventStore, prisma,
  });
  assert.equal(res.repaired, false);
  assert.equal(runner.calls.writeFiles.length, 0);
  assert.equal(runner.calls.exec.length, 0);
});

test('non-APPS prompt → never touches the workspace', async () => {
  const runner = fakeRunner({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev' } }) });
  const res = await ensureAppsVitePreviewable({
    run: { id: 'r3', projectId: 'p3', prompt: 'crea una landing' }, // no APPS marker
    project: { id: 'p3', name: 'X' },
    runner, eventStore, prisma,
  });
  assert.equal(res.repaired, false);
  assert.equal(runner.calls.writeFiles.length, 0);
  assert.equal(runner.calls.exec.length, 0);
});

test('explicit Next request → respected (no forced Vite normalization)', async () => {
  const runner = fakeRunner({
    'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15' } }),
  });
  const res = await ensureAppsVitePreviewable({
    run: { id: 'r4', projectId: 'p4', prompt: 'MODO APPS TIPO CODEX:\nSOLICITUD DEL USUARIO:\nhazme una app con Next.js' },
    project: { id: 'p4', name: 'NextApp' },
    runner, eventStore, prisma,
  });
  assert.equal(res.repaired, false);
  assert.equal(runner.calls.exec.length, 0);
});

for (const request of [
  'no cambies Next por Vite',
  'mantén Next.js; no migres a Vite',
  'no quiero convertir Next a Vite',
  "don't migrate Next.js to Vite",
  '¿Debería migrar Next.js a Vite?',
  'Explícame cómo migrar Next.js a Vite',
  'Crea una guía para convertir Next a Vite',
  'Migra este proyecto de Next.js a Vite',
]) {
  test(`prompt text alone cannot authorize destructive Next conversion: ${request}`, async () => {
    const runner = fakeRunner({
      'package.json': JSON.stringify({
        scripts: { dev: 'next dev', build: 'next build' },
        dependencies: { next: '15', react: '19' },
      }),
      'app/page.tsx': 'export default function Page() { return <main>Conservar Next</main> }\n',
      'next.config.mjs': 'export default {}\n',
    });
    const res = await ensureAppsVitePreviewable({
      run: {
        id: `negated-${request}`,
        projectId: 'next-negated',
        prompt: `MODO APPS TIPO CODEX:\nSOLICITUD DEL USUARIO:\n${request}`,
      },
      project: { id: 'next-negated', name: 'Next preservado' },
      runner,
      eventStore,
      prisma,
    });

    assert.equal(res.repaired, false);
    assert.equal(runner.calls.writeFiles.length, 0);
    assert.equal(
      runner.calls.exec.some((cmd) => cmd[0] === 'node' && cmd[1] === '-e'),
      false,
      'prompt interpretation must never invoke the destructive Next purge',
    );
  });
}
