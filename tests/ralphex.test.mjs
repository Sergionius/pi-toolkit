import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);
const planModule = await jiti.import(resolve(root, "extensions/ralphex/plan.ts"));
const modelConfig = await jiti.import(resolve(root, "extensions/ralphex/model-config.ts"));
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

test("ralphex formats elapsed workflow duration", () => {
  assert.equal(ralphex.formatDuration(999), "0 сек");
  assert.equal(ralphex.formatDuration(42_900), "42 сек");
  assert.equal(ralphex.formatDuration(754_000), "12 мин 34 сек");
  assert.equal(ralphex.formatDuration(3_905_000), "1 ч 05 мин 05 сек");
});

test("ralphex workflow status right-aligns model and execution mode", () => {
  const status = ralphex.formatWorkflowStatus("Ralphex exec", "zai/glm-5.3-flash · auto", 60);
  assert.equal(status.length, 60);
  assert.ok(status.startsWith("Ralphex exec"));
  assert.ok(status.endsWith("zai/glm-5.3-flash · auto"));
});

test("ralphex reports concise workflow progress to its UI and event bus", () => {
  const widgets = [];
  const events = [];
  ralphex.reportProgress(
    { events: { emit: (name, payload) => events.push({ name, payload }) } },
    { ui: { setWidget: (name, lines) => widgets.push({ name, lines }) } },
    "Ralphex exec · Task 1",
    "  Running   validation  ",
  );
  assert.deepEqual(widgets, [{ name: "ralphex", lines: ["Ralphex exec · Task 1", "Running validation"] }]);
  assert.deepEqual(events, [{
    name: "ralphex:progress",
    payload: { activity: "Ralphex exec · Task 1 · Running validation" },
  }]);
});

test("ralphex displays clarification in the input title, not its placeholder", async () => {
  const calls = [];
  const question = "Как обработать HTML вместо JSON?";
  const answer = await ralphex.askTaskClarification({
    notify: (text, level) => calls.push(["notify", text, level]),
    input: async (title, placeholder) => {
      calls.push(["input", title, placeholder]);
      return "Как указано в плане";
    },
  }, 4, question);
  assert.equal(answer, "Как указано в плане");
  assert.deepEqual(calls, [
    ["notify", `Task 4 clarification: ${question}`, "info"],
    ["input", `Task 4: ${question}`, undefined],
  ]);
});

test("ralphex release arguments support optional and repeated task IDs", () => {
  assert.deepEqual(
    ralphex.parseCommandArgs("--auto --release test --id BTL-123 --id=BTL-456 feature.md"),
    {
      auto: true,
      requested: "feature.md",
      release: { pipeline: "test", ids: ["BTL-123", "BTL-456"] },
    },
  );
  assert.deepEqual(ralphex.parseCommandArgs("--release test feature.md"), {
    auto: false,
    requested: "feature.md",
    release: { pipeline: "test", ids: [] },
  });
  assert.throws(() => ralphex.parseCommandArgs("--id BTL-123 feature.md"), /requires --release/);
});

test("ralphex auto and exec model arguments preserve natural-language requests", () => {
  assert.deepEqual(
    ralphex.parseAutoArgs("--plan-model openai/gpt-5.6-sol --exec-model=zai/glm-5.3-flash добавь сепараторы на странице"),
    {
      request: "добавь сепараторы на странице",
      planModel: "openai/gpt-5.6-sol",
      execModel: "zai/glm-5.3-flash",
    },
  );
  assert.deepEqual(ralphex.parseCommandArgs("--auto --model zai/glm-5.3-flash feature.md"), {
    auto: true,
    requested: "feature.md",
    model: "zai/glm-5.3-flash",
  });
  assert.throws(() => ralphex.parseAutoArgs("--plan-model"), /requires provider\/model/);
  assert.deepEqual(ralphex.parseModelConfigArgs("--project --exec zai/glm-5.3-flash"), {
    scope: "project",
    planModel: undefined,
    execModel: "zai/glm-5.3-flash",
  });
});

