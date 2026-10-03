import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
const {looksMutating}=await createJiti(import.meta.url).import('../extensions/lib/plan-shell.ts');
test('Plan Mode blocks common writes, compound commands and redirects',()=>{
 for(const cmd of ['npm install','npm ci','pip install foo','python3 -m pip install foo','sed -i s/a/b/ f',"sed -i '' s/a/b/ f",'sed --in-place f','git -C repo rm f','git clean -fd','curl -o output URL','curl --output=output URL','echo hi > file','printf hi >> file','cat f | tee g','ls; rm f','git status && touch f','A=1 git add f','sudo rm f','dd if=a of=b','terraform apply','npx eslint --fix f']) {
  assert.equal(looksMutating(cmd),true,cmd);
 }
});
test('read-only commands, quoted examples and artifact-only builds remain available',()=>{
 for(const cmd of ['git status','git diff --stat','git log -5','npm test','dotnet build','rg "git rm" .',"echo 'npm install'",'printf "a > b"','npm test > /dev/null 2>&1','git status && git diff'])assert.equal(looksMutating(cmd),false,cmd);
});
