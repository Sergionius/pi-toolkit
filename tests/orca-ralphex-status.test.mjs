import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);
const extension = await jiti.import(resolve(root, "extensions/orca-ralphex-status.ts"));

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

test("Ralphex child-process lifecycle keeps Orca busy across UI prompts", async () => {
  const previous = {
    endpoint: process.env.ORCA_AGENT_HOOK_ENDPOINT,
    port: process.env.ORCA_AGENT_HOOK_PORT,
    token: process.env.ORCA_AGENT_HOOK_TOKEN,
    pane: process.env.ORCA_PANE_KEY,
    fetch: globalThis.fetch,
  };
  const posts = [];
  const handlers = new Map();
  const events = new Map();

  delete process.env.ORCA_AGENT_HOOK_ENDPOINT;
  process.env.ORCA_AGENT_HOOK_PORT = "1234";
  process.env.ORCA_AGENT_HOOK_TOKEN = "token";
  process.env.ORCA_PANE_KEY = "pane";
  globalThis.fetch = async (_url, init) => {
    posts.push(JSON.parse(init.body).payload);
    return { ok: true };
  };

  try {
    extension.default({
      on(name, handler) { handlers.set(name, handler); },
      events: { on(name, handler) { events.set(name, handler); } },
    });
    handlers.get("session_start")({}, {
      sessionManager: {
        getSessionId: () => "session-id",
        getSessionFile: () => "/tmp/session.jsonl",
      },
    });

    events.get("ralphex:started")({ name: "Ralphex auto" });
    await delay(10);
    handlers.get("ui_prompt_end")();
    await delay(80);
    events.get("ralphex:completed")();
    await delay(10);

    assert.deepEqual(posts.map(({ hook_event_name }) => hook_event_name), [
      "before_agent_start",
      "agent_start",
      "agent_start",
      "agent_end",
    ]);
    assert.equal(posts[0].prompt, "Ralphex auto");
    assert.equal(posts[0].session_id, "session-id");
  } finally {
    if (previous.endpoint === undefined) delete process.env.ORCA_AGENT_HOOK_ENDPOINT;
    else process.env.ORCA_AGENT_HOOK_ENDPOINT = previous.endpoint;
    if (previous.port === undefined) delete process.env.ORCA_AGENT_HOOK_PORT;
    else process.env.ORCA_AGENT_HOOK_PORT = previous.port;
    if (previous.token === undefined) delete process.env.ORCA_AGENT_HOOK_TOKEN;
    else process.env.ORCA_AGENT_HOOK_TOKEN = previous.token;
    if (previous.pane === undefined) delete process.env.ORCA_PANE_KEY;
    else process.env.ORCA_PANE_KEY = previous.pane;
    globalThis.fetch = previous.fetch;
  }
});
