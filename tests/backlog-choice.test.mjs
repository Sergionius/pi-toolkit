import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);

async function loadTool() {
  let tool;
  const imported = await jiti.import(resolve(root, "extensions/backlog-choice.ts"));
  imported.default({ registerTool(definition) { tool = definition; } });
  return tool;
}

function context(hasUI, select) {
  return { hasUI, ui: { select } };
}

const args = { question: "Fix item?", options: ["Fix item", "Leave unchanged"] };

test("backlog choice selects the explicit menu action outside Plan Mode", async () => {
  const tool = await loadTool();
  assert.equal(tool.name, "backlog_choice");
  assert.equal(tool.exposure, "model-only");
  let seen;
  const result = await tool.execute("id", args, undefined, undefined, context(true, async (...values) => {
    seen = values;
    return "Leave unchanged";
  }));
  assert.deepEqual(seen, [args.question, args.options]);
  assert.equal(result.details.selected, "Leave unchanged");
  assert.equal(result.isError, undefined);
});

test("cancellation, missing UI and invalid options never authorize an action", async () => {
  const tool = await loadTool();
  const cancelled = await tool.execute("id", args, undefined, undefined, context(true, async () => undefined));
  assert.equal(cancelled.isError, true);
  assert.equal(cancelled.details, undefined);
  const unavailable = await tool.execute("id", args, undefined, undefined, context(false, () => { throw Error("should not open"); }));
  assert.equal(unavailable.isError, true);
  const invalid = await tool.execute("id", { question: "Fix?", options: ["Yes", "Yes"] }, undefined, undefined, context(true, () => { throw Error("should not open"); }));
  assert.equal(invalid.isError, true);
});

test("backlog skill is bundled with source attribution and Pi-specific commands", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const skill = await readFile(resolve(root, "skills/backlog/SKILL.md"), "utf8");
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.match(skill, /name: backlog/);
  assert.match(skill, /umputun\/cc-thingz/);
  assert.match(skill, /\/skill:backlog --all/);
  assert.match(skill, /backlog_choice/);
  assert.doesNotMatch(skill, /AskUserQuestion|\/workflow:backlog/);
  assert.match(skill, /Never auto-commit/);
  assert.match(skill, /git diff --cached --name-only/);
});
