import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);
const zaiStatus = await jiti.import(resolve(root, "extensions/zai-status.ts"));

const { parseQuota, formatQuota, formatReset, fetchQuota, readZaiKey, readZaiCredential } = zaiStatus;

const now = 1_700_000_000_000;
const resetAt = now + 7_500_000; // 2 h 5 min ahead
const fakeResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

test("parseQuota maps known windows and skips unknown units", () => {
  const payload = {
    code: 200,
    success: true,
    data: {
      level: "lite",
      limits: [
        { unit: 3, percentage: 47, usage: 2000, currentValue: 940, nextResetTime: resetAt },
        { unit: 6, percentage: 37, usage: 10000, currentValue: 3746, nextResetTime: resetAt + 1 },
        { unit: 9, percentage: 12, usage: 100, currentValue: 12, nextResetTime: resetAt + 2 },
      ],
    },
  };
  const quota = parseQuota(payload);
  assert.equal(quota.level, "lite");
  assert.deepEqual(quota.windows, [
    { label: "5ч лимит", percentage: 47, used: 940, total: 2000, resetAt },
    { label: "Недельный лимит", percentage: 37, used: 3746, total: 10000, resetAt: resetAt + 1 },
  ]);
  assert.deepEqual(parseQuota({ code: 200, success: true, data: { limits: [] } }).windows, []);
  assert.deepEqual(parseQuota({ code: 200, success: true, data: {} }).windows, []);
});

test("formatQuota renders the Russian card like codex-usage", () => {
  const quota = parseQuota({
    code: 200,
    success: true,
    data: {
      level: "lite",
      limits: [
        { unit: 3, percentage: 47, usage: 2000, currentValue: 940, nextResetTime: resetAt },
        { unit: 6, percentage: 37, usage: 10000, currentValue: 3746, nextResetTime: resetAt },
      ],
    },
  });
  const date = new Date(resetAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const expected = [
    "z.ai: доступен · план lite",
    `5ч лимит: осталось 53% (940/2000), сброс через 2 ч 5 мин (${date})`,
    `Недельный лимит: осталось 63% (3746/10000), сброс через 2 ч 5 мин (${date})`,
  ].join("\n");
  assert.equal(formatQuota(quota, now), expected);
  assert.match(formatQuota({ level: "lite", windows: [] }, now), /план lite/);
});

test("formatQuota flags a reached limit and tolerates missing reset times", () => {
  const card = formatQuota(
    parseQuota({ code: 200, success: true, data: { level: "pro", limits: [{ unit: 3, percentage: 100, usage: 100, currentValue: 100 }] } }),
    now,
  );
  assert.match(card, /лимит достигнут/);
  assert.match(card, /осталось 0%/);
  assert.equal(formatReset(undefined, now), "сброс неизвестен");
});

test("fetchQuota sends the Bearer key in the header, never in errors", async () => {
  const calls = [];
  const doFetch = async (url, options) => {
    calls.push({ url, options });
    return fakeResponse(200, { code: 200, success: true, data: { level: "lite", limits: [{ unit: 3, percentage: 47, usage: 2000, currentValue: 940 }] } });
  };
  const quota = await fetchQuota("fake-key", "https://api.z.ai/test", doFetch);
  assert.equal(quota.level, "lite");
  assert.equal(calls[0].url, "https://api.z.ai/test");
  assert.equal(calls[0].options.headers.Authorization, "Bearer fake-key");
  assert.equal(calls[0].options.headers.Accept, "application/json");

  await assert.rejects(fetchQuota("fake-key", "u", async () => fakeResponse(200, { code: 429, success: false, msg: "rate limited" })),
    (error) => error.message.includes("rate limited") && !error.message.includes("fake-key"));

  await assert.rejects(fetchQuota("fake-key", "u", async () => fakeResponse(500, "boom")),
    (error) => error.message.includes("HTTP 500") && !error.message.includes("fake-key"));
  await assert.rejects(fetchQuota("fake-key", "u", async () => { throw new Error("network down"); }),
    (error) => error.message.includes("не выполнен") && error.message.includes("network down") && !error.message.includes("fake-key"));
  await assert.rejects(fetchQuota("fake-key", "u", async () => fakeResponse(200, "not json")), /невалидный JSON/);
});

test("readZaiKey reads auth.json from the agent dir without leaking the key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zai-status-test-"));
  try {
    await writeFile(join(dir, "auth.json"), JSON.stringify({ zai: { type: "api", key: " fake-key " } }));
    assert.equal(await readZaiKey(dir), "fake-key");
    await writeFile(join(dir, "auth.json"), JSON.stringify({ "zai-coding-cn": { type: "api", key: " fake-cn-key " } }));
    assert.equal(await readZaiKey(dir), "fake-cn-key");
    assert.deepEqual(await readZaiCredential(dir), { key: "fake-cn-key", url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit" });
    await writeFile(join(dir, "auth.json"), JSON.stringify({ zai: { type: "api", key: " fake-key " }, "zai-coding-cn": { type: "api", key: "fake-cn-key" } }));
    assert.deepEqual(await readZaiCredential(dir), { key: "fake-key", url: "https://api.z.ai/api/monitor/usage/quota/limit" });
    await writeFile(join(dir, "auth.json"), '{"zai":');
    await assert.rejects(readZaiKey(dir), /повреждён/);
    await writeFile(join(dir, "auth.json"), JSON.stringify({ openai: {} }));
    await assert.rejects(readZaiKey(dir), /z\.ai ключ не найден в auth\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await assert.rejects(readZaiKey(join(dir, "missing")), /не удалось прочитать auth\.json/);
});
