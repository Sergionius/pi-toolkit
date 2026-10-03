import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm,mkdir,symlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {redactValue,redactDiagnostic}=await jiti.import('../extensions/ralphex/diagnostics.ts');
const {createWorkerLog,pruneWorkerLogs}=await jiti.import('../extensions/ralphex/worker-logs.ts');
const {workerDiagnostic,taskFailures}=await jiti.import('../extensions/ralphex/process.ts');

test('redaction preserves JSON, recursively handles JSON strings and incomplete text',()=>{
  const secret='review-only-secret-123';
  const source={stdout:[JSON.stringify({api_key:secret}), JSON.stringify({message:{content:JSON.stringify({password:secret})}}), `Bearer ${secret}`, `password=${secret}`, `{"token":"${secret}`].join('\n'),stderr:`secret=${secret}`};
  const redacted=JSON.stringify(redactValue(source));
  assert.ok(!redacted.includes(secret));
  assert.ok(source.stdout.includes(secret),'execution data must not be mutated');
  assert.ok(JSON.parse(redacted));
  assert.ok(!redactDiagnostic(`{\\"api_key\\":\\"${secret}\\"}`).includes(secret));
  const result={code:0,stdout:'',stderr:'',assistantText:'',workerError:`password=${secret}`};
  const diagnostic=workerDiagnostic(result,taskFailures(result,1,'a','a',[]));
  assert.equal(diagnostic.match(/worker error:/g).length,1);
  assert.ok(!diagnostic.includes(secret));
});

test('retention removes only old completed attempts, preserving active, foreign, symlink and recent logs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'retention-test-'));
  const outside=await mkdtemp(join(tmpdir(),'retention-outside-'));
  try {
    const old=createWorkerLog(root); old.finish({stdout:'done'});
    await writeFile(join(dirname(old.path),'completed.json'),JSON.stringify({owner:'pi-toolkit-worker',at:1}));
    const active=createWorkerLog(root,100000); // avoid automatic pruning before assertions
    const recent=createWorkerLog(root,100000); recent.finish({stdout:'done'});
    const foreign=join(root,'attempt-foreign'); await mkdir(foreign); await writeFile(join(foreign,'completed.json'),JSON.stringify({owner:'someone-else',at:1}));
    await symlink(outside,join(root,'attempt-link'));
    await writeFile(join(outside,'keep'),'keep');
    pruneWorkerLogs(root,7);
    await assert.rejects(stat(old.path),{code:'ENOENT'});
    assert.ok(await stat(dirname(active.path)));
    assert.ok(await stat(recent.path));
    assert.ok(await stat(foreign));
    assert.equal(await readFile(join(outside,'keep'),'utf8'),'keep');
    if(process.platform!=='win32') assert.equal((await stat(recent.path)).mode & 0o777,0o600);
    assert.throws(()=>createWorkerLog(root,0),/positive/);
  } finally {await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
