import assert from 'node:assert/strict';

const baseUrl = String(process.env.RUNSC_SMOKE_CONTROLLER_URL || 'http://127.0.0.1:4098').replace(/\/+$/, '');
const token = String(process.env.RUNSC_SMOKE_CONTROLLER_TOKEN || '');
assert.ok(token.length >= 32, 'RUNSC_SMOKE_CONTROLLER_TOKEN is required');

const created = [];

async function call(method, path, body, expected = 200) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(json)}`);
  return json;
}

function workspaceRef(letter) {
  return `ws_${letter.repeat(43)}`;
}

async function create(letter) {
  const result = await call('POST', '/v1/sandboxes', { workspaceRef: workspaceRef(letter), ttlMs: 600000 }, 201);
  assert.match(result.sandboxRef, /^sb_[A-Za-z0-9_-]{32}$/);
  assert.equal(result.attestation.sandboxRef, result.sandboxRef);
  assert.equal(result.attestation.workspaceRef, workspaceRef(letter));
  assert.equal(result.attestation.runtime.name, 'runsc-systrap');
  assert.equal(result.attestation.runtime.verifiedBy, 'docker-info+docker-inspect');
  assert.equal(result.attestation.filesystem.rootReadonly, true);
  assert.equal(result.attestation.filesystem.workspaceVolumeExclusive, true);
  assert.equal(result.attestation.filesystem.hostBinds, false);
  assert.equal(result.attestation.network.internal, true);
  assert.equal(result.attestation.network.exclusive, true);
  assert.equal(result.attestation.network.publishedPorts, false);
  assert.equal(result.attestation.process.user, '10001:10001');
  assert.equal(result.attestation.process.capDropAll, true);
  assert.equal(result.attestation.process.noNewPrivileges, true);
  assert.equal(result.attestation.capabilities.publicMultiTenant, false);
  assert.equal(result.attestation.capabilities.secretRefs, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /\/var\/lib\/docker|container-[a-z0-9]|sira-sb[nv]?-/i);
  created.push(result.sandboxRef);
  return result;
}

async function exec(ref, argv, timeoutMs = 10000, expected = 200) {
  return call('POST', `/v1/sandboxes/${encodeURIComponent(ref)}/exec`, { argv, timeoutMs }, expected);
}

try {
  const unauthorized = await fetch(`${baseUrl}/v1/sandboxes`, { method: 'POST' });
  assert.equal(unauthorized.status, 401);

  const sandboxA = await create('a');
  const sandboxAAgain = await call('POST', '/v1/sandboxes', { workspaceRef: workspaceRef('a') }, 201);
  assert.equal(sandboxAAgain.sandboxRef, sandboxA.sandboxRef, 'create must be idempotent per workspace');
  const sandboxB = await create('b');
  assert.notEqual(sandboxA.sandboxRef, sandboxB.sandboxRef);
  assert.notEqual(sandboxA.previewTarget.ref, sandboxB.previewTarget.ref);

  const marker = `sandbox-a-${Date.now()}`;
  await exec(sandboxA.sandboxRef, [
    'node', '-e',
    `require('node:fs').writeFileSync('/workspace/private-marker', ${JSON.stringify(marker)}, {mode: 0o600})`,
  ]);
  const ownRead = await exec(sandboxA.sandboxRef, [
    'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/workspace/private-marker','utf8'))",
  ]);
  assert.equal(ownRead.stdout, marker);
  const crossRead = await exec(sandboxB.sandboxRef, [
    'node', '-e',
    "const fs=require('node:fs'); if(fs.existsSync('/workspace/private-marker')){process.stdout.write(fs.readFileSync('/workspace/private-marker'));process.exit(2)}",
  ]);
  assert.equal(crossRead.exitCode, 0, `sandbox B read A's workspace: ${crossRead.stdout}`);
  assert.equal(crossRead.stdout, '');

  const networkProbe = await exec(sandboxB.sandboxRef, [
    'node', '-e',
    `const fs=require('node:fs');const net=require('node:net');
     const routes=fs.readFileSync('/proc/net/route','utf8').trim().split(/\n/).slice(1).map(line=>line.trim().split(/\s+/));
     const defaultRoutes=routes.filter(parts=>parts[1]==='00000000'&&parts[2]!=='00000000');
     if(defaultRoutes.length){console.error('DEFAULT_ROUTE_PRESENT:'+JSON.stringify(defaultRoutes));process.exit(5)}
     const targets=[['redis',6379],['db',5432],['backend',5000],['runner',4097],['169.254.169.254',80]];
     const probe=([host,port])=>new Promise((resolve)=>{const s=net.connect({host,port});let done=false;const end=(open)=>{if(done)return;done=true;s.destroy();resolve(open)};s.setTimeout(350,()=>end(false));s.once('connect',()=>end(true));s.once('error',()=>end(false));});
     Promise.all(targets.map(probe)).then(results=>{if(results.some(Boolean)){console.error(JSON.stringify(results));process.exit(3)}console.log('NO_DEFAULT_ROUTE');console.log('CONTROL_PLANE_BLOCKED')});`,
  ], 10000);
  assert.equal(networkProbe.exitCode, 0, networkProbe.stderr);
  assert.match(networkProbe.stdout, /NO_DEFAULT_ROUTE/);
  assert.match(networkProbe.stdout, /CONTROL_PLANE_BLOCKED/);

  const pidProbe = await exec(sandboxB.sandboxRef, [
    'node', '-e',
    `const {spawn}=require('node:child_process');let failures=0;let finished=false;
     for(let i=0;i<512;i++){try{const p=spawn('/bin/sleep',['4'],{stdio:'ignore'});p.once('error',()=>failures++)}catch{failures++}}
     setTimeout(()=>{if(finished)return;finished=true;console.log(failures>0?'PID_LIMIT_ENFORCED':'PID_LIMIT_MISSED');process.exit(failures>0?0:4)},800);`,
  ], 10000);
  assert.equal(pidProbe.exitCode, 0, pidProbe.stderr);
  assert.match(pidProbe.stdout, /PID_LIMIT_ENFORCED/);

  const timeoutResult = await exec(sandboxA.sandboxRef, [
    'node', '-e', 'setInterval(() => {}, 1000)',
  ], 1200, 408);
  assert.equal(timeoutResult.error, 'exec_timeout');
  const stoppedA = await call('GET', `/v1/sandboxes/${encodeURIComponent(sandboxA.sandboxRef)}`);
  assert.equal(stoppedA.state.running, false, 'timeout must terminate only its sandbox');
  const stillB = await call('GET', `/v1/sandboxes/${encodeURIComponent(sandboxB.sandboxRef)}`);
  assert.equal(stillB.state.running, true, 'sandbox B must survive sandbox A timeout');

  const sandboxC = await create('c');
  const memoryProbe = await exec(sandboxC.sandboxRef, [
    'node', '--max-old-space-size=2048', '-e',
    "const blocks=[];for(;;){const b=Buffer.alloc(32*1024*1024,1);blocks.push(b)}",
  ], 15000);
  assert.notEqual(memoryProbe.exitCode, 0, 'memory pressure escaped the cgroup limit');

  for (const ref of [...created].reverse()) {
    await call('DELETE', `/v1/sandboxes/${encodeURIComponent(ref)}`);
    await call('DELETE', `/v1/sandboxes/${encodeURIComponent(ref)}`);
  }
  created.length = 0;
  const gc = await call('POST', '/v1/gc', {});
  assert.deepEqual(gc.failed, []);
  console.log('runsc sandbox controller smoke passed');
} finally {
  for (const ref of [...created].reverse()) {
    await call('DELETE', `/v1/sandboxes/${encodeURIComponent(ref)}`).catch(() => {});
  }
}
