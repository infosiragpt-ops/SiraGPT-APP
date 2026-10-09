'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createResearchRuns}=require('../src/services/research-runs');
function fixture() {
  const records=new Map(), cancels=new Set(), messages=new Map(); let calls=0, finish;
  const store={createRunId:()=> 'rr_generated',loadRun:id=>structuredClone(records.get(id)||null),saveRun:run=>records.set(run.id,structuredClone(run)),claimRun:run=>{if(records.has(run.id))return false;records.set(run.id,structuredClone(run));return true},appendEvent:()=>{},requestCancel:id=>cancels.add(id),isCancelled:id=>cancels.has(id)};
  const prisma={chat:{findFirst:async ({where})=>where.userId==='owner'&&where.id==='chat'?{id:'chat'}:null,update:async()=>{}},message:{findFirst:async()=>({id:'user-message'}),upsert:async ({where,create})=>{messages.set(where.id,messages.get(where.id)||create)}},$transaction:async fn=>fn(prisma)};
  const agent={run:async ({signal})=>{calls++; return new Promise((resolve,reject)=>{finish=resolve;signal.addEventListener('abort',()=>reject(Object.assign(new Error('abort'),{name:'AbortError'})),{once:true})})}};
  const runs=createResearchRuns({store,prisma,agent,resolveModel:async()=>({})});
  return {runs,store,records,messages,finish:result=>finish(result),calls:()=>calls};
}
const input={runId:'rr_test',chatId:'chat',query:'research query',model:'chosen',provider:'chosen-provider'};
const result={report:'# Research report',papers:[],findings:[],stats:{papersFound:0}};
test('disconnect/retry keeps one run, stores final assistant before announcing report',async()=>{
  const f=fixture(); const events=[];
  const listener=event=>{if(event.type==='report') assert.equal(f.messages.size,1);events.push(event)};
  await f.runs.start('owner',input,listener); const task=f.runs.active.get(input.runId).promise;
  f.runs.detach(input.runId,listener);
  await f.runs.start('owner',input,listener);
  assert.equal(f.calls(),1);
  f.finish(result);await task;
  assert.equal((await f.runs.get(input.runId,'owner')).status,'completed');assert.equal(f.messages.size,1);
  await f.runs.get(input.runId,'owner');assert.equal(f.messages.size,1);
  assert.ok(events.some(e=>e.type==='report'));
});
test('rejects cross-owner reads/cancellation and conflicting reuse',async()=>{
  const f=fixture();await f.runs.start('owner',input);const task=f.runs.active.get(input.runId).promise;
  await assert.rejects(f.runs.get(input.runId,'stranger'),{status:404});
  await assert.rejects(f.runs.cancel(input.runId,'stranger'),{status:404});
  await assert.rejects(f.runs.start('owner',{...input,query:'different query'}),{status:409});
  await f.runs.cancel(input.runId,'owner');await task;
});
test('stop persists cancellation, aborts work and never publishes an assistant report',async()=>{
  const f=fixture();await f.runs.start('owner',input);const task=f.runs.active.get(input.runId).promise;
  assert.equal((await f.runs.cancel(input.runId,'owner')).status,'cancelled');await task;
  assert.equal((await f.runs.get(input.runId,'owner')).status,'cancelled');assert.equal(f.messages.size,0);
});
test('recovers the persist-result/DB-commit crash gap without re-running the model',async()=>{
  const f=fixture();f.store.saveRun({id:input.runId,userId:'owner',chatId:'chat',status:'running',createdAt:1,heartbeatAt:1,result});
  assert.equal((await f.runs.get(input.runId,'owner')).status,'completed');
  assert.equal(f.messages.size,1);assert.equal(f.calls(),0);
});
test('a restarted run with no result becomes explicitly interrupted, not running forever',async()=>{
  const f=fixture();f.store.saveRun({id:input.runId,userId:'owner',chatId:'chat',status:'running',createdAt:1,heartbeatAt:1});
  assert.equal((await f.runs.get(input.runId,'owner')).status,'failed');assert.equal(f.calls(),0);
});