test("ralphex-plan auto arguments preserve interactive mode and support script flags", () => {
  assert.deepEqual(ralphex.parsePlanCommandArgs("add --json output"), {
    auto: false,
    json: false,
    request: "add --json output",
  });
  assert.deepEqual(
    ralphex.parsePlanCommandArgs("--auto --json --model=openai-codex/gpt-5.6-sol add separators"),
    {
      auto: true,
      json: true,
      request: "add separators",
      model: "openai-codex/gpt-5.6-sol",
    },
  );
  assert.throws(() => ralphex.parsePlanCommandArgs("--auto --model"), /requires provider\/model/);
});

test("autonomous plan report parses decisions, alternatives, side effects, and assumptions", () => {
  const report = ralphex.autonomousPlanReport(`# Plan

## Execution Notes
- Decision: use CSS border; Alternatives: Divider component, pseudo-element; Reason: matches existing markup; Side effects: spacing changes, visible boundary
- Assumption: claims remain table rows
- Limitation: visual browser check unavailable
`);
  assert.deepEqual(report, {
    decisions: [{
      decision: "use CSS border",
      alternatives: ["Divider component", "pseudo-element"],
      reason: "matches existing markup",
      sideEffects: ["spacing changes", "visible boundary"],
    }],
    assumptions: ["claims remain table rows"],
    limitations: ["visual browser check unavailable"],
  });
});

