import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);
const later = await jiti.import(resolve(root, "extensions/later.ts"));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function fakePi() {
  const handlers = [];
  const commands = new Map();
  const userMessages = [];
  const statusSets = [];
  const notifications = [];
  const ui = {
    notify: (message, type) => notifications.push({ message, type }),
    setStatus: (key, text) => statusSets.push({ key, text }),
  };
  return {
    handlers,
    commands,
    userMessages,
    statusSets,
    notifications,
    ui,
    api: {
      getCommands: () => [{ name: "ralphex-exec" }],
      on(event, handler) {
        handlers.push({ event, handler });
      },
      registerCommand(name, definition) {
        commands.set(name, definition);
      },
      sendUserMessage(message, options) {
        userMessages.push({ message, options });
      },
    },
    ctx: { ui, isIdle: () => true, hasPendingMessages: () => false },
  };
}

test("parseDelayMs accepts unit combinations and rejects invalid delays", () => {
  assert.equal(later.parseDelayMs("30s"), 30_000);
  assert.equal(later.parseDelayMs("10m"), 600_000);
  assert.equal(later.parseDelayMs("2h"), 7_200_000);
  assert.equal(later.parseDelayMs("1h30m"), 5_400_000);
  assert.equal(later.parseDelayMs("1h30m10s"), 5_410_000);
  assert.equal(later.parseDelayMs(" 45M "), 2_700_000, "units are case-insensitive");

  assert.equal(later.parseDelayMs(""), null);
  assert.equal(later.parseDelayMs("0s"), null, "zero delay is rejected");
  assert.equal(later.parseDelayMs("5"), null);
  assert.equal(later.parseDelayMs("abc"), null);
  assert.equal(later.parseDelayMs("1h30"), null, "every part needs a unit");
  assert.equal(later.parseDelayMs("25h"), null, "delays above 24h are rejected");
  assert.equal(later.parseDelayMs("24h1s"), null, "delays above 24h are rejected");
});

test("parseLaterArgs covers schedule, list, cancel, and usage branches", () => {
  assert.deepEqual(later.parseLaterArgs("30m /ralphex-exec plan.md"), {
    action: "schedule",
    delayMs: 1_800_000,
    payload: "/ralphex-exec plan.md",
  });
  assert.deepEqual(later.parseLaterArgs("1h30m  check the build status  "), {
    action: "schedule",
    delayMs: 5_400_000,
    payload: "check the build status",
  });

  assert.deepEqual(later.parseLaterArgs("list"), { action: "list" });
  assert.deepEqual(later.parseLaterArgs("cancel 3"), { action: "cancel", target: "3" });
  assert.deepEqual(later.parseLaterArgs("cancel all"), { action: "cancel", target: "all" });

  assert.equal(later.parseLaterArgs("").action, "usage");
  assert.equal(later.parseLaterArgs("cancel").action, "usage");
  assert.equal(later.parseLaterArgs("10m").action, "usage", "a delay without a payload is usage");
  assert.equal(later.parseLaterArgs("banana hello").action, "usage", "an invalid delay is usage");
});

test("formatRemaining renders compact human-readable remaining time", () => {
  assert.equal(later.formatRemaining(0), "0s");
  assert.equal(later.formatRemaining(45_000), "45s");
  assert.equal(later.formatRemaining(270_000), "4m 30s");
  assert.equal(later.formatRemaining(5_400_000), "1h 30m");
  assert.equal(later.formatRemaining(-5), "0s", "elapsed time clamps to zero");
});

