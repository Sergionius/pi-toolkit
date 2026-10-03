import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename } from "node:path";

const MAX_DIFF_BYTES = 750 * 1024;
const PI_TIMEOUT_MS = 120_000;
const CONVENTIONAL_COMMIT_RE = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^\r\n)]+\))?!?: .+/;

type ExecResult = { stdout: string; stderr: string; code: number | null; killed?: boolean };
type Exec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;

export type CommitResult = {
  committed: boolean;
  hash?: string;
  message?: string;
  reason?: "clean";
};

function commandText(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

async function requireSuccess(exec: Exec, cwd: string, command: string, args: string[]): Promise<ExecResult> {
  const result = await exec(command, args, { cwd });
  if (result.code !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${commandText(command, args)} failed${output ? `:\n${output}` : ""}`);
  }
  return result;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function requireSafeRepository(exec: Exec, cwd: string): Promise<string> {
  await requireSuccess(exec, cwd, "git", ["rev-parse", "--is-inside-work-tree"]);
  const root = (await requireSuccess(exec, cwd, "git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const branch = (await requireSuccess(exec, root, "git", ["branch", "--show-current"])).stdout.trim();
  if (!branch) throw new Error("Cannot commit from a detached HEAD");

  const gitDir = (await requireSuccess(exec, root, "git", ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  const markers = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
  ] as const;
  const active: string[] = [];
  for (const [marker, operation] of markers) {
    if (await pathExists(`${gitDir}/${marker}`)) active.push(operation);
  }
  const unique = [...new Set(active)];
  if (unique.length) throw new Error(`Finish the active Git operation first: ${unique.join(", ")}`);
  return root;
}

export function cleanCommitMessage(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```") && text.endsWith("```")) {
    const lines = text.split("\n");
    if (lines.length >= 3) text = lines.slice(1, -1).join("\n").trim();
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error("The commit model must return exactly one non-empty commit message line");

  const message = lines[0].replace(/^[`"']+|[`"']+$/g, "").trim();
  if (!CONVENTIONAL_COMMIT_RE.test(message)) {
    throw new Error(`The commit model returned an invalid Conventional Commit message: ${JSON.stringify(message)}`);
  }
  if (message.length > 120) throw new Error("The commit model returned a commit message longer than 120 characters");
  return message;
}

export function getCommitModel(env: NodeJS.ProcessEnv = process.env): string {
  const model = env.PI_COMMIT_MODEL?.trim();
  if (!model) throw new Error("PI_COMMIT_MODEL is required for /commit");
  return model;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  const isBunVirtualScript = script?.startsWith("/$bunfs/root/");
  if (script && !isBunVirtualScript && existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }

  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

export async function generateCommitMessage(diff: string): Promise<string> {
  const prompt = [
    "Write a commit message for the staged Git diff supplied on stdin.",
    "Return exactly one line in English using Conventional Commits format, for example: feat(scope): concise description.",
    "Describe the main purpose of the complete changeset. Do not use Markdown, quotes, a body, or a trailing period.",
  ].join(" ");
  const args = [
    "--print",
    "--model", getCommitModel(),
    "--thinking", "low",
    "--no-tools",
    "--no-session",
    "--no-context-files",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    prompt,
  ];
  const invocation = getPiInvocation(args);
  const env = { ...process.env, PI_SKIP_VERSION_CHECK: "1" };
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;

  const output = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), PI_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start nested Pi: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(diff);
  });

  if (output.code !== 0) {
    const details = [output.stderr, output.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`Nested Pi failed to generate a commit message${details ? `:\n${details}` : ""}`);
  }
  return cleanCommitMessage(output.stdout);
}

export async function commitAllChanges(
  cwd: string,
  exec: Exec,
  makeMessage: (diff: string) => Promise<string> = generateCommitMessage,
  previewUntracked: (paths: string[]) => void = () => {},
): Promise<CommitResult> {
  const root = await requireSafeRepository(exec, cwd);
  const status = await requireSuccess(exec, root, "git", ["status", "--porcelain"]);
  if (!status.stdout.trim()) return { committed: false, reason: "clean" };

  const untracked = (await requireSuccess(exec, root, "git", ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
  if (untracked.length) previewUntracked(untracked);
  await requireSuccess(exec, root, "git", ["add", "."]);
  const diff = (await requireSuccess(exec, root, "git", [
    "diff", "--cached", "--no-ext-diff", "--stat", "--patch", "--find-renames",
  ])).stdout;
  if (!diff.trim()) throw new Error("Git reported changes but produced an empty staged diff");
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
    throw new Error(`Staged diff is too large for /commit (${Math.ceil(Buffer.byteLength(diff, "utf8") / 1024)} KiB; limit is ${MAX_DIFF_BYTES / 1024} KiB)`);
  }

  const message = await makeMessage(diff);
  await requireSuccess(exec, root, "git", ["commit", "-m", message]);
  const hash = (await requireSuccess(exec, root, "git", ["rev-parse", "--short", "HEAD"])).stdout.trim();
  return { committed: true, hash, message };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("commit", {
    description: "Stage all repository changes and commit with a message generated by PI_COMMIT_MODEL (no push)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      ctx.ui.setStatus("pi-toolkit-commit", "Generating commit…");
      try {
        const result = await commitAllChanges(ctx.cwd, (command, args, options) => pi.exec(command, args, options), generateCommitMessage, (paths) => {
          const shown = paths.slice(0, 30).map((path) => `- ${JSON.stringify(path)}`).join("\n");
          ctx.ui.notify(`/commit will include ${paths.length} untracked file(s):\n${shown}${paths.length > 30 ? `\n… and ${paths.length - 30} more` : ""}`, "warning");
        });
        if (!result.committed) {
          ctx.ui.notify("Working tree is clean; nothing to commit", "info");
          return;
        }
        ctx.ui.notify(`Committed ${result.hash}: ${result.message}`, "info");
      } catch (error) {
        ctx.ui.notify(`/commit failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        ctx.ui.setStatus("pi-toolkit-commit", undefined);
      }
    },
  });
}
