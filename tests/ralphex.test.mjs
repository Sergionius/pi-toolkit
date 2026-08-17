import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);
const planModule = await jiti.import(resolve(root, "extensions/ralphex/plan.ts"));
const prompts = await jiti.import(resolve(root, "extensions/ralphex/prompts.ts"));
const ralphex = await jiti.import(resolve(root, "extensions/ralphex/index.ts"));

const sample = `# Feature

## Implementation Steps

### Task 1: First task

- [x] done
- [ ] pending

### Task 2: Second task

- [ ] another

## Acceptance Criteria
- no task checkbox
`;

test("ralphex commands resolve both full plan paths and bare filenames", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-resolve-"));
  try {
    const plans = join(temporary, "docs", "plans");
    await mkdir(plans, { recursive: true });
    const plan = join(plans, "20260817-feature.md");
    await writeFile(plan, sample, "utf8");
    assert.equal(await ralphex.resolveRequestedPlan(temporary, "20260817-feature.md"), plan);
    assert.equal(await ralphex.resolveRequestedPlan(temporary, "docs/plans/20260817-feature.md"), plan);
    await assert.rejects(() => ralphex.resolveRequestedPlan(temporary, "missing.md"), /plan file not found/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ralphex-loop discovers both incomplete and review-ready active plans", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-loop-select-"));
  try {
    const plans = join(temporary, "docs", "plans");
    await mkdir(plans, { recursive: true });
    await writeFile(join(plans, "incomplete.md"), sample, "utf8");
    const ready = planModule.ensureBaseCommit(sample.replaceAll("[ ]", "[x]"), "abcdef1234567890");
    await writeFile(join(plans, "ready.md"), ready, "utf8");
    const selections = [];
    const ctx = {
      cwd: temporary,
      ui: {
        select: async (_title, options) => {
          selections.push(options);
          return "docs/plans/ready.md";
        },
      },
    };

    const loopPlan = await ralphex.resolvePlan("", ctx, "loop");
    assert.equal(loopPlan.path, join(plans, "ready.md"));
    assert.deepEqual(selections[0], ["docs/plans/incomplete.md", "docs/plans/ready.md"]);
    assert.equal((await ralphex.resolvePlan("", { ...ctx, ui: { select: async () => undefined } }, "exec")).path, join(plans, "incomplete.md"));
    assert.equal((await ralphex.resolvePlan("", { ...ctx, ui: { select: async () => undefined } }, "review")).path, join(plans, "ready.md"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("completed plan move force-adds plans ignored by the repository", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-move-"));
  const git = (...args) => execFileSync("git", args, { cwd: temporary, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "ralphex@example.test");
    git("config", "user.name", "Ralphex Test");
    await writeFile(join(temporary, ".gitignore"), "docs/\n", "utf8");
    git("add", ".gitignore");
    git("commit", "-qm", "initial");

    const plans = join(temporary, "docs", "plans");
    await mkdir(plans, { recursive: true });
    const source = join(plans, "feature.md");
    await writeFile(source, sample.replaceAll("[ ]", "[x]"), "utf8");
    git("add", "-f", "docs/plans/feature.md");
    git("commit", "-qm", "feat: implementation");

    const target = await ralphex.moveCompletedPlan(temporary, source);
    assert.equal(await readFile(target, "utf8"), sample.replaceAll("[ ]", "[x]"));
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(git("log", "-1", "--pretty=%s"), "move completed plan: feature.md");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("completed plan move recovers when the source deletion is already staged", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-move-recovery-"));
  const git = (...args) => execFileSync("git", args, { cwd: temporary, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "ralphex@example.test");
    git("config", "user.name", "Ralphex Test");
    await writeFile(join(temporary, ".gitignore"), "docs/\n", "utf8");
    git("add", ".gitignore");
    git("commit", "-qm", "initial");

    const plans = join(temporary, "docs", "plans");
    const completed = join(plans, "completed");
    await mkdir(completed, { recursive: true });
    const source = join(plans, "feature.md");
    const target = join(completed, "feature.md");
    await writeFile(source, sample, "utf8");
    git("add", "-f", "docs/plans/feature.md");
    git("commit", "-qm", "feat: implementation");

    await rename(source, target);
    git("add", "-u", "--", "docs/plans/feature.md");
    assert.match(git("status", "--porcelain"), /^D  docs\/plans\/feature\.md$/m);

    await ralphex.commitCompletedPlanMove(temporary, source, target);
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(git("log", "-1", "--pretty=%s"), "move completed plan: feature.md");
    assert.equal(git("ls-files", "docs/plans/completed/feature.md"), "docs/plans/completed/feature.md");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ralphex plan parser finds ordered incomplete task sections", () => {
  const tasks = planModule.parseTasks(sample);
  assert.deepEqual(tasks.map(({ number, title, unchecked }) => ({ number, title, unchecked })), [
    { number: 1, title: "First task", unchecked: 1 },
    { number: 2, title: "Second task", unchecked: 1 },
  ]);
  assert.equal(planModule.firstIncompleteTask(sample).number, 1);
});

test("ralphex base marker is stable and machine-readable", () => {
  const withBase = planModule.ensureBaseCommit(sample, "abcdef1234567890");
  assert.equal(planModule.baseCommit(withBase), "abcdef1234567890");
  assert.equal(planModule.ensureBaseCommit(withBase, "deadbeef"), withBase);
});

test("execution notes are appended without introducing checkboxes", () => {
  const first = planModule.appendExecutionNote(sample, "Task 1: chose the existing API");
  const second = planModule.appendExecutionNote(first, "Task 2: retained fallback");
  assert.match(second, /## Execution Notes/);
  assert.match(second, /Task 1: chose the existing API/);
  assert.match(second, /Task 2: retained fallback/);
  assert.deepEqual(planModule.executionNotes(second), [
    "Task 1: chose the existing API",
    "Task 2: retained fallback",
  ]);
  assert.equal(planModule.parseTasks(second)[1].unchecked, 1);
});

test("task prompt enforces one task, validation, commit, and mode-specific ambiguity handling", () => {
  const task = planModule.firstIncompleteTask(sample);
  const interactive = prompts.taskPrompt({ planPath: "docs/plans/feature.md", task, auto: false });
  assert.match(interactive, /execute exactly Task 1/);
  assert.match(interactive, /Do not execute any other Task section/);
  assert.match(interactive, /compile, analyze, typecheck, or build/);
  assert.match(interactive, /feat: <task summary>/);
  assert.match(interactive, /<<<RALPHEX:QUESTION>>>/);

  const auto = prompts.taskPrompt({ planPath: "docs/plans/feature.md", task, auto: true });
  assert.match(auto, /unattended mode/);
  assert.match(auto, /## Execution Notes/);
  assert.doesNotMatch(auto, /<<<RALPHEX:QUESTION>>>/);
});

test("Claude review parser accepts strict JSON and rejects invalid output", () => {
  const parsed = prompts.parseClaudeReview(JSON.stringify({
    verdict: "needs-attention",
    summary: "one issue",
    findings: [{
      severity: "high",
      title: "broken fallback",
      body: "evidence",
      file: "lib/a.dart",
      line_start: 10,
      line_end: 11,
      confidence: 0.9,
      recommendation: "fix it",
    }],
    next_steps: [],
  }));
  assert.equal(parsed.findings[0].severity, "high");
  assert.throws(() => prompts.parseClaudeReview("not json"));
  assert.throws(() => prompts.parseClaudeReview(JSON.stringify({ verdict: "maybe", findings: [] })));
});

test("fixer prompt uses the agreed autonomous commit contract", () => {
  const prompt = prompts.fixerPrompt({
    planPath: "docs/plans/feature.md",
    findings: [{
      severity: "low",
      title: "edge case",
      body: "evidence",
      file: "src/a.ts",
      line_start: 1,
      line_end: 1,
      confidence: 0.8,
      recommendation: "handle it",
    }],
  });
  assert.match(prompt, /Evaluate every Claude finding/);
  assert.match(prompt, /fix: address code review findings/);
  assert.match(prompt, /every finding is a false positive/);
  assert.match(prompt, /<<<RALPHEX:NO_FIXES>>>/);
});
