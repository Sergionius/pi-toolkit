import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { access, mkdir, readdir, rename } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCdtRelease, type CdtReleaseResult, type ReleaseRequest } from "./cdt";
import { appendExecutionNote, baseCommit, ensureBaseCommit, executionNotes, firstIncompleteTask, parseTasks, readPlan, writePlan } from "./plan";
import { runCommand, runPiWorker } from "./process";
import { claudeReviewPrompt, fixerPrompt, parseClaudeReview, taskPrompt, type ClaudeFinding } from "./prompts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLAUDE_WRAPPER = join(PACKAGE_ROOT, "skills", "ask-claude", "scripts", "ask-claude.sh");
const QUESTION_PATTERN = /<<<RALPHEX:QUESTION>>>\s*\n?([\s\S]*?)\n?<<<RALPHEX:END>>>/;
const TASK_RETRIES = 1;
const REVIEW_FIX_ITERATIONS = 3;

type WorkflowOptions = {
  announceCompletion?: boolean;
  progressName?: string;
};

type ExecResult = {
  root: string;
  planPath: string;
  tasksCompleted: number;
};

type ParsedCommandArgs = {
  auto: boolean;
  requested: string;
  release?: ReleaseRequest;
};

type ReviewResult = {
  root: string;
  planPath: string;
  reviewPasses: number;
  fixCommits: number;
  alreadyCompleted?: boolean;
  recoveredMove?: boolean;
};

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
  const result = await runCommand({
    command: "git",
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd,
  });
  if (result.code !== 0) throw new Error(`git status failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trimEnd().split("\n").filter(Boolean).map((line) => line.slice(3).split(" -> ").pop() ?? "");
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

async function findPlans(cwd: string, purpose: "exec" | "review" | "loop"): Promise<string[]> {
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
      : purpose === "review"
        ? tasks.length > 0 && !firstIncompleteTask(markdown) && Boolean(baseCommit(markdown))
        : tasks.length > 0;
    if (eligible) plans.push(path);
  }
  return plans.sort();
}

function commandTokens(args: string): string[] {
  return args.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g)?.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  }) ?? [];
}

function parseCommandArgs(args: string): ParsedCommandArgs {
  const tokens = commandTokens(args);
  const positional: string[] = [];
  const ids: string[] = [];
  let auto = false;
  let pipeline: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--auto") {
      auto = true;
      continue;
    }
    if (token === "--release") {
      pipeline = tokens[++index];
      if (!pipeline || pipeline.startsWith("--")) throw new Error("--release requires a pipeline name");
      continue;
    }
    if (token.startsWith("--release=")) {
      pipeline = token.slice("--release=".length);
      if (!pipeline) throw new Error("--release requires a pipeline name");
      continue;
    }
    if (token === "--id") {
      const id = tokens[++index];
      if (!id || id.startsWith("--")) throw new Error("--id requires a value");
      ids.push(id);
      continue;
    }
    if (token.startsWith("--id=")) {
      const id = token.slice("--id=".length);
      if (!id) throw new Error("--id requires a value");
      ids.push(id);
      continue;
    }
    positional.push(token);
  }
  if (ids.length && !pipeline) throw new Error("--id requires --release <pipeline>");
  return {
    auto,
    requested: positional.join(" ").trim(),
    release: pipeline ? { pipeline, ids } : undefined,
  };
}

async function resolvePlan(
  args: string,
  ctx: ExtensionCommandContext,
  purpose: "exec" | "review" | "loop" = "exec",
): Promise<{ path: string; auto: boolean; release?: ReleaseRequest }> {
  const parsed = parseCommandArgs(args);
  if (parsed.requested) return {
    path: await resolveRequestedPlan(ctx.cwd, parsed.requested),
    auto: parsed.auto,
    release: parsed.release,
  };

  const plans = await findPlans(ctx.cwd, purpose);
  if (!plans.length) throw new Error(purpose === "exec"
    ? "no incomplete plans found in docs/plans/"
    : purpose === "review"
      ? "no executed plans awaiting review found in docs/plans/"
      : "no active plans found in docs/plans/");
  if (plans.length === 1) return { path: plans[0], auto: parsed.auto, release: parsed.release };
  const labels = plans.map((path) => relative(ctx.cwd, path));
  const selected = await ctx.ui.select("Select a Ralphex plan", labels);
  if (!selected) throw new Error("plan selection cancelled");
  return { path: plans[labels.indexOf(selected)], auto: parsed.auto, release: parsed.release };
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

async function executePlan(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string,
  options: WorkflowOptions = {},
): Promise<ExecResult> {
  const resolved = await resolvePlan(rawArgs, ctx);
  if (resolved.release) throw new Error("--release is supported by /ralphex-review and /ralphex-loop, not /ralphex-exec");
  const progressName = options.progressName ?? "Ralphex exec";
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
    showProgress(ctx, `${progressName} · Task ${task.number}: ${task.title}`, "Starting fresh Pi worker…");
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
        onText: (text) => showProgress(ctx, `${progressName} · Task ${task.number}: ${task.title}`, text),
        onActivity: (text) => showProgress(ctx, `${progressName} · Task ${task.number}: ${task.title}`, text),
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

  if (options.announceCompletion !== false) {
    pi.sendMessage({
      customType: "ralphex",
      content: `✓ Ralphex exec completed\nTasks: ${completed}\nPlan: ${relative(root, resolved.path)}\nNext: /ralphex-review ${relative(root, resolved.path)}`,
      display: true,
    });
  }
  return { root, planPath: resolved.path, tasksCompleted: completed };
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
  progressName = "Ralphex review",
): Promise<{ output: string; committed: boolean }> {
  const before = await head(root);
  const result = await runPiWorker({
    cwd: root,
    prompt: fixerPrompt({ planPath: relative(root, planPath), findings, finalCriticalOnly }),
    model: workerModel(ctx),
    thinking: ctx.thinkingLevel,
    onText: (text) => showProgress(ctx, `${progressName} · Pi fixer`, text),
    onActivity: (text) => showProgress(ctx, `${progressName} · Pi fixer`, text),
  });
  ctx.ui.setWidget("ralphex", undefined);
  if (result.code !== 0 || result.assistantText.includes("<<<RALPHEX:FIX_FAILED>>>") || (await dirtyPaths(root)).length) {
    throw new Error(`review fixer failed or left uncommitted changes:\n${diagnostic(result)}`);
  }
  const after = await head(root);
  const noFixes = result.assistantText.includes("<<<RALPHEX:NO_FIXES>>>");
  if (!noFixes && after === before) throw new Error("review fixer reported completion without creating a commit");
  return { output: result.assistantText, committed: after !== before };
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

async function reviewPlan(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string,
  options: WorkflowOptions = {},
): Promise<ReviewResult> {
  const resolved = await resolvePlan(rawArgs, ctx, "review");
  const root = await repositoryRoot(ctx.cwd);
  const progressName = options.progressName ?? "Ralphex review";
  const dirty = await dirtyPaths(root);
  if (basename(dirname(resolved.path)) === "completed") {
    const source = join(dirname(dirname(resolved.path)), basename(resolved.path));
    const movePaths = new Set([
      normalizeRelative(relative(root, source)),
      normalizeRelative(relative(root, resolved.path)),
    ]);
    if (dirty.length && dirty.every((path) => movePaths.has(normalizeRelative(path)))) {
      await commitCompletedPlanMove(root, source, resolved.path);
      if (options.announceCompletion !== false) {
        pi.sendMessage({
          customType: "ralphex",
          content: `✓ Ralphex review completed\nRecovered the interrupted completed-plan commit.\nPlan: ${relative(root, resolved.path)}`,
          display: true,
        });
      }
      return { root, planPath: resolved.path, reviewPasses: 0, fixCommits: 0, recoveredMove: true };
    }
    if (!dirty.length) {
      if (options.announceCompletion !== false) {
        pi.sendMessage({ customType: "ralphex", content: `✓ Ralphex review already completed\nPlan: ${relative(root, resolved.path)}`, display: true });
      }
      return { root, planPath: resolved.path, reviewPasses: 0, fixCommits: 0, alreadyCompleted: true };
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
  let fixCommits = 0;

  while (true) {
    reviewNumber++;
    ctx.ui.notify(`Claude review ${reviewNumber}`, "info");
    showProgress(ctx, `${progressName} · Claude pass ${reviewNumber}`, "Read-only review in progress…");
    const review = await runClaudeReview(root, resolved.path, base, previousContext);
    showProgress(ctx, `${progressName} · Claude pass ${reviewNumber}`, `${review.findings.length} finding(s): ${review.summary}`);
    if (review.verdict === "approve" && review.findings.length === 0) {
      const completedPath = await moveCompletedPlan(root, resolved.path);
      if (options.announceCompletion !== false) {
        pi.sendMessage({
          customType: "ralphex",
          content: `✓ Ralphex review completed\nClaude review passes: ${reviewNumber}\nPlan: ${relative(root, completedPath)}`,
          display: true,
        });
      }
      return { root, planPath: completedPath, reviewPasses: reviewNumber, fixCommits };
    }

    const reviewJson = JSON.stringify(review, null, 2);
    if (normalFixes < REVIEW_FIX_ITERATIONS) {
      normalFixes++;
      ctx.ui.notify(`Applying confirmed Claude findings (${normalFixes}/${REVIEW_FIX_ITERATIONS})`, "info");
      const fixerResult = await runFixer(root, resolved.path, review.findings, ctx, false, progressName);
      if (fixerResult.committed) fixCommits++;
      previousContext += `\nClaude review ${reviewNumber}:\n${reviewJson}\nPi fixer:\n${fixerResult.output}\n`;
      continue;
    }

    const blocking = review.findings.filter((finding) => finding.severity === "critical" || finding.severity === "high");
    if (!finalFixUsed && blocking.length) {
      finalFixUsed = true;
      ctx.ui.notify("Applying final critical/high review fixes", "warning");
      const fixerResult = await runFixer(root, resolved.path, blocking, ctx, true, progressName);
      if (fixerResult.committed) fixCommits++;
      previousContext += `\nFinal blocking review:\n${reviewJson}\nPi fixer:\n${fixerResult.output}\n`;
      continue;
    }

    throw new Error(`Claude review did not converge. Remaining findings:\n${review.findings.map((finding) => `- [${finding.severity}] ${finding.title}`).join("\n")}`);
  }
}

type ReleaseFinalization = {
  release: CdtReleaseResult;
  releaseCommit?: string;
  pushWarning?: string;
  remainingChanges: string[];
};

function releaseCommitMessage(release: CdtReleaseResult): string {
  const version = release.version?.replace(/\s+/g, " ").trim();
  const ids = release.ids.length ? ` for ${release.ids.join(", ")}` : "";
  return version ? `chore: release ${version}${ids}` : `chore: complete ${release.pipeline} release${ids}`;
}

async function commitAndPushReleaseChanges(root: string, release: CdtReleaseResult): Promise<ReleaseFinalization> {
  const releasableChanges = (await dirtyPaths(root)).filter((path) => !normalizeRelative(path).startsWith(".cdt/"));
  let releaseCommit: string | undefined;
  if (releasableChanges.length) {
    await git(root, ["add", "-A", "--", ...releasableChanges]);
    releaseCommit = releaseCommitMessage(release);
    await git(root, ["commit", "-m", releaseCommit]);
  }

  let pushWarning: string | undefined;
  const branch = await git(root, ["branch", "--show-current"]);
  if (!branch) {
    pushWarning = "cannot push from detached HEAD";
  } else {
    const upstream = await runCommand({
      command: "git",
      args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      cwd: root,
    });
    const pushArgs = upstream.code === 0 ? ["push"] : ["push", "-u", "origin", branch];
    const pushed = await runCommand({ command: "git", args: pushArgs, cwd: root, timeoutMs: 120_000 });
    if (pushed.code !== 0) pushWarning = pushed.stderr.trim() || pushed.stdout.trim() || "git push failed";
  }
  return { release, releaseCommit, pushWarning, remainingChanges: await dirtyPaths(root) };
}

async function runReleaseAndFinalize(
  root: string,
  request: ReleaseRequest,
  ctx: ExtensionCommandContext,
  progressName: string,
): Promise<ReleaseFinalization> {
  showProgress(ctx, `${progressName} · CDT`, `Preparing ${request.pipeline} release…`);
  const release = await runCdtRelease({
    cwd: root,
    request,
    onProgress: (message) => showProgress(ctx, `${progressName} · CDT`, message),
  });
  if (release.status !== "success") {
    return { release, remainingChanges: await dirtyPaths(root) };
  }
  showProgress(ctx, `${progressName} · Git`, "Committing release changes and pushing…");
  return commitAndPushReleaseChanges(root, release);
}

function formatReleaseSummary(result: ReleaseFinalization | undefined): string {
  if (!result) return "";
  const release = result.release;
  const lines = [""];
  if (release.status === "success") {
    lines.push("✓ CDT release completed");
  } else if (release.status === "running") {
    lines.push("⚠ CDT release still running");
  } else {
    lines.push("⚠ CDT release failed");
  }
  lines.push(`Pipeline: ${release.pipeline}`);
  if (release.ids.length) lines.push(`IDs: ${release.ids.join(", ")}`);
  if (release.runId) lines.push(`Run ID: ${release.runId}`);
  if (release.version) lines.push(`Version: ${release.version}`);
  for (const artifact of release.artifacts) lines.push(`Artifact: ${artifact}`);
  if (release.log) lines.push(`Log: ${release.log}`);
  if (release.reason) lines.push(`Reason: ${release.reason}`);
  if (result.releaseCommit) lines.push(`Release commit: ${result.releaseCommit}`);
  if (result.pushWarning) lines.push(`⚠ Git push failed: ${result.pushWarning}`, "Retry: git push");
  if (result.remainingChanges.length) lines.push(`Working tree: ${result.remainingChanges.join(", ")}`);
  else if (release.status === "success") lines.push("Working tree: clean");
  if (release.status === "running" && release.runId) {
    lines.push(`Check: cdt agent-release status --run ${release.runId} --wait --json`);
  }
  return `\n${lines.join("\n")}`;
}

function loopArgs(auto: boolean, root: string, planPath: string): string {
  return `${auto ? "--auto " : ""}${relative(root, planPath)}`;
}

async function runLoop(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
  const resolved = await resolvePlan(rawArgs, ctx, "loop");
  const root = await repositoryRoot(ctx.cwd);
  const resume = `/ralphex-loop${resolved.auto ? " --auto" : ""} ${basename(resolved.path)}`;
  let phase = "execution";
  let tasksCompleted = 0;

  try {
    const initial = await readPlan(resolved.path);
    if (firstIncompleteTask(initial)) {
      const execResult = await executePlan(pi, ctx, loopArgs(resolved.auto, root, resolved.path), {
        announceCompletion: false,
        progressName: "Ralphex loop",
      });
      tasksCompleted = execResult.tasksCompleted;
    }

    phase = "Claude review";
    const reviewResult = await reviewPlan(pi, ctx, relative(root, resolved.path), {
      announceCompletion: false,
      progressName: "Ralphex loop",
    });
    phase = "CDT release";
    const releaseResult = resolved.release
      ? await runReleaseAndFinalize(root, resolved.release, ctx, "Ralphex loop")
      : undefined;
    const finalMarkdown = await readPlan(reviewResult.planPath);
    const tasks = parseTasks(finalMarkdown).length;
    const notes = executionNotes(finalMarkdown);
    const noteSection = notes.length
      ? `\n\n${resolved.auto ? "Autonomous decisions" : "Execution notes"}:\n${notes.map((note) => `- ${note}`).join("\n")}`
      : "";
    const detail = reviewResult.alreadyCompleted
      ? "Already completed"
      : reviewResult.recoveredMove
        ? "Recovered interrupted plan completion"
        : `Claude review passes: ${reviewResult.reviewPasses}\nReview fix commits: ${reviewResult.fixCommits}`;

    pi.sendMessage({
      customType: "ralphex",
      content: `✓ Ralphex loop completed\n\nTasks: ${tasks}\nTask commits this run: ${tasksCompleted}\n${detail}\nValidation: passed\nPlan: ${relative(root, reviewResult.planPath)}${noteSection}${formatReleaseSummary(releaseResult)}`,
      display: true,
    });
  } catch (error) {
    throw new Error(`✗ Ralphex loop blocked\n\nPhase: ${phase}\nReason: ${errorText(error)}\nPlan: ${relative(root, resolved.path)}\n\nResume:\n${resume}`);
  }
}

async function runReviewCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string,
): Promise<void> {
  const parsed = parseCommandArgs(rawArgs);
  if (!parsed.release) {
    await reviewPlan(pi, ctx, rawArgs);
    return;
  }
  const reviewResult = await reviewPlan(pi, ctx, rawArgs, {
    announceCompletion: false,
    progressName: "Ralphex review",
  });
  const releaseResult = await runReleaseAndFinalize(reviewResult.root, parsed.release, ctx, "Ralphex review");
  pi.sendMessage({
    customType: "ralphex",
    content: `✓ Ralphex review completed\nClaude review passes: ${reviewResult.reviewPasses}\nPlan: ${relative(reviewResult.root, reviewResult.planPath)}${formatReleaseSummary(releaseResult)}`,
    display: true,
  });
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
    description: "Run autonomous Claude review; optionally add --release <pipeline> and repeatable --id values",
    handler: async (args, ctx) => commandBoundary(pi, ctx, "Ralphex review", () => runReviewCommand(pi, ctx, args)),
  });

  pi.registerCommand("ralphex-loop", {
    description: "Execute and review a plan; supports --auto and optional --release <pipeline> with repeatable --id",
    handler: async (args, ctx) => commandBoundary(pi, ctx, "Ralphex loop", () => runLoop(pi, ctx, args)),
  });
}

export { commitAndPushReleaseChanges, commitCompletedPlanMove, executePlan, moveCompletedPlan, parseCommandArgs, reviewPlan, resolvePlan, resolveRequestedPlan, runLoop };
