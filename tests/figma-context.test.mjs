import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createJiti} from 'jiti';
const {default:extension}=await createJiti(import.meta.url).import('../extensions/figma-context.ts');

test('Figma cache validates, recovers and refreshes outside repo without replacing good data on errors',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'figma-repo-')), agent=await mkdtemp(join(tmpdir(),'figma-agent-'));
 const oldFetch=global.fetch, oldDir=process.env.PI_CODING_AGENT_DIR, oldToken=process.env.FIGMA_TOKEN;
 process.env.PI_CODING_AGENT_DIR=agent;process.env.FIGMA_TOKEN='fake-test-token';
 let invalid=false, brokenImage=false, requests=0, tool;
 extension({on(){},registerTool(t){tool=t}});
 global.fetch=async url=>{
  requests++;
  if(String(url).includes('/nodes?')) return Response.json({nodes:invalid?{}:{'1:2':{document:{id:'1:2',name:'Frame',type:'FRAME',absoluteBoundingBox:{width:20,height:30}}}}});
  if(String(url).includes('/images/'))return Response.json({images:{'1:2':'https://example.invalid/image'}});
  if(brokenImage)return new Response('unavailable',{status:503});
  return new Response(new Uint8Array([1,2,3]));
 };
 const run=(params={})=>tool.execute('id',{url:'https://www.figma.com/design/ABC/frame?node-id=1-2',...params},undefined,undefined,{cwd});
 try{
  execFileSync('git',['init','-q'],{cwd});
  invalid=true; await assert.rejects(run(),/node not found/);
  invalid=false; const first=await run();const path=first.details.nodeJsonPath;
  assert.ok(path.startsWith(agent));
  const saved=await readFile(path,'utf8');
  const count=requests;await run();assert.equal(requests,count);
  brokenImage=true;await assert.rejects(run({force:true}),/503/);brokenImage=false;
  assert.equal(await readFile(path,'utf8'),saved);
  const cached=await run();assert.equal(cached.details.nodeJsonPath,path);
  const scaled=await run({scale:1});assert.notEqual(scaled.details.screenshotPath,first.details.screenshotPath);
  const jpeg=await run({format:'jpg'});assert.notEqual(jpeg.details.screenshotPath,first.details.screenshotPath);
  await writeFile(path,'{corrupt'); const repaired=await run();assert.notEqual(repaired.details.nodeJsonPath,path);
  await writeFile(repaired.details.nodeJsonPath,'{"nodes":{}}');assert.ok((await run()).details.screenshotPath);
  const refresh=await run({force:true});assert.notEqual(refresh.details.nodeJsonPath,path);
  assert.equal(execFileSync('git',['status','--porcelain'],{cwd,encoding:'utf8'}),'');
 }finally{
  global.fetch=oldFetch;
  if(oldDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldDir;
  if(oldToken===undefined)delete process.env.FIGMA_TOKEN;else process.env.FIGMA_TOKEN=oldToken;
  await rm(cwd,{recursive:true,force:true});await rm(agent,{recursive:true,force:true});
 }
});
