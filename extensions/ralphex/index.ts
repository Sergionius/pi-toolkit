import { DynamicBorder, getSelectListTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, type KeybindingsManager, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { access, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCdtRelease, type CdtReleaseResult, type ReleaseRequest } from "./cdt";
import { appendExecutionNote, baseCommit, ensureBaseCommit, executionNotes, firstIncompleteTask, parseTasks, readPlan, writePlan } from "./plan";
import { modelConfigPaths, readModelConfig, resolveModelConfig, writeModelConfig, type RalphexModelConfig } from "./model-config";
import { runCommand, runPiWorker } from "./process";
import { autonomousPlanPrompt, claudeReviewPrompt, fixerPrompt, parseClaudeReview, taskPrompt, type ClaudeFinding } from "./prompts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLAUDE_WRAPPER = join(PACKAGE_ROOT, "skills", "ask-claude", "scripts", "ask-claude.sh");
const QUESTION_PATTERN = /<<<RALPHEX:QUESTION>>>\s*\n?([\s\S]*?)\n?<<<RALPHEX:END>>>/;
const PROGRESS_PATTERN = /<<<RALPHEX:PROGRESS>>>\s*\n?([\s\S]*?)\n?<<<RALPHEX:END>>>/g;
const SUMMARY_PATTERN = /<<<RALPHEX:SUMMARY>>>\s*\n?([\s\S]*?)\n?<<<RALPHEX:END>>>/;
const GENERATED_PLAN_PATTERN = /<<<RALPHEX:PLAN>>>\s*\n?([\s\S]*?)\n?<<<RALPHEX:END>>>/;
const PLAN_BLOCKED_PATTERN = /<<<RALPHEX:PLAN_BLOCKED>>>\s*\n?([\s\S]*?)\n?<<<RALPHEX:END>>>/;
const TASK_RETRIES = 1;
const REVIEW_FIX_ITERATIONS = 3;

type WorkflowOptions = {
  announceCompletion?: boolean;
  progressName?: string;
};

type TaskSummary = {
  result: string;
  sideEffects: string[];
  limitations: string[];
};

type ExecResult = {
  root: string;
  planPath: string;
  tasksCompleted: number;
  summaries: TaskSummary[];
};

type TaskProgress = {
  stage: "checkbox" | "validation";
  text: string;
  index?: number;
  total?: number;
};

type ParsedCommandArgs = {
  auto: boolean;
  requested: string;
  model?: string;
  release?: ReleaseRequest;
};

type ParsedAutoArgs = {
  request: string;
  planModel?: string;
  execModel?: string;
};

type ParsedPlanCommandArgs = {
  auto: boolean;
  json: boolean;
  request: string;
  model?: string;
};

export type AutonomousDecision = {
  decision: string;
  alternatives: string[];
  reason: string;
  sideEffects: string[];
};

export type AutonomousPlanResult = {
  root: string;
  planPath: string;
  model: string;
  decisions: AutonomousDecision[];
  assumptions: string[];
  limitations: string[];
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

async function ensureExecPreflight(ctx: ExtensionCommandContext, planPath: string, auto = false): Promise<{ root: string; base: string }> {
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
  if (["main", "master", "trunk"].includes(branch) && !auto) {
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

function parseAutoArgs(args: string): ParsedAutoArgs {
  const tokens = commandTokens(args);
  const request: string[] = [];
  let planModel: string | undefined;
  let execModel: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--plan-model" || token === "--exec-model") {
      const value = tokens[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires provider/model`);
      if (token === "--plan-model") planModel = value;
      else execModel = value;
      continue;
    }
    if (token.startsWith("--plan-model=")) {
      planModel = token.slice("--plan-model=".length);
      if (!planModel) throw new Error("--plan-model requires provider/model");
      continue;
    }
    if (token.startsWith("--exec-model=")) {
      execModel = token.slice("--exec-model=".length);
      if (!execModel) throw new Error("--exec-model requires provider/model");
      continue;
    }
    request.push(token);
  }
  return { request: request.join(" ").trim(), planModel, execModel };
}

function parsePlanCommandArgs(args: string): ParsedPlanCommandArgs {
  const tokens = commandTokens(args);
  if (!tokens.includes("--auto")) return { auto: false, json: false, request: args.trim() };
  const request: string[] = [];
  let json = false;
  let model: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--auto") continue;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--model") {
      model = tokens[++index];
      if (!model || model.startsWith("--")) throw new Error("--model requires provider/model");
      continue;
    }
    if (token.startsWith("--model=")) {
      model = token.slice("--model=".length);
      if (!model) throw new Error("--model requires provider/model");
      continue;
    }
    request.push(token);
  }
  return { auto: true, json, request: request.join(" ").trim(), model };
}

function parseCommandArgs(args: string): ParsedCommandArgs {
  const tokens = commandTokens(args);
  const positional: string[] = [];
  const ids: string[] = [];
  let auto = false;
  let model: string | undefined;
  let pipeline: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--auto") {
      auto = true;
      continue;
    }
    if (token === "--model") {
      model = tokens[++index];
      if (!model || model.startsWith("--")) throw new Error("--model requires provider/model");
      continue;
    }
    if (token.startsWith("--model=")) {
      model = token.slice("--model=".length);
      if (!model) throw new Error("--model requires provider/model");
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
    ...(model ? { model } : {}),
    ...(pipeline ? { release: { pipeline, ids } } : {}),
  };
}

async function resolvePlan(
  args: string,
  ctx: ExtensionCommandContext,
  purpose: "exec" | "review" | "loop" = "exec",
): Promise<{ path: string; auto: boolean; model?: string; release?: ReleaseRequest }> {
  const parsed = parseCommandArgs(args);
  if (parsed.requested) return {
    path: await resolveRequestedPlan(ctx.cwd, parsed.requested),
    auto: parsed.auto,
    model: parsed.model,
    release: parsed.release,
  };

  const plans = await findPlans(ctx.cwd, purpose);
  if (!plans.length) throw new Error(purpose === "exec"
    ? "no incomplete plans found in docs/plans/"
    : purpose === "review"
      ? "no executed plans awaiting review found in docs/plans/"
      : "no active plans found in docs/plans/");
  if (plans.length === 1) return { path: plans[0], auto: parsed.auto, model: parsed.model, release: parsed.release };
  const labels = plans.map((path) => relative(ctx.cwd, path));
  const selected = await ctx.ui.select("Select a Ralphex plan", labels);
  if (!selected) throw new Error("plan selection cancelled");
  return { path: plans[labels.indexOf(selected)], auto: parsed.auto, model: parsed.model, release: parsed.release };
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

function parseTaskProgress(text: string): TaskProgress | undefined {
  let latest: TaskProgress | undefined;
  for (const match of text.matchAll(PROGRESS_PATTERN)) {
    try {
      const parsed = JSON.parse(match[1].trim()) as Partial<TaskProgress>;
      const progressText = typeof parsed.text === "string" ? parsed.text.trim() : "";
      if (!progressText) continue;
      if (parsed.stage === "validation") {
        latest = { stage: "validation", text: progressText };
        continue;
      }
      if (parsed.stage !== "checkbox"
        || !Number.isInteger(parsed.index)
        || !Number.isInteger(parsed.total)
        || Number(parsed.index) < 1
        || Number(parsed.total) < Number(parsed.index)) continue;
      latest = {
        stage: "checkbox",
        text: progressText,
        index: Number(parsed.index),
        total: Number(parsed.total),
      };
    } catch {
      // Progress is informational and malformed worker output must not affect execution.
    }
  }
  return latest;
}

function parseTaskSummary(text: string): TaskSummary | undefined {
  const payload = text.match(SUMMARY_PATTERN)?.[1]?.trim();
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload) as Partial<TaskSummary>;
    if (typeof parsed.result !== "string" || !parsed.result.trim()) return undefined;
    return {
      result: parsed.result.trim(),
      sideEffects: Array.isArray(parsed.sideEffects) ? parsed.sideEffects.map(String).filter(Boolean) : [],
      limitations: Array.isArray(parsed.limitations) ? parsed.limitations.map(String).filter(Boolean) : [],
    };
  } catch {
    return undefined;
  }
}

function formatTaskProgress(progress: TaskProgress, activity?: string): string {
  const label = progress.stage === "checkbox"
    ? `Checkbox ${progress.index}/${progress.total} · ${progress.text}`
    : `Validation · ${progress.text}`;
  const detail = activity ? compactActivity(activity) : "";
  return detail ? `${label} — ${detail}` : label;
}

function diagnostic(result: { assistantText: string; stderr: string; code: number }): string {
  return [result.assistantText, result.stderr, `exit code: ${result.code}`].filter(Boolean).join("\n").slice(-8000);
}

function workerModel(ctx: ExtensionCommandContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function validateConfiguredModel(ctx: ExtensionCommandContext, value: string, label: string): void {
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) throw new Error(`${label} model must use provider/model format: ${value}`);
  const provider = value.slice(0, separator);
  const model = value.slice(separator + 1);
  if (!ctx.modelRegistry.find(provider, model)) throw new Error(`${label} model is unavailable: ${value}`);
  if (!ctx.modelRegistry.getProviderAuthStatus(provider).configured) {
    throw new Error(`${label} model provider is not authenticated: ${provider}. Run /login ${provider}.`);
  }
}

async function executePlan(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string,
  options: WorkflowOptions = {},
): Promise<ExecResult> {
  const resolved = await resolvePlan(rawArgs, ctx);
  if (resolved.release) throw new Error("--release is supported by /ralphex-review and /ralphex-loop, not /ralphex-exec");
  if (resolved.model) validateConfiguredModel(ctx, resolved.model, "Execution");
  const progressName = options.progressName ?? "Ralphex exec";
  const { root, base } = await ensureExecPreflight(ctx, resolved.path, resolved.auto);
  const original = await readPlan(resolved.path);
  if (!firstIncompleteTask(original)) throw new Error("plan has no incomplete Task checkboxes");
  await writePlan(resolved.path, ensureBaseCommit(original, base));

  let completed = 0;
  let questions = 0;
  const summaries: TaskSummary[] = [];
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
      let progress: TaskProgress | undefined;
      const progressTitle = `${progressName} · Task ${task.number}: ${task.title}`;
      const result = await runPiWorker({
        cwd: root,
        prompt: taskPrompt({ planPath: relative(root, resolved.path), task, auto: resolved.auto, retryContext }),
        model: resolved.model ?? workerModel(ctx),
        thinking: ctx.thinkingLevel,
        onText: (text) => {
          const update = parseTaskProgress(text);
          if (update) progress = update;
          showProgress(ctx, progressTitle, progress ? formatTaskProgress(progress) : text);
        },
        onActivity: (text) => showProgress(ctx, progressTitle, progress ? formatTaskProgress(progress, text) : text),
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
        summaries.push(parseTaskSummary(result.assistantText) ?? {
          result: task.title,
          sideEffects: [],
          limitations: [],
        });
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
  return { root, planPath: resolved.path, tasksCompleted: completed, summaries };
}

const CYRILLIC_TO_ASCII: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

function generatedPlanSlug(markdown: string): string {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "plan";
  return [...title.toLowerCase()].map((character) => CYRILLIC_TO_ASCII[character] ?? character).join("")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "") || "plan";
}

function validateGeneratedPlan(markdown: string): void {
  const required = ["Goal", "Context", "Scope", "Implementation Steps", "Validation", "Acceptance Criteria", "Execution Notes"];
  for (const heading of required) {
    if (!new RegExp(`^## ${heading}\\s*$`, "m").test(markdown)) {
      throw new Error(`generated plan is missing ## ${heading}`);
    }
  }
  const tasks = parseTasks(markdown);
  if (!tasks.length) throw new Error("generated plan has no Task sections");
  for (let index = 0; index < tasks.length; index++) {
    if (tasks[index].number !== index + 1) throw new Error("generated plan Task numbers are not sequential");
    if (tasks[index].unchecked < 1) throw new Error(`generated plan Task ${tasks[index].number} has no unchecked checkboxes`);
  }
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*-\s*\[\s\]/.test(lines[index])) continue;
    if (!tasks.some((task) => index > task.start && index < task.end)) {
      throw new Error("generated plan has an executable checkbox outside a Task section");
    }
  }
}

function parseGeneratedPlan(output: string): string {
  const blocked = output.match(PLAN_BLOCKED_PATTERN)?.[1]?.trim();
  if (blocked) {
    try {
      const reason = JSON.parse(blocked)?.reason;
      throw new Error(`planning blocked: ${reason || blocked}`);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`planning blocked: ${blocked}`);
      throw error;
    }
  }
  const markdown = output.match(GENERATED_PLAN_PATTERN)?.[1]?.trim();
  if (!markdown) throw new Error("planning worker returned no plan envelope");
  validateGeneratedPlan(markdown);
  return `${markdown}\n`;
}

