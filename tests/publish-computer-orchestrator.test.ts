import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const sourcePath = "deploy/iliagpt/publish-computer-orchestrator.sh"
const original = fs.readFileSync(sourcePath, "utf8")
const serviceSource = path.join(process.cwd(), "services/computer-orchestrator")
const workflow = fs.readFileSync(".github/workflows/publish-production.yml", "utf8")
const gitBinary = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
// Actual Bash, Git trees/archives, module hashes, and Node health server. Docker
// lifecycle and public HTTP are command fixtures; this is not deployment proof.
const fixture = String.raw`
const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=process.env.FIXTURE_ROOT,c=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
const command=path.basename(process.argv[1]),a=process.argv.slice(2);
const statePath=path.join(root,'state.json'),s=JSON.parse(fs.readFileSync(statePath,'utf8'));
const save=()=>fs.writeFileSync(statePath,JSON.stringify(s));
const fail=()=>{console.error('fixture-private-value');process.exit(1)};
fs.appendFileSync(path.join(root,'commands.jsonl'),JSON.stringify({command,args:a})+'\n');
if(command==='sleep')process.exit(0);
if(command==='git'){
 if(a[0]==='fetch')process.exit(0);
 if(a[0]==='status'&&c.gitStatusError)fail();
 if(a[0]==='merge-base'&&c.notAncestor)fail();
 const r=cp.spawnSync(c.git,a,{stdio:'inherit'});process.exit(r.status??1);
}
if(command==='curl'){
 if(a.at(-1).endsWith('/api/version')){
  s.versionReads++;save();
  if(c.invalidVersion){console.log('{bad');process.exit(0)}
  console.log(JSON.stringify({commit:c.wrongLive||(c.concurrentLive&&s.versionReads>1)?'c'.repeat(40):c.target}));
 }else{
  const checks=['database','redis','migrations'].map(name=>({name,status:'healthy'}));
  if(c.badReady)checks[0].status='unhealthy';
  if(c.missingCheck)checks.pop();
  if(c.duplicateCheck)checks.push(checks[0]);
  console.log(JSON.stringify({status:'healthy',checks}));
 }
 process.exit(0);
}
const prior='sha256:'+'1'.repeat(64),candidate='sha256:'+'2'.repeat(64),image='siragpt-computer-orchestrator:latest';
const runNode=(imageRoot,code,input)=>{
 const shim=[
  "(function(){ const fs=require('fs'),Module=require('module');",
  "const root=process.env.IMAGE_ROOT;",
  "const mapped=p=>typeof p==='string'&&p.startsWith('/opt/sira-orch/')?root+p.slice('/opt/sira-orch'.length):p==='/usr/local/bin/start-desktop.sh'?root+'/start-desktop.sh':p;",
  "for(const name of ['readFileSync','lstatSync']){const original=fs[name];fs[name]=function(p,...args){return original.call(this,mapped(p),...args)}}",
  "const resolve=Module._resolveFilename;Module._resolveFilename=function(p,...args){return resolve.call(this,mapped(p),...args)}; })();"
 ].join('\n');
 const r=cp.spawnSync(process.execPath,['-e',shim+'\n'+code],{input,encoding:'utf8',timeout:15000,env:{...process.env,IMAGE_ROOT:imageRoot}});
 process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);
};
if(command==='docker'){
 if(a[0]==='compose'){
  if(a.includes('config')){console.log(JSON.stringify({services:{'computer-orchestrator':{image:c.wrongTag?'unexpected:image':image}}}));process.exit(0)}
  if(a.includes('ps')){if(!c.noService)console.log('a'.repeat(64));process.exit(0)}
  if(a.includes('up')){
   const rollback=a.some(x=>x.endsWith('/rollback.yaml'));
   const overlay=a[a.lastIndexOf('-f')+1];
   const contents=fs.readFileSync(overlay,'utf8');
   if(!contents.includes(rollback?prior:candidate))fail();
   if(rollback){s.rollback=true;s.running=prior;save();if(c.rollbackFail)fail();}
   else {s.running=candidate;s.activated=true;save();if(c.upFail)fail();}
   process.exit(0);
  }
 }
 if(a[0]==='inspect'){
  if(a.includes('{{.Image}}'))console.log(c.concurrentImage&&s.built?'sha256:'+'3'.repeat(64):s.running);
  else if(a.includes('{{.Config.Image}}'))console.log(image);
  else console.log(c.badContainer||(s.activated&&!s.rollback&&c.badCandidateHealth)||(s.rollback&&c.badRollbackHealth)?'running unhealthy':'running healthy');
  process.exit(0);
 }
 if(a[0]==='image'&&a[1]==='inspect'){
  if(a.includes('{{.Id}}'))console.log(a.at(-1)===image?(c.divergentTag||(c.concurrentTag&&s.built)?'sha256:'+'4'.repeat(64):s.tag||prior):candidate);
  else console.log(a.at(-1)===prior?(c.alreadyCurrent?c.tree:'old-source'):c.badLabel?'wrong-label':c.tree);
  process.exit(0);
 }
 if(a[0]==='build'){
  const archive=fs.readFileSync(0);fs.writeFileSync(path.join(root,'received.tar'),archive);
  console.log('fixture-private-value');if(c.buildFail)fail();
  fs.mkdirSync(path.join(root,'candidate'),{recursive:true});
  const r=cp.spawnSync('tar',['-xf',path.join(root,'received.tar'),'-C',path.join(root,'candidate')]);if(r.status)fail();
  if(c.tamperedCandidate)fs.appendFileSync(path.join(root,'candidate','docker-runtime.js'),'\n// tampered');
  if(c.tamperedCandidateAsset)fs.appendFileSync(path.join(root,'candidate','desktop-look','applications','qa.desktop'),'changed');
  s.built=true;save();
  if(c.concurrentConfig)fs.appendFileSync(path.join(root,'deploy','compose.yaml'),'# changed\n');
  if(c.concurrentEnv)fs.appendFileSync(path.join(root,'deploy','.env'),'UNRELATED=changed\n');
  if(c.dirtyAfterBuild)fs.writeFileSync(path.join(root,'repo','unexpected.txt'),'dirty');
  process.exit(0);
 }
 if(a[0]==='image'&&a[1]==='tag'){s.tag=a[2];save();if(c.tagFail&&a[2]===candidate)fail();process.exit(0)}
 if(a[0]==='run'){
  const code=a[a.indexOf('-e')+1];
  if(c.smokeFail&&code.includes('createOrchestrator'))fail();
  runNode(path.join(root,'candidate'),code,a.includes('-i')?fs.readFileSync(0):'');
 }
 if(a[0]==='exec'){
  if(c.tagDuringVerify){s.tag='sha256:'+'4'.repeat(64);save();}
  const imageRoot=path.join(root,s.running===prior?'previous':'candidate');
  if(c.liveTamper&&s.activated&&!s.rollback)fs.appendFileSync(path.join(imageRoot,'docker-runtime.js'),'\n// drift');
  runNode(imageRoot,a[a.indexOf('-e')+1],fs.readFileSync(0));
 }
}
fail();
`