test("LaterScheduler fires tasks with payload, removes them, and supports cancellation", async () => {
  const fired = [];
  const scheduler = new later.LaterScheduler((task) => fired.push(task));
  const start = 1_000;
  let now = start;

  const first = scheduler.schedule(5, "/a first", now);
  now += 1;
  const second = scheduler.schedule(10, "b second", now);

  assert.deepEqual(scheduler.list().map((task) => task.id), [first.id, second.id], "list is ordered by fire time");
  assert.equal(scheduler.size, 2);
  assert.equal(scheduler.nextFireAt(), start + 5);

  await sleep(30);
  assert.deepEqual(
    fired.map((task) => task.id),
    [first.id, second.id],
  );
  assert.equal(fired[0].payload, "/a first");
  assert.equal(fired[0].fireAt, start + 5);
  assert.equal(scheduler.size, 0, "fired tasks are removed");
  assert.equal(scheduler.nextFireAt(), null);

  const cancelled = scheduler.schedule(5, "never fires", now);
  assert.deepEqual(scheduler.cancel(cancelled.id), cancelled);
  assert.equal(scheduler.cancel(999), null);
  await sleep(15);
  assert.deepEqual(fired.map((task) => task.id), [first.id, second.id], "cancelled tasks never fire");

  const batch = [scheduler.schedule(5, "x", now), scheduler.schedule(10, "y", now)];
  assert.equal(scheduler.cancelAll().length, 2);
  await sleep(20);
  assert.equal(scheduler.size, 0);
  assert.deepEqual(fired.map((task) => task.id), [first.id, second.id], "cancelAll stops every timer");

  scheduler.clear();
  assert.deepEqual(batch.map((task) => task.id).length, 2, "batch ids are independent");
});

test("later command schedules commands with template expansion and plain messages without it", async () => {
  const pi = fakePi();
  await later.default(pi.api);

  assert.deepEqual([...pi.commands.keys()], ["later"]);
  assert.equal(pi.handlers.filter(({ event }) => event === "session_shutdown").length, 1);

  const handler = pi.commands.get("later").handler;
  await handler("1s /ralphex-exec plan.md", pi.ctx);
  await handler("1s check the build", pi.ctx);
  assert.equal(pi.userMessages.length, 0, "nothing is sent before the delay elapses");
  assert.ok(pi.statusSets.at(-1).text.includes("2 pending"), "status line tracks the queue");

  await sleep(1_200);
  assert.equal(pi.userMessages.length, 2);
  assert.deepEqual(pi.userMessages[0], {
    message: "/ralphex-exec plan.md",
    options: { deliverAs: "followUp", expandPromptTemplates: true },
  });
  assert.deepEqual(pi.userMessages[1], {
    message: "check the build",
    options: { deliverAs: "followUp" },
  }, "plain messages do not expand templates");
  assert.match(pi.notifications[0].message, /^Scheduled \/later #1 in 1s/);
  assert.match(pi.notifications.at(-1).message, /^\/later #2 dispatched: check the build/);
  assert.equal(pi.statusSets.at(-1).text, undefined, "status line clears when the queue empties");
});

test("later command supports list and cancel, and session changes cancel pending tasks", async () => {
  const pi = fakePi();
  await later.default(pi.api);
  const handler = pi.commands.get("later").handler;

  await handler("1h /ralphex-exec plan.md", pi.ctx);
  await handler("2h just a message", pi.ctx);

  await handler("list", pi.ctx);
  const listMessage = pi.notifications.at(-1).message;
  assert.match(listMessage, /#1 in 1h 00m .*\/ralphex-exec plan\.md/);
  assert.match(listMessage, /#2 in 2h 00m .*just a message/);

  await handler("cancel 1", pi.ctx);
  assert.match(pi.notifications.at(-1).message, /^Cancelled \/later #1/);
  await handler("cancel 1", pi.ctx);
  assert.match(pi.notifications.at(-1).message, /^No pending \/later task #1/);
  await handler("cancel all", pi.ctx);
  assert.equal(pi.notifications.at(-1).message, "Cancelled 1 /later task(s).");

  await handler("1h /ralphex-exec plan.md", pi.ctx);
  const switchHandler = pi.handlers.find(({ event }) => event === "session_before_switch").handler;
  await switchHandler({}, pi.ctx);
  assert.match(pi.notifications.at(-1).message, /cancelled 1 pending \/later task\(s\)/);

  await sleep(30);
  assert.equal(pi.userMessages.length, 0, "cancelled tasks are never dispatched");
  assert.equal(pi.statusSets.at(-1).text, undefined, "status line clears after cancellation");

  assert.ok(pi.handlers.some(({ event }) => event === "session_before_fork"), "forks cancel pending tasks too");
  await handler("1h /ralphex-exec plan.md", pi.ctx);
  const shutdownHandler = pi.handlers.find(({ event }) => event === "session_shutdown").handler;
  await shutdownHandler({}, pi.ctx);
  await handler("list", pi.ctx);
  assert.equal(pi.notifications.at(-1).message, "No pending /later tasks.", "shutdown clears the queue");
});