function dateStamp(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

async function saveGeneratedPlan(root: string, markdown: string, date = new Date()): Promise<string> {
  const directory = join(root, "docs", "plans");
  await mkdir(directory, { recursive: true });
  const stem = `${dateStamp(date)}-${generatedPlanSlug(markdown)}`;
  for (let suffix = 1; ; suffix++) {
    const path = join(directory, `${stem}${suffix === 1 ? "" : `-${suffix}`}.md`);
    try {
      await writeFile(path, markdown, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function splitReportValues(value: string): string[] {
  const clean = value.trim();
  if (!clean || /^(none|нет|не выявлены)$/i.test(clean)) return [];
  return clean.split(/\s*(?:,|\|)\s*/).map((item) => item.trim()).filter(Boolean);
}

function autonomousPlanReport(markdown: string): Pick<AutonomousPlanResult, "decisions" | "assumptions" | "limitations"> {
  const decisions: AutonomousDecision[] = [];
  const assumptions: string[] = [];
  const limitations: string[] = [];
  for (const note of executionNotes(markdown)) {
    const decision = note.match(/^Decision:\s*(.*?);\s*Alternatives:\s*(.*?);\s*Reason:\s*(.*?);\s*Side effects:\s*(.*)$/i);
    if (decision) {
      decisions.push({
        decision: decision[1].trim(),
        alternatives: splitReportValues(decision[2]),
        reason: decision[3].trim(),
        sideEffects: splitReportValues(decision[4]),
      });
      continue;
    }
    const assumption = note.match(/^(?:Assumption|Допущение):\s*(.+)$/i)?.[1]?.trim();
    if (assumption) assumptions.push(assumption);
    const limitation = note.match(/^(?:Limitation|Ограничение):\s*(.+)$/i)?.[1]?.trim();
    if (limitation) limitations.push(limitation);
  }
  return { decisions, assumptions, limitations };
}

async function generateAutonomousPlan(options: {
  ctx: ExtensionCommandContext;
  root: string;
  request: string;
  model: string;
  progressName: string;
}): Promise<AutonomousPlanResult> {
  const dirty = await dirtyPaths(options.root);
  if (dirty.length) throw new Error(`autonomous planning requires a clean worktree:\n${dirty.map((path) => `- ${path}`).join("\n")}`);

  let retryContext: string | undefined;
  let markdown: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    showProgress(options.ctx, `${options.progressName} · Planning`, attempt ? "Retrying invalid plan…" : "Inspecting project and creating plan…");
    const result = await runPiWorker({
      cwd: options.root,
      prompt: autonomousPlanPrompt(options.request, retryContext),
      model: options.model,
      thinking: options.ctx.thinkingLevel,
      tools: ["read", "grep", "find", "ls"],
      onText: (text) => showProgress(options.ctx, `${options.progressName} · Planning`, text),
      onActivity: (text) => showProgress(options.ctx, `${options.progressName} · Planning`, text),
    });
    if (result.code === 0) {
      try {
        markdown = parseGeneratedPlan(result.assistantText);
        break;
      } catch (error) {
        if (String(error).includes("planning blocked:")) throw error;
        retryContext = `${errorText(error)}\n${diagnostic(result)}`;
      }
    } else {
      retryContext = diagnostic(result);
    }
  }
  if (!markdown) throw new Error(`planning failed after retry\n${retryContext ?? "unknown planning failure"}`);
  const planPath = await saveGeneratedPlan(options.root, markdown);
  options.ctx.ui.notify(`Plan created: ${relative(options.root, planPath)}`, "info");
  return {
    root: options.root,
    planPath,
    model: options.model,
    ...autonomousPlanReport(markdown),
  };
}

export async function createAutonomousPlan(ctx: ExtensionCommandContext, request: string, model?: string): Promise<AutonomousPlanResult> {
  if (!request.trim()) throw new Error("task is required: /ralphex-plan --auto <task>");
  const root = await repositoryRoot(ctx.cwd);
  const config = await resolveModelConfig({
    root,
    projectTrusted: ctx.isProjectTrusted(),
    overrides: model ? { planModel: model } : undefined,
  });
  if (!config.planModel) throw new Error("planning model is required; run /ralphex-models first or pass --model");
  validateConfiguredModel(ctx, config.planModel, "Planning");
  return generateAutonomousPlan({ ctx, root, request: request.trim(), model: config.planModel, progressName: "Ralphex plan" });
}

async function runRalphexAuto(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
  const parsed = parseAutoArgs(rawArgs);
  if (!parsed.request) throw new Error("task is required: /ralphex-auto <task>");
  const root = await repositoryRoot(ctx.cwd);
  const config = await resolveModelConfig({
    root,
    projectTrusted: ctx.isProjectTrusted(),
    overrides: { planModel: parsed.planModel, execModel: parsed.execModel },
  });
  if (!config.planModel || !config.execModel) throw new Error("planning and execution models are required; run /ralphex-models first");
  validateConfiguredModel(ctx, config.planModel, "Planning");
  validateConfiguredModel(ctx, config.execModel, "Execution");

  let planPath: string | undefined;
  let phase = "planning";
  try {
    const planned = await generateAutonomousPlan({
      ctx,
      root,
      request: parsed.request,
      model: config.planModel,
      progressName: "Ralphex auto",
    });
    planPath = planned.planPath;
    phase = "execution";
    const execution = await executePlan(pi, ctx, `--auto --model "${config.execModel}" "${relative(root, planPath)}"`, {
      announceCompletion: false,
      progressName: "Ralphex auto",
    });
    const finalPlan = await readPlan(planPath);
    const notes = executionNotes(finalPlan);
    const results = execution.summaries.map((summary) => `- ${summary.result}`);
    const planningSideEffects = notes.flatMap((note) => {
      const value = note.match(/(?:^|;\s*)Side effects:\s*(.+)$/i)?.[1]?.trim();
      return value && !/^(none|нет|не выявлены)$/i.test(value) ? [value] : [];
    });
    const sideEffects = [...planningSideEffects, ...execution.summaries.flatMap((summary) => summary.sideEffects)];
    const noteLimitations = notes.filter((note) => /^(Assumption|Limitation|Допущение|Ограничение):/i.test(note));
    const limitations = [...noteLimitations, ...execution.summaries.flatMap((summary) => summary.limitations)];
    pi.sendMessage({
      customType: "ralphex",
      content: [
        "✓ Ralphex auto completed",
        "",
        `Plan model: ${config.planModel}`,
        `Exec model: ${config.execModel}`,
        `Plan: ${relative(root, planPath)}`,
        `Tasks completed: ${execution.tasksCompleted}`,
        `Task commits: ${execution.tasksCompleted}`,
        "Validation: passed",
        "",
        "Что сделано:",
        ...(results.length ? results : ["- Выполнены все задачи плана"]),
        "",
        "Автономные решения:",
        ...(notes.length ? notes.map((note) => `- ${note}`) : ["- Материальных автономных решений не зафиксировано"]),
        "",
        "Побочные эффекты:",
        ...(sideEffects.length ? sideEffects.map((item) => `- ${item}`) : ["- Не выявлены"]),
        "",
        "Допущения и ограничения:",
        ...(limitations.length ? limitations.map((item) => `- ${item}`) : ["- Не выявлены"]),
      ].join("\n"),
      display: true,
    });
  } catch (error) {
    const resume = planPath ? `\nResume:\n/ralphex-exec --auto --model ${config.execModel} ${relative(root, planPath)}` : "";
    throw new Error(`✗ Ralphex auto blocked\n\nPhase: ${phase}\nReason: ${errorText(error)}${resume}`);
  }
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

type ModelConfigScope = "global" | "project";

function parseModelConfigArgs(args: string): { scope?: ModelConfigScope; planModel?: string; execModel?: string } {
  const tokens = commandTokens(args);
  let scope: ModelConfigScope | undefined;
  let planModel: string | undefined;
  let execModel: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--global" || token === "--project") {
      const next = token.slice(2) as ModelConfigScope;
      if (scope && scope !== next) throw new Error("choose either --global or --project");
      scope = next;
      continue;
    }
    if (token === "--plan" || token === "--exec") {
      const value = tokens[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires provider/model`);
      if (token === "--plan") planModel = value;
      else execModel = value;
      continue;
    }
    if (token.startsWith("--plan=")) {
      planModel = token.slice("--plan=".length);
      if (!planModel) throw new Error("--plan requires provider/model");
      continue;
    }
    if (token.startsWith("--exec=")) {
      execModel = token.slice("--exec=".length);
      if (!execModel) throw new Error("--exec requires provider/model");
      continue;
    }
    throw new Error(`unknown /ralphex-models argument: ${token}`);
  }
  return { scope, planModel, execModel };
}

const MODEL_PICKER_VISIBLE_ROWS = 10;

async function showModelPicker(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    const labels = items.map((item) => `${item.label}${item.description ? ` — ${item.description}` : ""}`);
    const selected = await ctx.ui.select(title, labels);
    return selected ? items[labels.indexOf(selected)]?.value : undefined;
  }

  const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
    const container = new Container();
    const searchInput = new Input();
    const listContainer = new Container();
    let selectList: SelectList;

    const buildList = (visibleItems: SelectItem[]) => {
      const list = new SelectList(
        visibleItems,
        Math.min(Math.max(visibleItems.length, 1), MODEL_PICKER_VISIBLE_ROWS),
        getSelectListTheme(),
      );
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      listContainer.clear();
      listContainer.addChild(list);
      selectList = list;
    };

    const applyFilter = () => {
      const query = searchInput.getValue();
      buildList(query ? fuzzyFilter(items, query, (item) => `${item.label} ${item.description ?? ""}`) : items);
    };

    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(searchInput);
    container.addChild(new Spacer(1));
    container.addChild(listContainer);
    container.addChild(new Text(theme.fg("dim", "type to filter • ↑↓ navigate • enter select • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    buildList(items);
    searchInput.onSubmit = () => selectList.handleInput("\r");

    const isNavigationKey = (data: string, bindings: KeybindingsManager) =>
      bindings.matches(data, "tui.select.up") ||
      bindings.matches(data, "tui.select.down") ||
      bindings.matches(data, "tui.select.pageUp") ||
      bindings.matches(data, "tui.select.pageDown") ||
      bindings.matches(data, "tui.select.confirm") ||
      bindings.matches(data, "tui.select.cancel");

    return {
      get focused() { return searchInput.focused; },
      set focused(value: boolean) { searchInput.focused = value; },
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (isNavigationKey(data, keybindings)) selectList.handleInput(data);
        else {
          searchInput.handleInput(data);
          applyFilter();
        }
        tui.requestRender();
      },
    };
  });

  return result ?? undefined;
}

async function selectConfiguredModel(ctx: ExtensionCommandContext, title: string): Promise<string | undefined> {
  const models = ctx.modelRegistry.getAvailable()
    .filter((model) => ctx.modelRegistry.getProviderAuthStatus(model.provider).configured)
    .sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`));
  if (!models.length) throw new Error("no authenticated models are available");
  return showModelPicker(ctx, title, models.map((model) => ({
    value: `${model.provider}/${model.id}`,
    label: `${model.provider}/${model.id}`,
    description: model.name,
  })));
}

async function configureModels(ctx: ExtensionCommandContext, args: string): Promise<void> {
  await ctx.waitForIdle();
  const parsed = parseModelConfigArgs(args);
  const root = await repositoryRoot(ctx.cwd);
  let scope = parsed.scope;
  if (!scope) {
    const selected = await ctx.ui.select("Save Ralphex models for:", ["Global", "Current project"]);
    if (!selected) return;
    scope = selected === "Global" ? "global" : "project";
  }
  if (scope === "project" && !ctx.isProjectTrusted()) throw new Error("project model config requires a trusted project");

  const paths = modelConfigPaths(root);
  const path = paths[scope];
  const current = await readModelConfig(path);
  const explicitlySet = Boolean(parsed.planModel || parsed.execModel);
  let planModel = parsed.planModel;
  let execModel = parsed.execModel;
  if (!explicitlySet) {
    planModel = await selectConfiguredModel(ctx, "Select the Ralphex planning model");
    if (!planModel) return;
    execModel = await selectConfiguredModel(ctx, "Select the Ralphex execution model");
    if (!execModel) return;
  }
  if (planModel) validateConfiguredModel(ctx, planModel, "Planning");
  if (execModel) validateConfiguredModel(ctx, execModel, "Execution");

  const updated: RalphexModelConfig = {
    ...current,
    ...(planModel ? { planModel } : {}),
    ...(execModel ? { execModel } : {}),
  };
  await writeModelConfig(path, updated, scope === "global");
  const effective = await resolveModelConfig({ root, projectTrusted: ctx.isProjectTrusted() });
  ctx.ui.notify(
    `Ralphex ${scope} models saved\nPlan: ${effective.planModel ?? "not configured"}\nExec: ${effective.execModel ?? "not configured"}`,
    "info",
  );
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
  pi.registerCommand("ralphex-auto", {
    description: "Autonomously create and execute a plan without Claude review; supports separate plan and exec models",
    handler: async (args, ctx) => commandBoundary(pi, ctx, "Ralphex auto", () => runRalphexAuto(pi, ctx, args)),
  });

  pi.registerCommand("ralphex-models", {
    description: "Configure global or project planning and execution models for /ralphex-auto",
    handler: async (args, ctx) => commandBoundary(pi, ctx, "Ralphex models", () => configureModels(ctx, args)),
  });

  pi.registerCommand("ralphex-exec", {
    description: "Execute plan tasks in fresh Pi contexts; supports --auto and --model provider/model",
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

export {
  commitAndPushReleaseChanges,
  commitCompletedPlanMove,
  executePlan,
  formatTaskProgress,
  moveCompletedPlan,
  parseAutoArgs,
  parseCommandArgs,
  parseGeneratedPlan,
  parseModelConfigArgs,
  parsePlanCommandArgs,
  parseTaskProgress,
  parseTaskSummary,
  reviewPlan,
  resolvePlan,
  resolveRequestedPlan,
  runLoop,
  saveGeneratedPlan,
  autonomousPlanReport,
  validateGeneratedPlan,
};