type Command = { command: string; args: string[] }
function runCase(options: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sira-orch-publish-"))
  const repo = path.join(dir, "repo"), deploy = path.join(dir, "deploy"), lock = path.join(dir, "lock")
  for (const d of [repo, deploy, path.join(dir, "bin"), path.join(dir, "previous")]) fs.mkdirSync(d)
  const source = path.join(repo, "services/computer-orchestrator")
  fs.mkdirSync(source, { recursive: true })
  for (const name of fs.readdirSync(serviceSource)) {
    if (name.endsWith(".js") || name === "start-desktop.sh") fs.copyFileSync(path.join(serviceSource, name), path.join(source, name))
  }
  fs.mkdirSync(path.join(source, "desktop-look/applications"), { recursive: true })
  fs.writeFileSync(path.join(source, "desktop-look/applications/qa.desktop"), "[Desktop Entry]\nName=QA\n")
  // An additional module proves the manifest is not frozen to today's imports.
  fs.writeFileSync(path.join(source, "extra-runtime.js"), "module.exports = { futureModule: true };\n")
  fs.writeFileSync(path.join(source, "Dockerfile"), "FROM node:22-bookworm\n")
  const git = (...args: string[]) => {
    const r = spawnSync(gitBinary, args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  git("init", "-q"); git("add", ".")
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture source")
  const target = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD:services/computer-orchestrator")
  git("update-ref", "refs/remotes/origin/production-main", target)
  fs.cpSync(source, path.join(dir, "previous"), { recursive: true })
  if (options.tamperedRunning) fs.appendFileSync(path.join(dir, "previous", "extra-runtime.js"), "// stale")
  if (options.dirty) fs.writeFileSync(path.join(repo, "untracked"), "dirty")
  // Ignored bytes must never enter the image build context.
  fs.appendFileSync(path.join(repo, ".git/info/exclude"), "\nlocal-secret.txt\n")
  fs.writeFileSync(path.join(source, "local-secret.txt"), "fixture-private-value")
  const envBefore = "EXISTING_SECRET=fixture-private-value\n", composeBefore = "services: {}\n"
  fs.writeFileSync(path.join(deploy, ".env"), envBefore)
  fs.writeFileSync(path.join(deploy, "compose.yaml"), composeBefore)
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ git: gitBinary, target, tree, ...options }))
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ running: `sha256:${"1".repeat(64)}`, versionReads: 0 }))
  fs.writeFileSync(path.join(dir, "commands.jsonl"), "")
  if (options.locked) fs.mkdirSync(lock)
  const script = original.replace("REPO=/home/user/SiraGPT-APP", `REPO='${repo}'`)
    .replace("DEPLOY=/home/user/deployments/iliagpt", `DEPLOY='${deploy}'`)
    .replace("LOCK=/tmp/siragpt-publish.lock", `LOCK='${lock}'`)
  fs.writeFileSync(path.join(dir, "publish.sh"), script)
  for (const name of ["git", "docker", "curl", "sleep"]) fs.writeFileSync(path.join(dir, "bin", name), `#!${process.execPath}\n${fixture}`, { mode: 0o700 })
  const result = spawnSync("bash", [path.join(dir, "publish.sh"), options.invalidTarget ? "invalid" : target], {
    env: { PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, FIXTURE_ROOT: dir }, encoding: "utf8", timeout: 30_000,
  })
  const commands: Command[] = fs.readFileSync(path.join(dir, "commands.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s))
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"))
  const evidence = fs.existsSync(path.join(deploy, "backups")) ? fs.readdirSync(path.join(deploy, "backups")).map(n => path.join(deploy, "backups", n)) : []
  return { dir, deploy, lock, target, tree, result, commands, state, evidence, envBefore, composeBefore,
    output: result.stdout + result.stderr, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
const updates = (commands: Command[]) => commands.filter(c => c.command === "docker" && c.args.includes("up"))

test("production workflow verifies orchestrator even when the app SHA is already live", () => {
  const checkout = workflow.slice(workflow.indexOf("      - name: Fast-forward"), workflow.indexOf("      - name: Publish ("))
  assert.doesNotMatch(checkout, /if: steps\.live\.outputs\.sha/)
  assert.match(checkout, /git merge-base --is-ancestor "\$LIVE" "\$TARGET"/)
  const orchestrator = workflow.slice(workflow.indexOf("      - name: Publish and verify the existing computer orchestrator"), workflow.indexOf("      - name: Verify public release"))
  assert.match(orchestrator, /bash "\$REPO\/deploy\/iliagpt\/publish-computer-orchestrator.sh" "\$TARGET"/)
  assert.doesNotMatch(orchestrator, /if:|continue-on-error|\|\| true/)
  assert.ok(workflow.indexOf("Confirm CI for the exact tree") < workflow.indexOf("Publish and verify the existing computer orchestrator"))
})

test("computer publisher is valid Bash, scoped to one existing service", () => {
  assert.equal(spawnSync("bash", ["-n"], { input: original }).status, 0)
  assert.doesNotMatch(original, /down -v|reset --hard|system prune|docker logs|docker restart|sira-ac-user-/)
})

for (const [name, options] of Object.entries({
  "dirty checkout": { dirty: true }, "status read fails": { gitStatusError: true }, "outside production ancestry": { notAncestor: true },
  "wrong live release": { wrongLive: true }, "invalid version JSON": { invalidVersion: true }, "unhealthy readiness": { badReady: true },
  "missing readiness check": { missingCheck: true }, "duplicate readiness check": { duplicateCheck: true },
  "service absent": { noService: true }, "unhealthy baseline": { badContainer: true }, "unexpected service tag": { wrongTag: true }, "divergent running tag": { divergentTag: true },
  "build failure": { buildFail: true }, "candidate label mismatch": { badLabel: true }, "candidate bytes mismatch": { tamperedCandidate: true }, "candidate asset mismatch": { tamperedCandidateAsset: true },
  "offline smoke failure": { smokeFail: true }, "release changes during build": { concurrentLive: true },
  "checkout changes during build": { dirtyAfterBuild: true }, "container image changes during build": { concurrentImage: true },
  "compose changes during build": { concurrentConfig: true }, "environment changes during build": { concurrentEnv: true }, "tag changes during build": { concurrentTag: true }, "tag changes during no-op verification": { alreadyCurrent: true, tagDuringVerify: true },
})) test(`computer publisher refuses ${name} before activation`, () => {
  const c = runCase(options)
  try {
    assert.equal(c.result.status, 1, c.output)
    assert.equal(updates(c.commands).length, 0)
    assert.equal(fs.existsSync(c.lock), false)
    assert.doesNotMatch(c.output, /fixture-private-value/)
    assert.equal(fs.readFileSync(path.join(c.deploy, ".env"), "utf8"), c.envBefore + ("concurrentEnv" in options ? "UNRELATED=changed\n" : ""))
  } finally { c.cleanup() }
})

test("lock and invalid SHA stop without commands or altering someone else's lock", () => {
  for (const options of [{ locked: true }, { invalidTarget: true }]) {
    const c = runCase(options)
    try { assert.equal(c.result.status, 1); assert.equal(c.commands.length, 0); assert.equal(fs.existsSync(c.lock), "locked" in options) }
    finally { c.cleanup() }
  }
})

test("matching running source, actual bytes and health avoid a build or activation", () => {
  const c = runCase({ alreadyCurrent: true })
  try {
    assert.equal(c.result.status, 0, c.output)
    assert.match(c.output, /no update required/)
    assert.equal(updates(c.commands).length, 0)
    assert.ok(!c.commands.some(x => x.args[0] === "build"))
    assert.ok(c.commands.some(x => x.args[0] === "exec"))
  } finally { c.cleanup() }
})

for (const options of [{}, { alreadyCurrent: true, tamperedRunning: true }]) test(`exact source archive publishes only the existing orchestrator (${JSON.stringify(options)})`, () => {
  const c = runCase(options)
  try {
    assert.equal(c.result.status, 0, c.output)
    assert.equal(updates(c.commands).length, 1)
    const update = updates(c.commands)[0]
    assert.equal(update.args.at(-1), "computer-orchestrator")
    assert.ok(update.args.includes("--no-deps") && update.args.includes("--no-build"))
    assert.ok(update.args.some(a => a.endsWith("/activate.yaml")))
    assert.equal(c.state.running, `sha256:${"2".repeat(64)}`)
    assert.equal(fs.readFileSync(path.join(c.deploy, ".env"), "utf8"), c.envBefore)
    assert.equal(fs.readFileSync(path.join(c.deploy, "compose.yaml"), "utf8"), c.composeBefore)
    assert.ok(!fs.existsSync(path.join(c.dir, "candidate", "local-secret.txt")))
    const manifest = fs.readFileSync(path.join(c.evidence[0], "manifest"), "utf8")
    assert.match(manifest, /extra-runtime\.js/)
    assert.match(manifest, /desktop-look\/applications\/qa\.desktop/)
    for (const module of fs.readdirSync(serviceSource).filter(n => n.endsWith(".js"))) assert.ok(manifest.includes(`/opt/sira-orch/${module}`), module)
    for (const run of c.commands.filter(x => x.args[0] === "run")) {
      assert.deepEqual(run.args.slice(0, 5), ["run", "--rm", "--network", "none", "--read-only"])
      assert.ok(!run.args.includes("-v") && !run.args.includes("--mount") && !run.args.includes("--env") && !run.args.includes("--env-file"))
    }
    assert.equal(fs.statSync(c.evidence[0]).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(c.evidence[0], "publish.log")).mode & 0o777, 0o600)
    assert.doesNotMatch(c.output, /fixture-private-value/)
  } finally { c.cleanup() }
})

for (const options of [{ upFail: true }, { badCandidateHealth: true }, { liveTamper: true }]) test(`failed activation restores immutable previous image (${JSON.stringify(options)})`, () => {
  const c = runCase(options)
  try {
    assert.equal(c.result.status, 1, c.output)
    assert.equal(updates(c.commands).length, 2)
    assert.ok(updates(c.commands)[1].args.some(a => a.endsWith("/rollback.yaml")))
    assert.equal(c.state.running, `sha256:${"1".repeat(64)}`)
    assert.equal(c.state.tag, `sha256:${"1".repeat(64)}`)
    assert.match(c.output, /previous orchestrator image restored and verified/)
    assert.doesNotMatch(c.output, /fixture-private-value/)
  } finally { c.cleanup() }
})

for (const options of [{ upFail: true, rollbackFail: true }, { upFail: true, badRollbackHealth: true }]) test(`rollback failure stays visible (${JSON.stringify(options)})`, () => {
  const c = runCase(options)
  try { assert.equal(c.result.status, 2, c.output); assert.match(c.output, /CRITICAL/); assert.equal(fs.existsSync(c.lock), false) }
  finally { c.cleanup() }
})
