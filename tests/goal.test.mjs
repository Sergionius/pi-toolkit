import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "pi-toolkit-goal-"));
process.env.PI_CODING_AGENT_DIR = temporary;

const jiti = createJiti(import.meta.url);
const [{ default: goalExtension }, state] = await Promise.all([
  jiti.import(join(root, "extensions", "goal", "index.ts")),
  jiti.import(join(root, "extensions", "lib", "codex-state.ts")),
]);

function harness() {
  const handlers = new Map();
  const sent = [];
  const notifications = [];
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerCommand() {},
    registerTool() {},
    sendUserMessage(text, options) { sent.push({ text, options }); },
  };
  const ctx = {
    cwd: "/project",
    sessionManager: { getSessionFile: () => "/session.jsonl" },
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  };
  goalExtension(pi);
  return { ctx, handlers, notifications, sent };
}

function assistant(stopReason) {
  return { role: "assistant", content: [], stopReason };
}

test.after(async () => {
  await rm(temporary, { recursive: true, force: true });
});

test("goal pauses after provider retries settle and does not queue continuations", async () => {
  const { ctx, handlers, notifications, sent } = harness();
  state.setGoal(ctx, "finish the task");

  await handlers.get("agent_end")({ messages: [assistant("error")] }, ctx);
  await handlers.get("agent_end")({ messages: [assistant("error")] }, ctx);
  await handlers.get("agent_settled")({}, ctx);

  const store = JSON.parse(await readFile(join(temporary, "goals.json"), "utf8"));
  const goal = store.goals["/session.jsonl"];
  assert.equal(goal.status, "paused");
  assert.equal(goal.autoTurns, 0, "provider failures must not consume autonomous turns");
  assert.equal(sent.length, 0, "provider failures must not enqueue follow-ups");
  assert.deepEqual(notifications, [{
    message: "Goal paused after a model/provider error. Use /goal resume when the model is available.",
    level: "warning",
  }]);
});

test("successful settled runs start at most one continuation", async () => {
  const { ctx, handlers, sent } = harness();
  state.updateGoalStatus(ctx, "active");

  await handlers.get("agent_start")({}, ctx);
  await handlers.get("agent_end")({ messages: [assistant("stop")] }, ctx);
  await handlers.get("agent_settled")({}, ctx);
  await handlers.get("agent_settled")({}, ctx);

  const store = JSON.parse(await readFile(join(temporary, "goals.json"), "utf8"));
  assert.equal(store.goals["/session.jsonl"].autoTurns, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options, undefined, "settled continuation should start immediately, not enter follow-up queue");
});
