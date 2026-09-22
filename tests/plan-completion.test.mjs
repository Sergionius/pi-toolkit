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

    assert.equal(basename(first), "2026-08-30-ekran-profilya.md");
    assert.equal(basename(second), "2026-08-30-ekran-profilya-2.md");
    assert.equal(basename(third), "2026-08-30-ekran-profilya-3.md");
    assert.equal(await readFile(second, "utf8"), `${markdown}\n`);
    assert.doesNotMatch(await readFile(second, "utf8"), /<\/?proposed_plan>/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Ralphex draft extraction and saving reuse exact plans without overwriting collisions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ralphex-save-"));
  try {
    const firstDraft = "# Cache API\n\n## Goal\nAdd caching.";
    const secondDraft = "# Cache API\n\n## Goal\nUse a different cache.";
    assert.equal(
      plan.extractRalphexDraft(`Before\n<ralphex_plan>\n${firstDraft}\n</ralphex_plan>\nAfter`),
      firstDraft,
    );

    const first = await plan.saveRalphexDraft(cwd, firstDraft, new Date(2026, 8, 22));
    const duplicate = await plan.saveRalphexDraft(cwd, `\n${firstDraft}\n`, new Date(2026, 8, 22));
    const collision = await plan.saveRalphexDraft(cwd, secondDraft, new Date(2026, 8, 22));

    assert.equal(basename(first.path), "2026-09-22-cache-api.md");
    assert.equal(first.created, true);
    assert.deepEqual(duplicate, { path: first.path, created: false });
    assert.equal(basename(collision.path), "2026-09-22-cache-api-2.md");
    assert.equal(collision.created, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Ralphex rewrite receives the existing draft and keeps client-side acceptance", () => {
  const prompt = plan.buildRalphexRewritePrompt("# Cache API\n\n## Summary\nAdd caching.");
  assert.match(prompt, /Rewrite the following Codex Plan Mode draft/);
  assert.match(prompt, /# Cache API/);
  assert.match(prompt, /verify it against the repository/);
  assert.match(prompt, /<ralphex_plan>/);
  assert.match(prompt, /Never save the plan yourself/);
  assert.match(prompt, /do not implement it/i);
});
