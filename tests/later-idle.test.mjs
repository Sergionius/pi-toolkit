import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const { default: later } = await createJiti(import.meta.url).import('../extensions/later.ts');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness(t) {
  const events = new Map(), commands = new Map(), sent = [], statuses = [], notices = [], compact = [];
  let idle = false;
  const ctx = {
    ui: { notify: message => notices.push(message), setStatus: (_, text) => statuses.push(text) },
    isIdle: () => idle, hasPendingMessages: () => false,
    compact: options => compact.push(options),
  };
  later({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    getCommands: () => [{name: 'probe'}],
    sendUserMessage: (...args) => sent.push(args),
  });
  t.after(() => events.get('session_shutdown')());
  return { ctx, sent, statuses, notices, compact, events,
    run: args => commands.get('later').handler(args, ctx),
    idle: () => { idle = true; },
  };
}

test('expired commands wait for idle and remain cancellable', async t => {
  const h = harness(t);
  await h.run('1s /probe cancelled');
  await h.run('1s /probe execute');
  await sleep(1200);
  assert.equal(h.sent.length, 0);
  await h.run('list');
  assert.match(h.notices.at(-1), /#1/);
  await h.run('cancel 1');
  h.idle();
  await sleep(400);
  assert.deepEqual(h.sent.map(([text]) => text), ['/probe execute']);
});

test('countdown updates and shutdown cancels overdue work', async t => {
  const h = harness(t);
  await h.run('1s /probe never');
  await sleep(1200);
  assert.ok(h.statuses.some(text => text?.includes('waiting for idle')));
  h.events.get('session_shutdown')();
  h.idle();
  await sleep(400);
  assert.equal(h.sent.length, 0);
  assert.equal(h.statuses.at(-1), undefined);
});

test('compact uses its API, unsupported builtins never become prompts', async t => {
  const h = harness(t);
  h.idle();
  await h.run('1s /quit');
  assert.match(h.notices.at(-1), /Unsupported command/);
  await h.run('1s /compact preserve decisions');
  await sleep(1200);
  assert.equal(h.sent.length, 0);
  assert.equal(h.compact.length, 1);
  assert.equal(h.compact[0].customInstructions, 'preserve decisions');
  h.compact[0].onComplete();
});
