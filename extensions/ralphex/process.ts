import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

export type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
  assistantText: string;
};

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
}): Promise<ProcessResult> {
  const args = [
    "--mode", "json", "-p", "--no-session",
    "--no-extensions", "--no-skills", "--no-prompt-templates",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.tools) args.push("--tools", options.tools.join(","));
  args.push(options.prompt);

  const invocation = piInvocation(args);
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let assistantText = "";

    const consume = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "message_end") {
          const text = messageText(event.message);
          if (text) {
            assistantText = text;
            options.onText?.(text);
          }
        }
        if (event.type === "tool_execution_start") {
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

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
      resolve({ code: 1, stdout, stderr, assistantText });
    });
    child.on("close", (code) => {
      if (buffer.trim()) consume(buffer);
      resolve({ code: code ?? 1, stdout, stderr, assistantText });
    });
  });
}

export async function runCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, assistantText: stdout.trim() });
    };
    const timer = options.timeoutMs ? setTimeout(() => {
      stderr += `process timed out after ${options.timeoutMs}ms\n`;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, options.timeoutMs) : undefined;

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { stderr += `${error.message}\n`; finish(1); });
    child.on("close", (code) => finish(code ?? 1));
    child.stdin.end(options.stdin ?? "");
  });
}
