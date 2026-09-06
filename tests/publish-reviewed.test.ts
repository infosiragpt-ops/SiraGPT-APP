import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { gzipSync } from "node:zlib"
import test from "node:test"

const target = "a".repeat(40)
const previous = "b".repeat(40)
const original = fs.readFileSync(path.join(process.cwd(), "deploy/iliagpt/publish-reviewed.sh"), "utf8")
// Deterministic orchestration tests only. Every Docker/Git/HTTP operation is a
// local command fixture; this does NOT certify a real backup or deployment.
const commandFixture = String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=process.env.FIXTURE_ROOT,c=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
const command=path.basename(process.argv[1]),a=process.argv.slice(2),stateFile=path.join(root,'state');
const state=(service='backend')=>fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8'))[service]||'previous':'previous';
const fail=()=>{process.stderr.write('fixture-private-value\n');process.exit(1)};
fs.appendFileSync(path.join(root,'commands.jsonl'),JSON.stringify({command,args:a})+'\n');
if(command==='sleep')process.exit(0);
if(command==='pg_dump'){if(c.dumpFail)fail();console.log('PGDMP fixture');process.exit(0);}
if(command==='pg_restore'){
 const header=Buffer.alloc(5);const n=fs.readSync(0,header,0,header.length,null);
 if(c.invalidDump||n!==5||header.toString()!=='PGDMP')fail();
 console.log('verified fixture archive');process.exit(0);
}
if(command==='git'){
 if(a[0]==='status'){if(c.gitStatusError)fail();if(c.dirty)console.log(' M fixture.txt');}
 else if(a[0]==='rev-parse')console.log(c.wrongHead?'c'.repeat(40):c.target);
 else if(a[0]==='diff'){if(c.diffError)fail();if(c.schema)console.log('backend/prisma/schema.prisma');}
 else if(a[0]==='merge-base'&&c.notAncestor)fail();
 process.exit(0);
}
if(command==='curl'){
 if(a.at(-1).endsWith('/api/version')){
  const countFile=path.join(root,'version-count');const count=+(fs.existsSync(countFile)?fs.readFileSync(countFile,'utf8'):0)+1;fs.writeFileSync(countFile,String(count));
  if(c.invalidVersion){console.log('{invalid');process.exit(0)}
  console.log(JSON.stringify({commit:c.wrongLive||(c.concurrent&&count>=2)?'c'.repeat(40):state()==='target'?c.target:c.previous}));
 }else{
  const checks=['database','redis','migrations'].map(name=>({name,status:'healthy'}));
  if(c.badReady)checks[0].status='unhealthy';
  if(c.missingCheck)checks.pop();
  if(c.duplicateCheck)checks.push(checks[0]);
  console.log(JSON.stringify({status:'healthy',checks}));
 }
 process.exit(0);
}
if(command==='docker'){
 if(a[0]==='inspect'){
  if(a.includes('{{.Image}}'))console.log('sha256:'+(c.changeImage&&fs.existsSync(path.join(root,'built'))?'4':({ 'runner-id':'1','backend-id':'2','frontend-id':'3' }[a.at(-1)])).repeat(64));
  else {
   const service=a.at(-1).replace(/-id$/,'');
   const targetUnhealthy=state(service)==='target'&&(c.badTargetHealth||c.badTargetService===service);
   const rollbackUnhealthy=fs.existsSync(path.join(root,'rollback-started'))&&c.badRollbackService===service;
   console.log(c.badContainer||targetUnhealthy||rollbackUnhealthy?'running unhealthy':'running healthy');
  }
  process.exit(0);
 }
 if(a[0]==='image'&&a[1]==='tag')process.exit(0);
 if(a[0]==='run'){if(c.attestationFail)fail();process.exit(0)}
 if(a[0]==='exec'){
  const n=a.indexOf('node');const r=cp.spawnSync(process.execPath,a.slice(n+1),{input:fs.readFileSync(0),encoding:'utf8'});
  process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);
 }
 if(a[0]==='compose'){
  if(a.includes('ps')){console.log(a.at(-1)+'-id');process.exit(0)}
  if(a.includes('config')){
   if(a.includes('--format'))console.log(JSON.stringify({services:{backend:{image:c.wrongCandidate?'unexpected:image':'iliagpt-backend:'+process.env.SIRAGPT_VERSION}}}));
   process.exit(0);
  }
  if(a.includes('build')){
   console.log('fixture-private-value');if(c.buildFail)fail();
   fs.writeFileSync(path.join(root,'built'),'1');
   if(c.changeConfig)fs.appendFileSync(path.join(root,'deploy','compose.yaml'),'# concurrent edit\n');
   if(c.changeMetadata)fs.appendFileSync(path.join(root,'deploy','.env'),'GIT_COMMIT='+'c'.repeat(40)+'\n');
   process.exit(0);
  }
  if(a.includes('up')){
   const rollback=a.some(x=>x.endsWith('/rollback.yaml'));
   if(rollback)fs.writeFileSync(path.join(root,'rollback-started'),'1');
   if(rollback&&c.rollbackFail)fail();
   const services=a.filter(x=>['runner','backend','frontend'].includes(x));
   const current=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{};
   for(const service of services)current[service]=rollback?'previous':'target';
   fs.writeFileSync(stateFile,JSON.stringify(current));
   const envMarker=path.join(root,'env-changed');
   if(!rollback&&c.changeEnv&&!fs.existsSync(envMarker)){fs.writeFileSync(envMarker,'1');fs.appendFileSync(path.join(root,'deploy','.env'),'UNRELATED_NEW=value-after-activation\n');}
   if(!rollback&&(c.upFail||(c.backendUpFail&&services.includes('backend'))))fail();process.exit(0);
  }
  if(a.includes('exec')&&a.includes('db')){
   const n=a.indexOf('sh');if(n<0||a[n+1]!=='-c')fail();
   // Preserve the actual pipe fd: pg_restore reads only a header, then the
   // publisher's same-shell cat must consume the unread remainder.
   const r=cp.spawnSync('sh',a.slice(n+1),{stdio:['inherit','pipe','pipe'],encoding:'utf8'});
   process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);
  }
 }
}
fail();
`

function runCase(options: Record<string, unknown> = {}, args = [target, previous]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siragpt-publish-test-"))
  const repo = path.join(dir, "repo"), deploy = path.join(dir, "deploy"), lock = path.join(dir, "lock")
  fs.mkdirSync(repo); fs.mkdirSync(deploy); fs.mkdirSync(path.join(dir, "bin"))
  const envBefore = `UNRELATED_SECRET=fixture-private-value\nGIT_COMMIT=${previous}\nSIRAGPT_VERSION=previous-version\n`
  fs.writeFileSync(path.join(deploy, ".env"), envBefore, { mode: 0o600 })
  fs.writeFileSync(path.join(deploy, "compose.yaml"), "services: {}\n")
  fs.writeFileSync(path.join(deploy, "Caddyfile"), ":80 {}\n")
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ target, previous, ...options }))
  fs.writeFileSync(path.join(dir, "commands.jsonl"), "")
  if (options.locked) fs.mkdirSync(lock)
  // Change only the three fixed filesystem constants in an ephemeral test copy.
  // Production script exposes no arbitrary path/eval hooks and is never invoked.
  const source = original.replace("REPO=/home/user/SiraGPT-APP", `REPO='${repo}'`)
    .replace("DEPLOY=/home/user/deployments/iliagpt", `DEPLOY='${deploy}'`)
    .replace("LOCK=/tmp/siragpt-publish.lock", `LOCK='${lock}'`)
  const script = path.join(dir, "publish.sh")
  fs.writeFileSync(script, source, { mode: 0o700 })
  for (const command of ["git", "docker", "curl", "sleep", "pg_dump", "pg_restore"]) {
    fs.writeFileSync(path.join(dir, "bin", command), `#!${process.execPath}\n${commandFixture}`, { mode: 0o700 })
  }
  const result = spawnSync("bash", [script, ...args], {
    env: { PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, FIXTURE_ROOT: dir },
    encoding: "utf8", timeout: 30_000,
  })
  const commands = fs.readFileSync(path.join(dir, "commands.jsonl"), "utf8").trim().split("\n")
    .filter(Boolean).map(line => JSON.parse(line) as { command: string; args: string[] })
  const backups = fs.existsSync(path.join(deploy, "backups")) ? fs.readdirSync(path.join(deploy, "backups")) : []
  return { dir, deploy, lock, result, commands, backups, envBefore,
    output: result.stdout + result.stderr,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

test("reviewed publisher is valid bash and exposes only fixed Lenovo paths", () => {
  assert.equal(spawnSync("bash", ["-n"], { input: original }).status, 0)
  assert.match(original, /REPO=\/home\/user\/SiraGPT-APP/)
  assert.match(original, /DEPLOY=\/home\/user\/deployments\/iliagpt/)
  assert.doesNotMatch(original, /reset --hard|down -v|system prune|docker logs|eval\s/)
})

for (const [reason, options] of Object.entries({
  "dirty checkout": { dirty: true }, "wrong checkout": { wrongHead: true },
  "git status fails": { gitStatusError: true }, "non-ancestor commit": { notAncestor: true },
  "migration diff": { schema: true }, "schema check fails": { diffError: true },
  "different live SHA": { wrongLive: true }, "invalid version JSON": { invalidVersion: true },
  "unhealthy dependency": { badReady: true }, "missing dependency check": { missingCheck: true },
  "duplicate dependency check": { duplicateCheck: true }, "unhealthy container": { badContainer: true },
  "failed pg_dump": { dumpFail: true }, "unreadable dump": { invalidDump: true },
  "failed build": { buildFail: true }, "concurrent live change": { concurrent: true },
  "concurrent compose change": { changeConfig: true }, "concurrent running image change": { changeImage: true },
  "failed candidate attestation": { attestationFail: true }, "unexpected candidate image": { wrongCandidate: true },
})) {
  test(`reviewed publisher refuses ${reason} before activation`, () => {
    const c = runCase(options)
    try {
      assert.equal(c.result.status, 1, c.output)
      assert.ok(!c.commands.some(command => command.command === "docker" && command.args.includes("up")))
      assert.equal(fs.readFileSync(path.join(c.deploy, ".env"), "utf8"), c.envBefore)
      assert.equal(fs.existsSync(c.lock), false)
      assert.doesNotMatch(c.output, /fixture-private-value/)
    } finally { c.cleanup() }
  })
}

test("reviewed publisher does not overwrite concurrently changed release metadata", () => {
  const c = runCase({ changeMetadata: true })
  try {
    assert.equal(c.result.status, 1, c.output)
    assert.ok(!c.commands.some(command => command.args.includes("up")))
    assert.equal(fs.readFileSync(path.join(c.deploy, ".env"), "utf8"), c.envBefore + `GIT_COMMIT=${"c".repeat(40)}\n`)
    assert.match(c.output, /Release metadata changed during the build/)
  } finally { c.cleanup() }
})

test("reviewed publisher refuses invalid arguments and leaves an existing lock untouched", () => {
  for (const [options, args] of [[{}, ["bad", previous]], [{ locked: true }, [target, previous]]] as const) {
    const c = runCase(options, [...args])
    try {
      assert.equal(c.result.status, 1)
      assert.equal(c.commands.length, 0)
      assert.equal(fs.existsSync(c.lock), "locked" in options)
    } finally { c.cleanup() }
  }
})

test("reviewed publisher captures private backups and updates only the three application services", () => {
  const c = runCase()
  try {
    assert.equal(c.result.status, 0, c.output)
    assert.equal(c.backups.length, 1)
    const backup = path.join(c.deploy, "backups", c.backups[0])
    assert.equal(fs.statSync(backup).mode & 0o777, 0o700)
    for (const name of [".env", "compose.yaml", "Caddyfile", "database.dump.gz", "publish.log", "rollback.yaml"]) {
      assert.equal(fs.statSync(path.join(backup, name)).mode & 0o777, 0o600, name)
    }
    assert.equal(spawnSync("gzip", ["-t", path.join(backup, "database.dump.gz")]).status, 0)
    assert.ok(c.commands.some(x => x.command === "pg_restore" && x.args.includes("--list")))
    const updates = c.commands.filter(x => x.command === "docker" && x.args.includes("up"))
    assert.equal(updates.length, 2)
    assert.deepEqual(updates[0].args.slice(-2), ["runner", "frontend"])
    assert.equal(updates[1].args.at(-1), "backend")
    for (const update of updates) {
      for (const flag of ["--no-deps", "--no-build"]) assert.ok(update.args.includes(flag))
      assert.deepEqual(update.args.slice(update.args.indexOf("--pull"), update.args.indexOf("--pull") + 2), ["--pull", "never"])
    }
    const between = c.commands.slice(c.commands.indexOf(updates[0]) + 1, c.commands.indexOf(updates[1]))
    for (const service of ["runner", "frontend"]) {
      assert.ok(between.some(x => x.command === "docker" && x.args[0] === "inspect" && x.args.at(-1) === `${service}-id`), `${service} must be healthy before backend`)
    }
    assert.equal(c.commands.filter(x => x.args[0] === "image" && x.args[1] === "tag").length, 3)
    const attestation = c.commands.find(x => x.command === "docker" && x.args[0] === "run")
    assert.ok(attestation)
    assert.deepEqual(attestation.args.slice(0, 6), ["run", "--rm", "--network", "none", "--entrypoint", "node"])
    assert.match(attestation.args[6], /^iliagpt-backend:reviewed-/)
    assert.deepEqual(attestation.args.slice(-2), ["scripts/image-size-security-patch.cjs", "--verify"])
    const env = fs.readFileSync(path.join(c.deploy, ".env"), "utf8")
    assert.match(env, new RegExp(`^GIT_COMMIT=${target}$`, "m"))
    assert.match(env, /^UNRELATED_SECRET=fixture-private-value$/m)
    assert.doesNotMatch(c.output, /fixture-private-value/)
    assert.match(c.output, /Target release healthy and verified/)
    const journal = fs.readFileSync(path.join(c.deploy, "releases.log"), "utf8")
    assert.match(journal, new RegExp(`target=${target} previous=${previous} version=reviewed-`))
    assert.doesNotMatch(journal, /fixture-private-value|UNRELATED_SECRET/)
    assert.equal(fs.statSync(path.join(c.deploy, "releases.log")).mode & 0o777, 0o600)
    assert.equal(fs.existsSync(c.lock), false)
  } finally { c.cleanup() }
})

for (const [reason, options, targetUpdates] of [
  ["partial first-stage activation", { upFail: true }, 1],
  ["unhealthy runner", { badTargetService: "runner" }, 1],
  ["unhealthy frontend", { badTargetService: "frontend" }, 1],
  ["partial backend activation", { backendUpFail: true }, 2],
  ["unhealthy backend", { badTargetService: "backend" }, 2],
] as const) {
  test(`reviewed publisher restores exact old images in safe order after ${reason}`, () => {
    const c = runCase({ ...options, changeEnv: true })
    try {
      assert.equal(c.result.status, 1, c.output)
      const updates = c.commands.filter(x => x.command === "docker" && x.args.includes("up"))
      assert.equal(updates.length, targetUpdates + 2)
      const targetCommands = updates.filter(x => !x.args.some(arg => arg.endsWith("/rollback.yaml")))
      const rollbackCommands = updates.filter(x => x.args.some(arg => arg.endsWith("/rollback.yaml")))
      assert.equal(targetCommands.length, targetUpdates)
      if (targetUpdates === 1) assert.ok(!targetCommands.some(x => x.args.at(-1) === "backend"))
      assert.deepEqual(rollbackCommands[0].args.slice(-2), ["runner", "frontend"])
      assert.equal(rollbackCommands[1].args.at(-1), "backend")
      const between = c.commands.slice(c.commands.indexOf(rollbackCommands[0]) + 1, c.commands.indexOf(rollbackCommands[1]))
      for (const service of ["runner", "frontend"]) {
        assert.ok(between.some(x => x.command === "docker" && x.args[0] === "inspect" && x.args.at(-1) === `${service}-id`), `${service} must recover before backend`)
      }
      const env = fs.readFileSync(path.join(c.deploy, ".env"), "utf8")
      assert.equal(env, c.envBefore + "UNRELATED_NEW=value-after-activation\n")
      assert.match(c.output, /previous release restored and verified/)
      assert.doesNotMatch(c.output, /fixture-private-value/)
      assert.equal(fs.existsSync(c.lock), false)
    } finally { c.cleanup() }
  })
}

test("reviewed publisher reports failed rollback verification as a critical failure", () => {
  const c = runCase({ upFail: true, rollbackFail: true })
  try {
    assert.equal(c.result.status, 2, c.output)
    assert.match(c.output, /CRITICAL: rollback verification failed/)
    assert.doesNotMatch(c.output, /previous release restored and verified|fixture-private-value/)
  } finally { c.cleanup() }
})

for (const service of ["runner", "frontend"]) {
  test(`reviewed publisher withholds backend rollback when restored ${service} remains unhealthy`, () => {
    const c = runCase({ backendUpFail: true, badRollbackService: service })
    try {
      assert.equal(c.result.status, 2, c.output)
      const rollbackCommands = c.commands.filter(x => x.command === "docker" && x.args.includes("up") && x.args.some(arg => arg.endsWith("/rollback.yaml")))
      assert.equal(rollbackCommands.length, 1)
      assert.deepEqual(rollbackCommands[0].args.slice(-2), ["runner", "frontend"])
      assert.equal(c.commands.filter(x => x.command === "sleep").length, 24, "bounded first-stage rollback health wait")
      assert.match(c.output, /CRITICAL: rollback verification failed/)
      assert.doesNotMatch(c.output, /previous release restored and verified|fixture-private-value/)
    } finally { c.cleanup() }
  })
}

// These probes use real gzip, POSIX pipes, sh and cat, but a deliberately
// short-reading pg_restore stand-in. They certify stream/error handling,
// not PostgreSQL archive semantics or a real database backup/restore.
function runArchivePipe(options: { oldConsumer?: boolean; restoreExit?: number; drainFail?: boolean; corruptGzip?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siragpt-archive-pipe-"))
  try {
    const payload = Buffer.alloc(8 * 1024 * 1024, 65)
    payload.write("PGDMP")
    const archive = gzipSync(payload)
    if (options.corruptGzip) archive[archive.length - 8] ^= 0xff // corrupt CRC, keep the DEFLATE stream readable
    const dump = path.join(dir, "archive.dump.gz")
    fs.writeFileSync(dump, archive)
    fs.writeFileSync(path.join(dir, "pg_restore"), '#!/bin/sh\nhead -c 5 >/dev/null || exit 8\nprintf "fixture archive TOC\\n"\nexit "${RESTORE_EXIT:-0}"\n', { mode: 0o700 })
    if (options.drainFail) fs.writeFileSync(path.join(dir, "cat"), "#!/bin/sh\nexit 9\n", { mode: 0o700 })
    const validationLine = original.split("\n").find(line => line.startsWith('gzip -dc "$BACKUP/database.dump.gz"'))
    assert.ok(validationLine, "publisher must decompress the validated archive")
    const command = /exec -T db sh -c '([^']+)'/.exec(validationLine)?.[1]
    assert.ok(command, "archive validation and drain must share one database exec shell")
    return spawnSync("bash", ["-o", "pipefail", "-c", 'gzip -dc "$1" | sh -c "$2"', "archive-probe", dump,
      options.oldConsumer ? "pg_restore --list" : command], {
      env: { PATH: `${dir}:${process.env.PATH}`, RESTORE_EXIT: String(options.restoreExit ?? 0) },
      encoding: "utf8", timeout: 10_000,
    })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test("large archive pipe reproduces the old SIGPIPE 141 when pg_restore exits after its TOC", () => {
  const result = runArchivePipe({ oldConsumer: true })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 141, result.stderr)
  assert.equal(result.stdout, "fixture archive TOC\n")
})

test("large archive pipe drains remaining bytes without adding them to the TOC", () => {
  const result = runArchivePipe()
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "fixture archive TOC\n")
})

test("large archive pipe preserves an invalid pg_restore exit code after draining", () => {
  const result = runArchivePipe({ restoreExit: 7 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 7, result.stderr)
})

test("large archive pipe rejects a failed drain rather than hiding it", () => {
  const result = runArchivePipe({ drainFail: true })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stderr)
})

test("large archive pipe preserves gzip corruption failure under pipefail", () => {
  const result = runArchivePipe({ corruptGzip: true })
  assert.equal(result.error, undefined)
  assert.notEqual(result.status, 0, "a successful consumer must not hide a failed decompressor")
  assert.match(result.stderr, /gzip/i)
})
