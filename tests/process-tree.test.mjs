import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
import {execFileSync} from 'node:child_process';
const {runCommand}=await createJiti(import.meta.url).import('../extensions/ralphex/process.ts');
const opts={command:process.execPath,cwd:process.cwd(),timeoutMs:600,killGraceMs:100};
function alive(pid){
  try {process.kill(pid,0);}catch{return false;}
  try{return !execFileSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim().startsWith('Z');}catch{return false;}
}
async function waitDead(pid){for(let i=0;i<40&&alive(pid);i++)await new Promise(r=>setTimeout(r,25));assert.equal(alive(pid),false);}
test('timeout stays a failure even if TERM handler exits zero',async()=>{
 const result=await runCommand({...opts,args:['-e',`process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`]});
 assert.equal(result.code,124);assert.match(result.stderr,/timed out/);
});
test('timeout kills detached descendants after early leader exit and inherited pipes', {skip:process.platform==='win32'}, async()=>{
 for(const inherited of [false,true]) {
  const source=`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:${inherited ? "['ignore',1,2]" : "'ignore'"}});console.log(c.pid);process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
  // Two nested node startups must fit before the kill; 600ms is too tight under parallel test load
  // (leader gets killed before console.log flushes -> empty stdout -> NaN pid).
  const result=await runCommand({...opts,timeoutMs:2000,args:['-e',source]});
  const pid=Number(result.stdout.trim());
  try{assert.ok(pid,`leader did not print descendant pid in time; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr.slice(-200))}`);assert.equal(result.code,124);await waitDead(pid);}finally{try{process.kill(pid,'SIGKILL')}catch{}}
 }
});
test('normal exit and spawn errors settle without timeout side effects',async()=>{
 assert.equal((await runCommand({...opts,args:['-e',"console.log('ok')"]})).code,0);
 assert.notEqual((await runCommand({...opts,command:'pi-toolkit-no-such-executable',args:[]})).code,0);
});
