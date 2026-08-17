import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { access, mkdir, readdir, rename } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendExecutionNote, baseCommit, ensureBaseCommit, firstIncompleteTask, parseTasks, readPlan, writePlan } from "./plan";
import { runCommand, runPiWorker } from "./process";
import { claudeReviewPrompt, fixerPrompt, parseClaudeReview, taskPrompt, type ClaudeFinding } from "./prompts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLAUDE_WRAPPER = join(PACKAGE_ROOT, "skills", "ask-claude", "scripts", "ask-claude.sh");
const QUESTION_PATTERN = /<<<RALPHEX:QUESTION>>>\s*\n?([\s\S]*?)\n?<<<RALPHEX:END>>>/;
const TASK_RETRIES = 1;
const REVIEW_FIX_ITERATIONS = 3;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  const result = await runCommand({ command: "git", args, cwd });
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

async function repositoryRoot(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

async function head(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "HEAD"]);
}

async function dirtyPaths(cwd: string): Promise<string[]> {
  const output = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return output.split("\n").filter(Boolean).map((line) => line.slice(3).split(" -> ").pop() ?? "");
}

function normalizeRelative(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveRequestedPlan(cwd: string, requested: string): Promise<string> {
  const candidates = [resolve(cwd, requested)];
  if (requested === basename(requested)) {
    candidates.push(join(cwd, "docs", "plans", requested));
    candidates.push(join(cwd, "docs", "plans", "completed", requested));
  }
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error(`plan file not found: ${requested}`);
}

function compactActivity(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

function showProgress(ctx: ExtensionCommandContext, title: string, activity?: string): void {
  const lines = [title];
  const compact = activity ? compactActivity(activity) : "";
  if (compact) lines.push(compact);
  ctx.ui.setWidget("ralphex", lines);
}

async function ensureExecPreflight(ctx: ExtensionCommandContext, planPath: string): Promise<{ root: string; base: string }> {
  const root = await repositoryRoot(ctx.cwd);
  const relativePlan = normalizeRelative(relative(root, planPath));
  if (relativePlan.startsWith("../") || relativePlan === "..") throw new Error("plan must be inside the current Git repository");

  const markdown = await readPlan(planPath);
  if (!parseTasks(markdown).length) throw new Error("plan has no ### Task N: sections");

  const unrelated = (await dirtyPaths(root)).filter((path) => normalizeRelative(path) !== relativePlan);
  if (unrelated.length) {
    throw new Error(`uncommitted changes exist besides the plan file:\n${unrelated.map((path) => `- ${path}`).join("\n")}`);
  }

  const branch = await git(root, ["branch", "--show-current"]);
  if (["main", "master", "trunk"].includes(branch)) {
    const confirmed = await ctx.ui.confirm(
      "Run Ralphex on the default branch?",
      `Current branch is ${branch}. Task commits will be created directly on this branch.`,
    );
    if (!confirmed) throw new Error("cancelled on default branch");
  }

  return { root, base: baseCommit(markdown) ?? await head(root) };
}

async function findPlans(cwd: string, purpose: "exec" | "review"): Promise<string[]> {
  const directory = join(cwd, "docs", "plans");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const plans: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(directory, entry.name);
    const markdown = await readPlan(path);
    const tasks = parseTasks(markdown);
    const eligible = purpose === "exec"
      ? Boolean(firstIncompleteTask(markdown))
      : tasks.length > 0 && !firstIncompleteTask(markdown) && Boolean(baseCommit(markdown));
    if (eligible) plans.push(path);
  }
  return plans.sort();
}

async function resolvePlan(
  args: string,
  ctx: ExtensionCommandContext,
  purpose: "exec" | "review" = "exec",
): Promise<{ path: string; auto: boolean }> {
  const auto = /(?:^|\s)--auto(?:\s|$)/.test(args);
  const requested = args.replace(/(?:^|\s)--auto(?=\s|$)/g, " ").trim();
  if (requested) return { path: await resolveRequestedPlan(ctx.cwd, requested), auto };

  const plans = await findPlans(ctx.cwd, purpose);
  if (!plans.length) throw new Error(purpose === "exec"
    ? "no incomplete plans found in docs/plans/"
    : "no executed plans awaiting review found in docs/plans/");
  if (plans.length === 1) return { path: plans[0], auto };
  const labels = plans.map((path) => relative(ctx.cwd, path));
  const selected = await ctx.ui.select("Select a Ralphex plan", labels);
  if (!selected) throw new Error("plan selection cancelled");
  return { path: plans[labels.indexOf(selected)], auto };
}

function parseQuestion(text: string): string | undefined {
  const payload = text.match(QUESTION_PATTERN)?.[1]?.trim();
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload);
    return typeof parsed.question === "string" ? parsed.question.trim() : undefined;
  } catch {
    return payload;
  }
}

