import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, stat, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { runPiWorker, taskFailures, workerDiagnostic } = await jiti.import(resolve('extensions/ralphex/process.ts'));
const message = (stopReason, errorMessage, text = '') => ({type:'message_end',message:{role:'assistant',stopReason,errorMessage,content:[{type:'text',text}]}});
async function worker(events, extra = '', options = {}) {
  return runPiWorker({cwd:process.cwd(),prompt:'test',idleTimeoutMs:2000,...options,invocation:{command:process.execPath,args:['-e', events.map(e => `console.log(${JSON.stringify(JSON.stringify(e))});`).join('\n') + extra]}});
}
async function cleanup(result) { await rm(dirname(result.logPath), {recursive:true,force:true}); }
for (const reason of ['error','aborted']) test(`${reason} JSON with exit zero is a worker failure`, async () => {
  const result = await worker([message(reason, 'real failure')]);
  try {
    assert.equal(result.code,0);
    assert.equal(result.workerError,'real failure');
    assert.match(workerDiagnostic(result),/real failure/);
    assert.match(taskFailures(result,0,'a','b',[]).join(),/worker error/);
  } finally { await cleanup(result); }
});
test('intermediate error followed by successful response is recovered',async()=>{
  const result = await worker([message('error','temporary'),{type:'auto_retry_start'},message('stop',undefined,'done'),{type:'auto_retry_end',success:true}]);
  try { assert.equal(result.workerError,undefined); assert.deepEqual(taskFailures(result,0,'a','b',[]),[]); }
  finally {await cleanup(result);}
});
test('empty response reports all unmet completion conditions',async()=>{
  const result = await worker([]);
  try {
    assert.deepEqual(taskFailures(result,2,'a','a',['plan.md']),['unclosed checkboxes: 2','no new commit','dirty tree: plan.md']);
    assert.match(workerDiagnostic(result,taskFailures(result,2,'a','a',[])),/empty assistant response/);
    assert.deepEqual(taskFailures(result,0,'a','b',[]),[]);
    assert.deepEqual(taskFailures(result,undefined,'a','b',[]),['task section missing']);
  } finally {await cleanup(result);}
});
test('both attempts retain private redacted logs',async()=>{
  process.env.RALPHEX_TEST_SECRET='sensitive-value-123';
  const first=await worker([message('error','sensitive-value-123')]);
  const second=await worker([message('stop',undefined,'done')]);
  try {
    assert.notEqual(first.logPath,second.logPath);
    for(const result of [first,second]) {
      const log=await readFile(result.logPath,'utf8');
      assert.ok(JSON.parse(log).stdout);
      assert.ok(!log.includes('sensitive-value-123'));
      if(process.platform!=='win32') {
        assert.equal((await stat(result.logPath)).mode & 0o777,0o600);
        assert.equal((await stat(dirname(result.logPath))).mode & 0o777,0o700);
      }
    }
  } finally {delete process.env.RALPHEX_TEST_SECRET; await cleanup(first); await cleanup(second);}
});
test('watchdog kills detached tool descendants too', {skip:process.platform==='win32'}, async()=>{
  const result=await worker([], `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
    console.log('child-pid:'+child.pid);
    setInterval(()=>{},1000);
  `,{idleTimeoutMs:300,killGraceMs:50});
  const pid=Number(result.stdout.match(/child-pid:(\d+)/)?.[1]);
  try {
    assert.ok(pid);
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.throws(()=>process.kill(pid,0));
    assert.match(result.workerError,/watchdog/);
  } finally {try {process.kill(pid,'SIGKILL');} catch {} await cleanup(result);}
});
test('retry exhaustion and aborted without a message retain their cause',async()=>{
  for(const events of [
    [message('aborted')],
    [message('error','temporary'),{type:'auto_retry_end',success:false,finalError:'retry exhausted'}],
    [{type:'message_update',assistantMessageEvent:{type:'error',reason:'error',error:{errorMessage:'stream failure'}}}],
  ]) {
    const result=await worker(events);
    try {assert.match(result.workerError,/aborted|retry exhausted|stream failure/);} finally {await cleanup(result);}
  }
});
test('watchdog kills silent worker',async()=>{
  const result=await worker([], 'setInterval(()=>{},1000)',{idleTimeoutMs:100,killGraceMs:50});
  try {assert.match(result.workerError,/watchdog.*inactivity/);} finally {await cleanup(result);}
});
test('silent active tool is not idle, but separate tool deadline is enforced',async()=>{
  const start={type:'tool_execution_start',toolCallId:'1',toolName:'bash',args:{command:'sleep'}};
  const result=await worker([start],`setTimeout(()=>console.log(JSON.stringify({type:'tool_execution_end',toolCallId:'1'})),250)`,{idleTimeoutMs:100});
  const timed=await worker([start],'setInterval(()=>{},1000)',{idleTimeoutMs:100,toolTimeoutMs:200,killGraceMs:50});
  try { assert.equal(result.workerError,undefined); assert.match(timed.workerError,/tool execution timeout/); }
  finally {await cleanup(result); await cleanup(timed);}
});
