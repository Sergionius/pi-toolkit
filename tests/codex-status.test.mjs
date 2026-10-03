import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createJiti} from 'jiti';
const {codexRequest,DEFAULT_CODEX_USER_AGENT,parseUsage}=await createJiti(import.meta.url).import('../extensions/codex-status.ts');
test('usage/reset bridge passes configurable UA and secrets only through env',async()=>{
 const previous=process.env.PI_CODEX_USER_AGENT;
 try {
  delete process.env.PI_CODEX_USER_AGENT;
  const calls=[];
  const runner=async options=>{calls.push(options);return {code:0,stdout:'{}',stderr:''}};
  await codexRequest('script',{PI_CODEX_ACCESS_TOKEN:'fake-token',PI_CODEX_USAGE_URL:'usage'},runner);
  process.env.PI_CODEX_USER_AGENT='codex-cli/test';
  await codexRequest('script',{PI_CODEX_ACCESS_TOKEN:'fake-token',PI_CODEX_RESET_URL:'reset'},runner);
  assert.equal(calls[0].env.PI_CODEX_USER_AGENT,DEFAULT_CODEX_USER_AGENT);
  assert.equal(calls[1].env.PI_CODEX_USER_AGENT,'codex-cli/test');
  assert.ok(!JSON.stringify(calls[0].args).includes('fake-token'));
  assert.equal(calls[0].timeoutMs,25000);
 } finally {if(previous===undefined)delete process.env.PI_CODEX_USER_AGENT;else process.env.PI_CODEX_USER_AGENT=previous;}
});
test('HTTP/timeout failures redact credentials and are never retried',async()=>{
 for(const code of [1,124]){
  let calls=0;
  await assert.rejects(codexRequest('script',{PI_CODEX_ACCESS_TOKEN:'fake-sensitive'},async()=>{calls++;return {code,stderr:'HTTP failure fake-sensitive',stdout:''}}),e=>!e.message.includes('fake-sensitive')&&e.message.includes('[REDACTED]'));
  assert.equal(calls,1);
 }
 assert.throws(()=>parseUsage('secret not valid json'),/invalid JSON/);
 assert.throws(()=>parseUsage('null'),/invalid JSON/);
 assert.deepEqual(parseUsage('{"plan":"test"}'),{plan:'test'});
 const source=await readFile(new URL('../extensions/codex-status.ts',import.meta.url),'utf8');
 assert.equal((source.match(/"User-Agent": os.environ\["PI_CODEX_USER_AGENT"\]/g)||[]).length,2);
});