function diagnostic(result: { assistantText: string; stderr: string; code: number }): string {
  return [result.assistantText, result.stderr, `exit code: ${result.code}`].filter(Boolean).join("\n").slice(-8000);
}

function workerModel(ctx: ExtensionCommandContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

async function executePlan(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
  const resolved = await resolvePlan(rawArgs, ctx);
  const { root, base } = await ensureExecPreflight(ctx, resolved.path);
  const original = await readPlan(resolved.path);
  if (!firstIncompleteTask(original)) throw new Error("plan has no incomplete Task checkboxes");
  await writePlan(resolved.path, ensureBaseCommit(original, base));

  let completed = 0;
  let questions = 0;
  while (true) {
    const markdown = await readPlan(resolved.path);
    const task = firstIncompleteTask(markdown);
    if (!task) break;

    ctx.ui.notify(`Task ${task.number}: ${task.title}`, "info");
    showProgress(ctx, `Ralphex exec · Task ${task.number}: ${task.title}`, "Starting fresh Pi worker…");
    let retryContext: string | undefined;
    let failures = 0;
    let taskDone = false;

    while (!taskDone) {
      const before = await head(root);
      const result = await runPiWorker({
        cwd: root,
        prompt: taskPrompt({ planPath: relative(root, resolved.path), task, auto: resolved.auto, retryContext }),
        model: workerModel(ctx),
        thinking: ctx.thinkingLevel,
        onText: (text) => showProgress(ctx, `Ralphex exec · Task ${task.number}: ${task.title}`, text),
        onActivity: (text) => showProgress(ctx, `Ralphex exec · Task ${task.number}: ${task.title}`, text),
      });
      ctx.ui.setWidget("ralphex", undefined);

      const question = !resolved.auto ? parseQuestion(result.assistantText) : undefined;
      if (question) {
        questions++;
        if (questions > 20) throw new Error("too many interactive questions without completing a task");
        const answer = await ctx.ui.input(`Task ${task.number} clarification`, question);
        if (!answer?.trim()) throw new Error(`Task ${task.number} stopped: clarification was not answered`);
        const latest = await readPlan(resolved.path);
        await writePlan(resolved.path, appendExecutionNote(latest, `Task ${task.number}: ${question} — ${answer.trim()}`));
        retryContext = `User clarification: ${question}\nAnswer: ${answer.trim()}`;
        continue;
      }

      const updated = await readPlan(resolved.path);
      const currentTask = parseTasks(updated).find((candidate) => candidate.number === task.number);
      const after = await head(root);
      const clean = (await dirtyPaths(root)).length === 0;
      taskDone = result.code === 0 && currentTask?.unchecked === 0 && after !== before && clean;
      if (taskDone) {
        completed++;
        ctx.ui.notify(`Task ${task.number} completed`, "info");
        break;
      }

      retryContext = diagnostic(result);
      if (failures >= TASK_RETRIES) {
        throw new Error(`Task ${task.number} failed after retry.\n${retryContext}`);
      }
      failures++;
      ctx.ui.notify(`Task ${task.number} failed; retrying once in a fresh Pi context`, "warning");
    }
  }

  pi.sendMessage({
    customType: "ralphex",
    content: `✓ Ralphex exec completed\nTasks: ${completed}\nPlan: ${relative(root, resolved.path)}\nNext: /ralphex-review ${relative(root, resolved.path)}`,
    display: true,
  });
}

async function runClaudeReview(root: string, planPath: string, base: string, previousContext: string): Promise<ReturnType<typeof parseClaudeReview>> {
  const prompt = claudeReviewPrompt({
    planPath: relative(root, planPath),
    baseCommit: base,
    previousContext: previousContext || undefined,
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runCommand({
      command: CLAUDE_WRAPPER,
      args: [],
      cwd: root,
      stdin: prompt,
      timeoutMs: 900_000,
    });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Claude review failed");
    try {
      return parseClaudeReview(result.stdout);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Claude returned invalid review JSON: ${errorText(lastError)}`);
}

async function runFixer(
  root: string,
  planPath: string,
  findings: ClaudeFinding[],
  ctx: ExtensionCommandContext,
  finalCriticalOnly = false,
): Promise<string> {
  const before = await head(root);
  const result = await runPiWorker({
    cwd: root,
    prompt: fixerPrompt({ planPath: relative(root, planPath), findings, finalCriticalOnly }),
    model: workerModel(ctx),
    thinking: ctx.thinkingLevel,
    onText: (text) => showProgress(ctx, "Ralphex review · Pi fixer", text),
    onActivity: (text) => showProgress(ctx, "Ralphex review · Pi fixer", text),
  });
  ctx.ui.setWidget("ralphex", undefined);
  if (result.code !== 0 || result.assistantText.includes("<<<RALPHEX:FIX_FAILED>>>") || (await dirtyPaths(root)).length) {
    throw new Error(`review fixer failed or left uncommitted changes:\n${diagnostic(result)}`);
  }
  const after = await head(root);
  const noFixes = result.assistantText.includes("<<<RALPHEX:NO_FIXES>>>");
  if (!noFixes && after === before) throw new Error("review fixer reported completion without creating a commit");
  return result.assistantText;
}

async function commitCompletedPlanMove(root: string, source: string, target: string): Promise<void> {
  // The plans directory may be ignored even when the active plan is already tracked.
  // Stage an unstaged tracked deletion, but tolerate recovery when the prior failed
  // move already removed the source from the index (status `D `).
  const sourcePath = relative(root, source);
  const tracked = await runCommand({
    command: "git",
    args: ["ls-files", "--error-unmatch", "--", sourcePath],
    cwd: root,
  });
  if (tracked.code === 0) await git(root, ["add", "-u", "--", sourcePath]);
  await git(root, ["add", "-f", "--", relative(root, target)]);
  await git(root, ["commit", "-m", `move completed plan: ${basename(source)}`]);
}

async function moveCompletedPlan(root: string, planPath: string): Promise<string> {
  if (basename(dirname(planPath)) === "completed") return planPath;
  const targetDirectory = join(dirname(planPath), "completed");
  const target = join(targetDirectory, basename(planPath));
  try {
    await access(target);
    throw new Error(`completed plan already exists: ${relative(root, target)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("completed plan already exists:")) throw error;
  }
  await mkdir(targetDirectory, { recursive: true });
  await rename(planPath, target);
  await commitCompletedPlanMove(root, planPath, target);
  return target;
}

async function reviewPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
  const resolved = await resolvePlan(rawArgs, ctx, "review");
  const root = await repositoryRoot(ctx.cwd);
  const dirty = await dirtyPaths(root);
  if (basename(dirname(resolved.path)) === "completed") {
    const source = join(dirname(dirname(resolved.path)), basename(resolved.path));
    const movePaths = new Set([
      normalizeRelative(relative(root, source)),
      normalizeRelative(relative(root, resolved.path)),
    ]);
    if (dirty.length && dirty.every((path) => movePaths.has(normalizeRelative(path)))) {
      await commitCompletedPlanMove(root, source, resolved.path);
      pi.sendMessage({
        customType: "ralphex",
        content: `✓ Ralphex review completed\nRecovered the interrupted completed-plan commit.\nPlan: ${relative(root, resolved.path)}`,
        display: true,
      });
      return;
    }
    if (!dirty.length) {
      pi.sendMessage({ customType: "ralphex", content: `✓ Ralphex review already completed\nPlan: ${relative(root, resolved.path)}`, display: true });
      return;
    }
  }
  if (dirty.length) throw new Error("ralphex-review requires a clean worktree");
  const markdown = await readPlan(resolved.path);
  if (firstIncompleteTask(markdown)) throw new Error("plan still has incomplete Task checkboxes; run /ralphex-exec first");
  const base = baseCommit(markdown);
  if (!base) throw new Error("plan has no ralphex-base marker; run /ralphex-exec first");

  let previousContext = "";
  let normalFixes = 0;
  let finalFixUsed = false;
  let reviewNumber = 0;

  while (true) {
    reviewNumber++;
    ctx.ui.notify(`Claude review ${reviewNumber}`, "info");
    showProgress(ctx, `Ralphex review · Claude pass ${reviewNumber}`, "Read-only review in progress…");
    const review = await runClaudeReview(root, resolved.path, base, previousContext);
    showProgress(ctx, `Ralphex review · Claude pass ${reviewNumber}`, `${review.findings.length} finding(s): ${review.summary}`);
    if (review.verdict === "approve" && review.findings.length === 0) {
      const completedPath = await moveCompletedPlan(root, resolved.path);
      pi.sendMessage({
        customType: "ralphex",
        content: `✓ Ralphex review completed\nClaude review passes: ${reviewNumber}\nPlan: ${relative(root, completedPath)}`,
        display: true,
      });
      return;
    }

    const reviewJson = JSON.stringify(review, null, 2);
    if (normalFixes < REVIEW_FIX_ITERATIONS) {
      normalFixes++;
      ctx.ui.notify(`Applying confirmed Claude findings (${normalFixes}/${REVIEW_FIX_ITERATIONS})`, "info");
      const fixerResult = await runFixer(root, resolved.path, review.findings, ctx);
      previousContext += `\nClaude review ${reviewNumber}:\n${reviewJson}\nPi fixer:\n${fixerResult}\n`;
      continue;
    }

    const blocking = review.findings.filter((finding) => finding.severity === "critical" || finding.severity === "high");
    if (!finalFixUsed && blocking.length) {
      finalFixUsed = true;
      ctx.ui.notify("Applying final critical/high review fixes", "warning");
      const fixerResult = await runFixer(root, resolved.path, blocking, ctx, true);
      previousContext += `\nFinal blocking review:\n${reviewJson}\nPi fixer:\n${fixerResult}\n`;
      continue;
    }

    throw new Error(`Claude review did not converge. Remaining findings:\n${review.findings.map((finding) => `- [${finding.severity}] ${finding.title}`).join("\n")}`);
  }
}

async function commandBoundary(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string,
  operation: () => Promise<void>,
): Promise<void> {
  ctx.ui.setStatus("ralphex", name);
  pi.events.emit("ralphex:started", { name });
  try {
    await operation();
    pi.events.emit("ralphex:completed", { name });
  } catch (error) {
    ctx.ui.setWidget("ralphex", undefined);
    ctx.ui.notify(`${name} failed: ${errorText(error)}`, "error");
    pi.events.emit("ralphex:failed", { name, error: errorText(error) });
  } finally {
    ctx.ui.setWidget("ralphex", undefined);
    ctx.ui.setStatus("ralphex", undefined);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("ralphex-exec", {
    description: "Execute plan tasks sequentially in fresh Pi contexts; add --auto for unattended decisions",
    handler: async (args, ctx) => commandBoundary(pi, ctx, "Ralphex exec", () => executePlan(pi, ctx, args)),
  });

  pi.registerCommand("ralphex-review", {
    description: "Run the autonomous Claude review and Pi fixer loop for a completed plan",
    handler: async (args, ctx) => commandBoundary(pi, ctx, "Ralphex review", () => reviewPlan(pi, ctx, args)),
  });
}

export { commitCompletedPlanMove, executePlan, moveCompletedPlan, reviewPlan, resolvePlan, resolveRequestedPlan };
