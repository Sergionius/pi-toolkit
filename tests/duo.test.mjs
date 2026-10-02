import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("duo is bundled as a prompt and delegates Orca coordination to its existing skill", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const prompt = await readFile(resolve(root, "prompts/duo.md"), "utf8");

  assert.deepEqual(manifest.pi.prompts, ["./prompts"]);
  assert.match(prompt, /^---\ndescription: .+\nargument-hint: "\[parallel\] <задача>"\n---/);
  assert.match(prompt, /\$ARGUMENTS/);
  assert.match(prompt, /Если задача отсутствует/);
  assert.match(prompt, /skill `orchestration`/);
  assert.match(prompt, /актуальное руководство из CLI Orca/);
  assert.match(prompt, /Если Orca или Claude недоступны, сообщи о блокировке/);
});

test("duo modes separate writable implementation from read-only parallel research", async () => {
  const prompt = await readFile(resolve(root, "prompts/duo.md"), "utf8");
  assert.match(prompt, /Pi реализует → Claude проверяет → Pi исправляет/);
  assert.match(prompt, /Claude не должен редактировать файлы/);
  assert.match(prompt, /После получения результата Pi оценивает замечания/);
  assert.match(prompt, /Режим `parallel` — независимый анализ без редактирования/);
  assert.match(prompt, /не передавай ему вывод Pi до завершения его анализа/);
  assert.match(prompt, /Никаких правок кода, планов или других файлов/);
  assert.match(prompt, /Не реализуй его без отдельного запроса/);
});
