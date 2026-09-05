import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
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
const state=()=>fs.existsSync(stateFile)?fs.readFileSync(stateFile,'utf8'):'previous';
const fail=()=>{process.stderr.write('fixture-private-value\n');process.exit(1)};
fs.appendFileSync(path.join(root,'commands.jsonl'),JSON.stringify({command,args:a})+'\n');
if(command==='sleep')process.exit(0);
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
  else console.log(c.badContainer||(c.badTargetHealth&&state()==='target')?'running unhealthy':'running healthy');
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
   if(rollback&&c.rollbackFail)fail();
   fs.writeFileSync(stateFile,rollback?'previous':'target');
   if(!rollback&&c.changeEnv)fs.appendFileSync(path.join(root,'deploy','.env'),'UNRELATED_NEW=value-after-activation\n');
   if(!rollback&&c.upFail)fail();process.exit(0);
  }
  if(a.includes('exec')&&a.includes('db')){
   if(a.includes('pg_restore')){if(c.invalidDump||!fs.readFileSync(0,'utf8').startsWith('PGDMP'))fail();console.log('verified fixture archive');}
   else {if(c.dumpFail)fail();console.log('PGDMP fixture');}
   process.exit(0);
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
  for (const command of ["git", "docker", "curl", "sleep"]) {
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
    assert.ok(c.commands.some(x => x.args.includes("pg_restore") && x.args.includes("--list")))
    const updates = c.commands.filter(x => x.command === "docker" && x.args.includes("up"))
    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].args.slice(-3), ["runner", "backend", "frontend"])
    for (const flag of ["--no-deps", "--no-build"]) assert.ok(updates[0].args.includes(flag))
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

for (const options of [{ upFail: true }, { badTargetHealth: true }]) {
  test(`reviewed publisher restores exact old images after ${options.upFail ? "partial activation" : "failed target health"}`, () => {
    const c = runCase({ ...options, changeEnv: true })
    try {
      assert.equal(c.result.status, 1, c.output)
      const updates = c.commands.filter(x => x.command === "docker" && x.args.includes("up"))
      assert.equal(updates.length, 2)
      assert.ok(updates[1].args.some(x => x.endsWith("/rollback.yaml")))
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