test("ralphex model config resolves global, project, and one-run precedence", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-models-"));
  const agent = join(temporary, "agent");
  const project = join(temporary, "project");
  try {
    const paths = modelConfig.modelConfigPaths(project, agent);
    await modelConfig.writeModelConfig(paths.global, {
      planModel: "openai/global-plan",
      execModel: "openai/global-exec",
    }, true);
    await modelConfig.writeModelConfig(paths.project, { execModel: "zai/project-exec" });

    assert.deepEqual(await modelConfig.resolveModelConfig({ root: project, projectTrusted: true, agentDir: agent }), {
      planModel: "openai/global-plan",
      execModel: "zai/project-exec",
    });
    assert.deepEqual(await modelConfig.resolveModelConfig({
      root: project,
      projectTrusted: true,
      agentDir: agent,
      overrides: { planModel: "openai/one-run" },
    }), {
      planModel: "openai/one-run",
      execModel: "zai/project-exec",
    });
    assert.deepEqual(await modelConfig.resolveModelConfig({
      root: project,
      projectTrusted: true,
      agentDir: agent,
      overrides: { planModel: undefined, execModel: undefined },
    }), {
      planModel: "openai/global-plan",
      execModel: "zai/project-exec",
    });
    assert.deepEqual(await modelConfig.resolveModelConfig({ root: project, projectTrusted: false, agentDir: agent }), {
      planModel: "openai/global-plan",
      execModel: "openai/global-exec",
    });
    assert.equal((await stat(paths.global)).mode & 0o777, 0o600);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("autonomous planning output is strict and saved without overwriting", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-generated-plan-"));
  const generated = `# Добавить сепараторы

## Goal
Добавить разделители.

## Context
Существующий список.

## Scope
Только UI.

## Implementation Steps

### Task 1: Добавить стили

**Files:**
- Modify: src/page.ts

- [ ] Добавить сепаратор

## Validation
npm test

## Acceptance Criteria
Строки разделены.

## Execution Notes
- Decision: CSS border; Alternatives: markup; Reason: минимально; Side effects: none
`;
  try {
    assert.equal(
      ralphex.parseGeneratedPlan(`<<<RALPHEX:PLAN>>>\n${generated}<<<RALPHEX:END>>>`),
      generated,
    );
    const first = await ralphex.saveGeneratedPlan(temporary, generated, new Date(2026, 8, 11));
    const second = await ralphex.saveGeneratedPlan(temporary, generated, new Date(2026, 8, 11));
    assert.equal(first, join(temporary, "docs", "plans", "2026-09-11-dobavit-separatory.md"));
    assert.equal(second, join(temporary, "docs", "plans", "2026-09-11-dobavit-separatory-2.md"));
    assert.throws(
      () => ralphex.parseGeneratedPlan("<<<RALPHEX:PLAN_BLOCKED>>>\n{\"reason\":\"credentials required\"}\n<<<RALPHEX:END>>>"),
      /planning blocked: credentials required/,
    );
    assert.throws(() => ralphex.validateGeneratedPlan(generated.replace("### Task 1:", "### Task 2:")), /not sequential/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

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

test("ralphex execution branch names come from dated plan filenames", () => {
  assert.equal(
    ralphex.executionBranchName("docs/plans/20260912-self-release-pipeline.md"),
    "ralphex/self-release-pipeline",
  );
  assert.equal(
    ralphex.executionBranchName("docs/plans/2026-09-12-Добавить кеш.md"),
    "ralphex/добавить-кеш",
  );
  assert.throws(
    () => ralphex.executionBranchName("docs/plans/!!!.md"),
    /cannot derive execution branch/,
  );
});

test("ralphex preflight can create and resume a plan branch from main", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-exec-branch-"));
  const git = (...args) => execFileSync("git", args, { cwd: temporary, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "ralphex@example.test");
    git("config", "user.name", "Ralphex Test");
    git("branch", "-M", "main");
    const repository = git("rev-parse", "--show-toplevel");
    const plans = join(repository, "docs", "plans");
    await mkdir(plans, { recursive: true });
    const plan = join(plans, "20260912-self-release-pipeline.md");
    await writeFile(plan, sample, "utf8");
    git("add", ".");
    git("commit", "-qm", "initial");
    const initialHead = git("rev-parse", "HEAD");

    const selections = [];
    const ctx = {
      cwd: repository,
      ui: {
        select: async (title, options) => {
          selections.push({ title, options });
          return options[1];
        },
      },
    };
    const created = await ralphex.ensureExecPreflight(ctx, plan);
    assert.equal(git("branch", "--show-current"), "ralphex/self-release-pipeline");
    assert.equal(created.base, initialHead);
    assert.deepEqual(selections[0], {
      title: "Run Ralphex on the default branch?",
      options: [
        "Execute on main",
        "Create or switch to ralphex/self-release-pipeline",
        "Cancel",
      ],
    });

    const resumedBase = "abcdef1234567890";
    await writeFile(plan, planModule.ensureBaseCommit(sample, resumedBase), "utf8");
    git("add", ".");
    git("commit", "-qm", "record plan progress");
    git("switch", "-q", "main");

    const resumed = await ralphex.ensureExecPreflight(ctx, plan);
    assert.equal(git("branch", "--show-current"), "ralphex/self-release-pipeline");
    assert.equal(resumed.base, resumedBase, "preflight must reread the plan after switching");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ralphex preflight creates a baseline commit for an unborn repository", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-unborn-"));
  const git = (...args) => execFileSync("git", args, { cwd: temporary, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "ralphex@example.test");
    git("config", "user.name", "Ralphex Test");
    const repository = git("rev-parse", "--show-toplevel");
    const plans = join(repository, "docs", "plans");
    await mkdir(plans, { recursive: true });
    const plan = join(plans, "feature.md");
    await writeFile(plan, sample, "utf8");
    await writeFile(join(repository, "project.txt"), "project", "utf8");
    await writeFile(join(repository, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(join(repository, "secret.txt"), "secret", "utf8");
    const notifications = [];
    const ctx = {
      cwd: repository,
      ui: {
        notify: (message, level) => notifications.push([message, level]),
        select: async () => { throw new Error("unexpected branch prompt"); },
      },
    };

    const first = await ralphex.ensureExecPreflight(ctx, plan, true);
    assert.equal(first.base, git("rev-parse", "HEAD"));
    assert.equal(git("log", "-1", "--format=%s"), "chore: initial commit");
    assert.deepEqual(git("ls-files").split("\n"), [".gitignore", "docs/plans/feature.md", "project.txt"]);
    assert.deepEqual(notifications, [["No commits yet: staging all non-ignored files and creating an initial commit", "info"]]);
    assert.equal(git("status", "--porcelain"), "");

    const second = await ralphex.ensureExecPreflight(ctx, plan, true);
    assert.equal(second.base, first.base);
    assert.equal(git("rev-list", "--count", "HEAD"), "1");
    await writeFile(join(repository, "another.txt"), "not committed", "utf8");
    await assert.rejects(() => ralphex.ensureExecPreflight(ctx, plan, true), /uncommitted changes exist besides the plan file/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ralphex preflight creates an empty initial commit when all files are ignored", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-unborn-ignored-"));
  const git = (...args) => execFileSync("git", args, { cwd: temporary, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "ralphex@example.test");
    git("config", "user.name", "Ralphex Test");
    git("config", "core.excludesFile", "/dev/null");
    const repository = git("rev-parse", "--show-toplevel");
    const plans = join(repository, "docs", "plans");
    await mkdir(plans, { recursive: true });
    const plan = join(plans, "feature.md");
    await writeFile(plan, sample, "utf8");
    await writeFile(join(repository, ".git", "info", "exclude"), "*\n", "utf8");
    const ctx = { cwd: repository, ui: { notify: () => {}, select: async () => { throw new Error("unexpected prompt"); } } };
    const result = await ralphex.ensureExecPreflight(ctx, plan, true);
    assert.equal(result.base, git("rev-parse", "HEAD"));
    assert.equal(git("ls-files"), "");
    assert.equal(git("status", "--porcelain"), "");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ralphex preflight keeps direct, cancel, feature-branch, and auto behavior", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-exec-choice-"));
  const git = (...args) => execFileSync("git", args, { cwd: temporary, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "ralphex@example.test");
    git("config", "user.name", "Ralphex Test");
    git("branch", "-M", "main");
    const repository = git("rev-parse", "--show-toplevel");
    const plans = join(repository, "docs", "plans");
    await mkdir(plans, { recursive: true });
    const plan = join(plans, "20260912-feature.md");
    await writeFile(plan, sample, "utf8");
    git("add", ".");
    git("commit", "-qm", "initial");

    let calls = 0;
    const directCtx = {
      cwd: repository,
      ui: { select: async (_title, options) => { calls++; return options[0]; } },
    };
    await ralphex.ensureExecPreflight(directCtx, plan);
    assert.equal(git("branch", "--show-current"), "main");
    assert.equal(calls, 1);

    const cancelCtx = { cwd: repository, ui: { select: async () => "Cancel" } };
    await assert.rejects(() => ralphex.ensureExecPreflight(cancelCtx, plan), /cancelled on default branch/);
    assert.equal(git("branch", "--show-current"), "main");

    const noPromptCtx = { cwd: repository, ui: { select: async () => { throw new Error("unexpected prompt"); } } };
    await ralphex.ensureExecPreflight(noPromptCtx, plan, true);
    assert.equal(git("branch", "--show-current"), "main");

    git("switch", "-qc", "feature/manual");
    await ralphex.ensureExecPreflight(noPromptCtx, plan);
    assert.equal(git("branch", "--show-current"), "feature/manual");
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

test("successful release changes are committed and pushed", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-release-git-"));
  const repository = join(temporary, "repo");
  const remote = join(temporary, "origin.git");
  await mkdir(repository);
  const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  try {
    execFileSync("git", ["init", "--bare", "-q", remote]);
    git("init", "-q");
    git("config", "user.email", "ralphex@example.test");
    git("config", "user.name", "Ralphex Test");
    git("branch", "-M", "feature/release");
    await writeFile(join(repository, "pubspec.yaml"), "version: 1.0.0+1\n", "utf8");
    git("add", "pubspec.yaml");
    git("commit", "-qm", "initial");
    git("remote", "add", "origin", remote);
    git("push", "-qu", "origin", "feature/release");

    await writeFile(join(repository, "pubspec.yaml"), "version: 1.0.0+2\n", "utf8");
    const result = await ralphex.commitAndPushReleaseChanges(repository, {
      status: "success",
      pipeline: "test",
      ids: ["BTL-42"],
      version: "1.0.0+2",
      artifacts: [],
    });

    assert.equal(result.releaseCommit, "chore: release 1.0.0+2 for BTL-42");
    assert.equal(result.pushWarning, undefined);
    assert.deepEqual(result.remainingChanges, []);
    assert.equal(git("log", "-1", "--pretty=%s"), "chore: release 1.0.0+2 for BTL-42");
    const remoteSubject = execFileSync("git", ["--git-dir", remote, "log", "feature/release", "-1", "--pretty=%s"], { encoding: "utf8" }).trim();
    assert.equal(remoteSubject, "chore: release 1.0.0+2 for BTL-42");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("release push failure remains a completed local commit with warning", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ralphex-release-push-failure-"));
  const git = (...args) => execFileSync("git", args, { cwd: temporary, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "ralphex@example.test");
    git("config", "user.name", "Ralphex Test");
    await writeFile(join(temporary, "pubspec.yaml"), "version: 1.0.0+1\n", "utf8");
    git("add", "pubspec.yaml");
    git("commit", "-qm", "initial");
    await writeFile(join(temporary, "pubspec.yaml"), "version: 1.0.0+2\n", "utf8");

    const result = await ralphex.commitAndPushReleaseChanges(temporary, {
      status: "success",
      pipeline: "test",
      ids: [],
      version: "1.0.0+2",
      artifacts: [],
    });

    assert.equal(result.releaseCommit, "chore: release 1.0.0+2");
    assert.match(result.pushWarning, /origin|repository|remote/i);
    assert.deepEqual(result.remainingChanges, []);
    assert.equal(git("log", "-1", "--pretty=%s"), "chore: release 1.0.0+2");
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

test("ralphex task progress parser accepts valid live updates", () => {
  const checkbox = ralphex.parseTaskProgress(`before
<<<RALPHEX:PROGRESS>>>
{"stage":"checkbox","index":2,"total":4,"text":" Update error handling "}
<<<RALPHEX:END>>>`);
  assert.deepEqual(checkbox, {
    stage: "checkbox",
    index: 2,
    total: 4,
    text: "Update error handling",
  });
  assert.equal(
    ralphex.formatTaskProgress(checkbox, "bash: npm test"),
    "Checkbox 2/4 · Update error handling — bash: npm test",
  );

  const validation = ralphex.parseTaskProgress(`
<<<RALPHEX:PROGRESS>>>
{"stage":"validation","text":"npm test"}
<<<RALPHEX:END>>>`);
  assert.deepEqual(validation, { stage: "validation", text: "npm test" });
  assert.equal(ralphex.formatTaskProgress(validation), "Validation · npm test");
});

test("ralphex task progress parser ignores malformed or invalid updates", () => {
  const invalid = [
    `<<<RALPHEX:PROGRESS>>>\nnot json\n<<<RALPHEX:END>>>`,
    `<<<RALPHEX:PROGRESS>>>\n{"stage":"checkbox","index":0,"total":2,"text":"item"}\n<<<RALPHEX:END>>>`,
    `<<<RALPHEX:PROGRESS>>>\n{"stage":"checkbox","index":3,"total":2,"text":"item"}\n<<<RALPHEX:END>>>`,
    `<<<RALPHEX:PROGRESS>>>\n{"stage":"validation","text":"  "}\n<<<RALPHEX:END>>>`,
    `<<<RALPHEX:PROGRESS>>>\n{"stage":"unknown","text":"item"}\n<<<RALPHEX:END>>>`,
  ];
  for (const signal of invalid) assert.equal(ralphex.parseTaskProgress(signal), undefined);
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
  assert.match(interactive, /documentation-only task/);
  assert.match(interactive, /pre-existing issues outside this task/);
  assert.match(interactive, /non-regression pass/);
  assert.match(interactive, /feat: <task summary>/);
  assert.match(interactive, /entire commit message in English only/);
  assert.match(interactive, /regardless of the language used in the plan or user request/);
  assert.match(interactive, /Immediately before starting each unchecked item/);
  assert.match(interactive, /"stage":"checkbox"/);
  assert.match(interactive, /Immediately before each validation command/);
  assert.match(interactive, /"stage":"validation"/);
  assert.match(interactive, /<<<RALPHEX:QUESTION>>>/);

  const auto = prompts.taskPrompt({ planPath: "docs/plans/feature.md", task, auto: true });
  assert.match(auto, /unattended mode/);
  assert.match(auto, /## Execution Notes/);
  assert.match(auto, /<<<RALPHEX:SUMMARY>>>/);
  assert.doesNotMatch(auto, /<<<RALPHEX:QUESTION>>>/);
  assert.deepEqual(ralphex.parseTaskSummary(`<<<RALPHEX:SUMMARY>>>
{"result":"added separators","sideEffects":["spacing changed"],"limitations":[]}
<<<RALPHEX:END>>>`), {
    result: "added separators",
    sideEffects: ["spacing changed"],
    limitations: [],
  });
});

test("autonomous planning prompt forbids questions and implementation mutations", () => {
  const prompt = prompts.autonomousPlanPrompt("add separators");
  assert.match(prompt, /Do not ask the user questions/);
  assert.match(prompt, /Do not modify files, Git state/);
  assert.match(prompt, /Decision: <choice>; Alternatives:/);
  assert.match(prompt, /<<<RALPHEX:PLAN>>>/);
  assert.match(prompt, /review, release, push/);
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
