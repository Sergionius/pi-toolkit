import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const prompt = (name) => readFile(resolve(root, `prompts/${name}.md`), "utf8");

test("duo, parallel and discuss are separately bundled prompts", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.prompts, ["./prompts"]);

  for (const name of ["duo", "parallel", "discuss"]) {
    const text = await prompt(name);
    assert.match(text, /^---\ndescription: .+\nargument-hint: "<задача>"\n---/);
    assert.match(text, /\$ARGUMENTS/);
    assert.match(text, /Если задача отсутствует/);
    assert.match(text, /ничего не запускай/);
    assert.match(text, /skill `orchestration`/);
    assert.match(text, /актуальное руководство из CLI Orca/);
    assert.match(text, /Если Orca или Claude недоступны, сообщи о блокировке/);
  }
});

test("duo implements with read-only Claude review, without mode routing", async () => {
  const text = await prompt("duo");
  assert.match(text, /Pi реализует → Claude проверяет → Pi исправляет/);
  assert.match(text, /Claude не должен редактировать файлы/);
  assert.match(text, /После получения результата Pi оценивает замечания/);
  assert.match(text, /только `parallel` либо `discuss`, ничего не запускай/);
  assert.match(text, /Весь остальной текст — задача для реализации с ревью/);
  assert.doesNotMatch(text, /Первое слово `parallel`|Режим `parallel`|Режим `discuss`/);
});

test("parallel keeps both analyses independent and read-only", async () => {
  const text = await prompt("parallel");
  assert.match(text, /не передавай ему вывод Pi до завершения его анализа/);
  assert.match(text, /Пока Claude работает, Pi независимо исследует/);
  assert.match(text, /Никаких правок кода, планов или других файлов, коммитов, релизов и пушей/);
  assert.match(text, /Не реализуй его без отдельного запроса/);
  assert.doesNotMatch(text, /Pi реализует → Claude проверяет/);
});

test("discuss exchanges arguments after independent research without editing files", async () => {
  const text = await prompt("discuss");
  assert.match(text, /не передавай ему вывод Pi до завершения его анализа/);
  assert.match(text, /Дождись завершения независимого анализа обоих/);
  assert.match(text, /не более одного дополнительного раунда обмена/);
  assert.match(text, /follow-up к завершённому воркеру или создания новой задачи/);
  assert.match(text, /неразрешённые расхождения/);
  assert.match(text, /Никаких правок кода, планов или других файлов, коммитов, релизов и пушей/);
  assert.doesNotMatch(text, /Pi реализует → Claude проверяет/);
});

test("README documents each command separately and no longer recommends duo submodes", async () => {
  const readme = await readFile(resolve(root, "README.md"), "utf8");
  for (const name of ["duo", "parallel", "discuss"]) {
    assert.ok(readme.includes(`### \`/${name}\``));
    assert.match(readme, new RegExp(`/${name} (?:fix|investigate)`));
  }
  assert.doesNotMatch(readme, /\/duo (?:parallel|discuss) /);
});
