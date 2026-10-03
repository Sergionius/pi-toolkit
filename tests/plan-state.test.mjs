import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,rm,readFile,writeFile,stat,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createJiti} from 'jiti';
const dir=await mkdtemp(join(tmpdir(),'plan-state-test-'));
process.env.PI_CODING_AGENT_DIR=dir;
const state=await createJiti(import.meta.url).import('../extensions/lib/plan-state.ts');
test.after(()=>rm(dir,{recursive:true,force:true}));
const ctx=id=>({cwd:'/test',sessionManager:{getSessionFile:()=>id}});
function writer(prefix){return new Promise((resolvePromise,reject)=>{
 const code=`import {createJiti} from 'jiti';const state=await createJiti(import.meta.url).import(${JSON.stringify(resolve('extensions/lib/plan-state.ts'))});for(let i=0;i<10;i++)await state.setPlanMode({cwd:'/test',sessionManager:{getSessionFile:()=>${JSON.stringify(prefix)}+i}},true);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,PI_CODING_AGENT_DIR:dir},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>code===0?resolvePromise():reject(new Error(err)));
});}
test('concurrent processes retain both sets of updates and prune only inactive old sessions',async()=>{
 await writeFile(state.STATE_PATH,JSON.stringify({planModes:{old:{active:false,updatedAt:1},active:{active:true,updatedAt:1}}}));
 await Promise.all([writer('a'),writer('b')]);
 const store=await state.loadStore();assert.equal(Object.keys(store.planModes).length,21);assert.equal(store.planModes.old,undefined);assert.equal(store.planModes.active.active,true);
 if(process.platform!=='win32')assert.equal((await stat(state.STATE_PATH)).mode&0o777,0o600);
 await state.rememberProposedPlan(ctx('a0'),'draft');assert.equal((await state.currentPlanMode(ctx('a0'))).lastProposedPlan,'draft');
 await writeFile(`${state.STATE_PATH}.crashed.tmp`,'incomplete');
 assert.equal((await state.currentPlanMode(ctx('a0'))).active,true);
});
test('stale lock of a dead owner is reclaimed without discarding valid state; live owner never stolen',async()=>{
 const victim=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await new Promise(r=>setTimeout(r,50)); const deadPid=victim.pid; victim.kill('SIGKILL');
 await new Promise(r=>setTimeout(r,50));
 const lockPath=`${state.STATE_PATH}.lock`;
 // Dead owner + stale mtime: reclaimable.
 await writeFile(lockPath,String(deadPid));
 const old=new Date(Date.now()-60000); await utimes(lockPath,old,old);
 await state.setPlanMode(ctx('recovered'),true);
 assert.equal((await state.currentPlanMode(ctx('recovered'))).active,true);
 assert.equal((await state.currentPlanMode(ctx('a0'))).lastProposedPlan,'draft');
 // Live owner (this process) + stale mtime: never reclaimed, update fails without changes.
 await writeFile(lockPath,String(process.pid));
 await utimes(lockPath,old,old);
 await assert.rejects(state.setPlanMode(ctx('a0'),false),/busy/);
 assert.equal((await state.currentPlanMode(ctx('a0'))).lastProposedPlan,'draft');
 await rm(lockPath,{force:true});
});
test('corrupt state fails closed and is not overwritten',async()=>{
 await writeFile(state.STATE_PATH,'{corrupt');
 await assert.rejects(state.currentPlanMode(ctx('x')),/refusing to assume execution mode/);
 await assert.rejects(state.setPlanMode(ctx('x'),false),/refusing to assume execution mode/);
 assert.equal(await readFile(state.STATE_PATH,'utf8'),'{corrupt');
});
