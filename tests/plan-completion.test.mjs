import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);
const plan = await jiti.import(join(root, "extensions", "plan", "index.ts"));

test("plan completion menu exposes the four actions in the requested order", () => {
  assert.deepEqual([...plan.PLAN_COMPLETION_CHOICES], [
    "Yes, implement this plan",
    "No, save plan in file",
    "No, rewrite plan in ralphex mode",
    "No, stay in Plan mode",
  ]);
});

test("plan slug transliterates Cyrillic and falls back for punctuation-only titles", () => {
  assert.equal(plan.planSlug("# Экран профиля пользователя\n\nDetails"), "ekran-profilya-polzovatelya");
  assert.equal(plan.planSlug("# !!!"), "plan");
});

test("saving a proposed plan uses the first free numeric suffix", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-plan-save-"));
  try {
    const markdown = "# Экран профиля\n\n## Summary\nДобавить экран.";
    const date = new Date(2026, 7, 30);
    const first = await plan.saveProposedPlan(cwd, markdown, date);
    const second = await plan.saveProposedPlan(cwd, markdown, date);
    const third = await plan.saveProposedPlan(cwd, markdown, date);

    assert.equal(basename(first), "20260830-ekran-profilya.md");
    assert.equal(basename(second), "20260830-ekran-profilya-2.md");
    assert.equal(basename(third), "20260830-ekran-profilya-3.md");
    assert.equal(await readFile(second, "utf8"), `${markdown}\n`);
    assert.doesNotMatch(await readFile(second, "utf8"), /<\/?proposed_plan>/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Ralphex rewrite receives the existing draft and keeps acceptance workflow", () => {
  const prompt = plan.buildRalphexRewritePrompt("# Cache API\n\n## Summary\nAdd caching.");
  assert.match(prompt, /Rewrite the following Codex Plan Mode draft/);
  assert.match(prompt, /# Cache API/);
  assert.match(prompt, /verify it against the repository/);
  assert.match(prompt, /Only after explicit acceptance/);
  assert.match(prompt, /do not implement it/i);
});
