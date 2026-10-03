import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { processTree } from "../lib/process-tree";
import { createWorkerLog } from "./worker-logs";
import { redactDiagnostic } from "./diagnostics";
export { redactDiagnostic } from "./diagnostics";

export type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
  assistantText: string;
  workerError?: string;
  logPath?: string;
};

export function taskFailures(result: ProcessResult, unchecked: number | undefined, before: string, after: string, dirty: string[]): string[] {
  return [
    unchecked === undefined ? "task section missing" : unchecked > 0 ? `unclosed checkboxes: ${unchecked}` : "",
    before === after ? "no new commit" : "",
    dirty.length ? `dirty tree: ${dirty.join(", ")}` : "",
    result.workerError ? `worker error: ${result.workerError}` : "",
    result.code !== 0 ? `worker exit code: ${result.code}` : "",
  ].filter(Boolean);
}

export function workerDiagnostic(result: ProcessResult, failures: string[] = []): string {
  return redactDiagnostic([
    ...failures.map((reason) => `- ${reason}`),
    result.workerError && !failures.includes(`worker error: ${result.workerError}`) && `worker error: ${result.workerError}`,
    `exit code: ${result.code}`,
    result.logPath && `diagnostic log: ${result.logPath}`,
    result.assistantText ? `assistant: ${result.assistantText.slice(-3000)}` : "empty assistant response",
    result.stderr.slice(-2000),
  ].filter(Boolean).join("\n"));
}

function piInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const bunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !bunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function messageText(message: any): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.map((part: any) => part?.type === "text" ? String(part.text ?? "") : "").filter(Boolean).join("\n");
}

export async function runPiWorker(options: {
  cwd: string;
  prompt: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  onText?: (text: string) => void;
  onActivity?: (text: string) => void;
  idleTimeoutMs?: number;
  toolTimeoutMs?: number;
  killGraceMs?: number;
  invocation?: { command: string; args: string[] };
}): Promise<ProcessResult> {
  const args = [
    "--mode", "json", "-p", "--no-session",
    "--no-extensions", "--no-skills", "--no-prompt-templates",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.tools) args.push("--tools", options.tools.join(","));
  args.push(options.prompt);

  const idleMs = options.idleTimeoutMs ?? Number(process.env.RALPHEX_WORKER_IDLE_TIMEOUT_MS ?? 600000);
  const toolMs = options.toolTimeoutMs ?? Number(process.env.RALPHEX_WORKER_TOOL_TIMEOUT_MS ?? 0);
  for (const value of [idleMs, toolMs]) if (!Number.isFinite(value) || value < 0) throw new Error("Worker timeouts must be nonnegative milliseconds (0 disables)");
  const log = createWorkerLog();
  const logPath = log.path;
  const invocation = options.invocation ?? piInvocation(args);
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let assistantText = "";
    let workerError: string | undefined;
    let terminalError: string | undefined;
    let lastActivity = Date.now();
    const tools = new Map<string, number>();
    const tree = processTree(child, options.killGraceMs, (message) => { stderr += `${message}\n`; });
    const timer = setInterval(() => {
      if (terminalError) return;
      const now = Date.now();
      const toolExpired = toolMs > 0 && [...tools.values()].some((start) => now - start >= toolMs);
      if (toolExpired || (tools.size === 0 && idleMs > 0 && now - lastActivity >= idleMs)) {
        terminalError = `watchdog: ${toolExpired ? "tool execution" : "worker inactivity"} timeout (${toolExpired ? toolMs : idleMs}ms)`;
        tree.stop();
      }
    }, Math.max(10, Math.min(1000, idleMs || 1000, toolMs || 1000)));
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      tree.dispose();
      const result = { code, stdout, stderr, assistantText, workerError: terminalError ?? workerError, logPath };
      try {
        log.finish({ ...result, cwd: options.cwd, model: options.model });
      } catch (error) {
        result.workerError = `${result.workerError ?? ""}\nCannot save diagnostic log: ${String(error)}`;
      }
      resolve(result);
    };

    const consume = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        const acceptMessage = (message: any) => {
          if (message?.role !== "assistant") return;
          workerError = message.errorMessage || (["error", "aborted"].includes(message.stopReason) ? `assistant stopReason=${message.stopReason}` : undefined);
          assistantText = messageText(message);
          if (assistantText) options.onText?.(assistantText);
        };
        if (event.type === "message_end") acceptMessage(event.message);
        if (event.type === "agent_end") {
          const last = event.messages?.filter((message: any) => message.role === "assistant").at(-1);
          if (last) acceptMessage(last);
        }
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "error") {
          const update = event.assistantMessageEvent;
          workerError = update.error?.errorMessage || update.reason || "provider stream error";
        }
        if (event.type === "auto_retry_end" && !event.success) workerError = event.finalError || "automatic retry exhausted";
        if (event.type === "compaction_end" && (event.errorMessage || event.aborted)) workerError = event.errorMessage || "compaction aborted";
        if (event.type === "tool_execution_end") tools.delete(String(event.toolCallId ?? "tool"));
        if (event.type === "tool_execution_start") {
          tools.set(String(event.toolCallId ?? "tool"), Date.now());
          const name = String(event.toolName ?? "tool");
          const input = event.args ?? event.input ?? {};
          const detail = name === "bash"
            ? String(input.command ?? "")
            : String(input.path ?? input.file_path ?? "");
          options.onActivity?.(detail ? `${name}: ${detail}` : name);
        }
      } catch {
        // Keep malformed/non-event output in stdout for diagnostics.
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      lastActivity = Date.now();
      const text = chunk.toString();
      stdout += text;
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    });
    child.stderr.on("data", (chunk) => { lastActivity = Date.now(); stderr += chunk.toString(); });
    child.on("error", (error) => {
      terminalError = error.message;
      stderr += `${error.message}\n`;
      finish(1);
    });
    child.on("close", (code) => {
      if (buffer.trim()) consume(buffer);
      finish(code ?? 1);
    });
  });
}

export async function runCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const tree = processTree(child, options.killGraceMs, (message) => { stderr += `${message}\n`; });
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      tree.dispose();
      resolve({ code: timedOut ? 124 : code, stdout, stderr, assistantText: stdout.trim() });
    };
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      stderr += `process timed out after ${options.timeoutMs}ms\n`;
      tree.stop();
    }, options.timeoutMs) : undefined;

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { stderr += `${error.message}\n`; finish(1); });
    child.on("close", (code) => finish(code ?? 1));
    if (options.stdin !== undefined) {
      child.stdin.on("error", (error) => { stderr += `${error.message}\n`; });
      child.stdin.end(options.stdin);
    }
  });
}
